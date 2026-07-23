defmodule KaoiroServer.SessionResets do
  @moduledoc """
  Session-reset pending-lock SSOT (ADR-0036 F6/F7, phase-17 17-4/17-5).
  Owns the per-agent lock that blocks a second `/new`・`/clear` from
  racing a first, blocks new instructions / model / effort /
  permission_mode switches while a reset is in flight, and gates a reset
  against a just-dispatched instruction whose `thinking` state_change
  has not yet reached AgentStates.

  ## Two-phase completion (ADR-0036 F2 "接続確認")

  The lock has a `phase` — `:spawning` initially, `:awaiting_connect`
  after the runner reports `ok=true`, cleared on connect / failure /
  timeout. This exists because `runner.ok=true` only means "the fresh
  child process spawned"; if the wrapper dies before its socket join
  we would broadcast `session_reset_completed` for an agent that no
  longer exists. The completion is gated on the fresh wrapper's actual
  channel join (`WrapperChannel.after_join`), not on the runner report.

  * `check_and_acquire/5` → `:spawning`. Server broadcasts
    `session_reset_started`, runner is told to fresh-relaunch.
  * `mark_spawn_ok/3` → `:awaiting_connect`. Runner has confirmed the
    fresh child spawned; we still wait for the wrapper to join.
  * `confirm_connection/2` → completed. Fresh wrapper joined; detach the
    pointer and broadcast `session_reset_completed`.
  * `resolve_failure/3` (formerly `resolve/6` on the failure branch) or
    the 60 s timeout → `session_reset_failed`, no detach.

  Runners still call `resolve/6` — the existing wire — and this module
  routes `ok=true` into `mark_spawn_ok` internally so the runner protocol
  does not need a second RPC.

  ## Two concurrency windows

  * **TOCTOU between check and acquire.** `check_and_acquire/5` runs the
    lock-availability check, the KaoiroState precondition
    (`idle`/`waiting_input`), the dispatch-cooldown check, and the lock
    write in ONE `handle_call` — no separate `pending?` → `acquire` pair,
    so a concurrent request cannot slip between the two.

  * **Async state-report lag between wrapper dispatch and its state_change
    envelope.** After the channel dispatches an instruction / model
    switch / permission-mode switch, the wrapper takes a moment to emit
    the resulting `thinking` (or equivalent non-idle) state_change and
    have it land in `AgentStates`. During that window a naive reset
    would see a stale `idle` and kill a turn that just started running.
    `guard_instruction/1` stamps `last_dispatch[agent_id]` in the same
    handle_call that gates the guard, and `check_and_acquire/5` refuses
    to acquire while a dispatch is within `#{2_000}ms` — the cooldown
    expiry gives the wrapper time to report the real state, so a retry
    outside the window judges against the visible truth.

  The pending lock also carries `previous_session_id` (the AgentStates
  snapshot's session_id at acquire time) so `session_reset_completed`
  broadcasts can name the session that was left behind, even after
  `SessionPointers.detach_session/1` nils the pointer's session_id on
  success. A 60-second timeout self-broadcasts `session_reset_failed`
  and clears the lock; no `SessionPointers.detach_session/1` fires on
  timeout — the old session may still be live and the operator can retry.
  The timeout covers the SPAWN and AWAITING_CONNECT phases together, so
  a runner that spawns quickly but whose wrapper never joins still
  eventually fails loud.

  Broadcasts leave via `KaoiroServerWeb.Endpoint.broadcast/3` on the
  `agents:lobby` topic. That is a new role among the DETS-backed stores
  (`SessionPointers` / `PermissionModes` never broadcast), but this
  module owns the reset LIFECYCLE, not just its persisted key/value —
  the fire is inseparable from the state transition.

  This is an in-memory store only. There is nothing to persist across a
  restart: a wrapper reset that was in flight when the server died no
  longer has a live counterpart, so the operator sees the disconnect and
  retries after reconnect.
  """

  use GenServer

  require Logger

  alias KaoiroServer.SessionPointers

  # 60 s upper bound on a reset (fresh relaunch + optional rollback).
  # ADR-0036 F7 leaves the number unspecified; anything shorter risks
  # false timeouts on a slow spawn, anything longer keeps the lock stale
  # after a crashed runner and blocks the operator's next attempt.
  @timeout_ms 60_000

  # Grace window after any instruction / model / effort / permission_mode
  # dispatch during which a reset is refused with `:agent_busy`, even if
  # AgentStates still says `idle`. Covers the async state-report lag
  # documented above. 2 s is comfortably above a healthy wrapper's
  # dispatch→thinking round trip and short enough that a retry feels
  # responsive.
  @dispatch_cooldown_ms 2_000

  # KaoiroState values that permit a reset. Matches ADR-0036 F6: `error`
  # is deliberately NOT included in MVP.
  @ready_states ["idle", "waiting_input"]

  @doc """
  Starts the store. `:name` overrides the registered name (tests run
  isolated instances). No DETS backing — see moduledoc.
  """
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, %{}, name: name)
  end

  @doc """
  Atomically checks the lock, the KaoiroState precondition, and the
  dispatch-cooldown window, then acquires the reset lock for the agent.
  Returns `{:ok, request_id, previous_session_id}` on success and a
  closed-vocabulary error otherwise.

  `state` is the agent's current KaoiroState string as read from the
  AgentStates snapshot; passing it as an argument keeps the check
  atomic within this `handle_call` rather than requiring a call chain
  through another GenServer. `previous_session_id` is the snapshot's
  latest `session_id` (or `nil` when the wrapper has not reported one
  yet); it is echoed back and later used in the completion broadcast.
  """
  def check_and_acquire(agent_id, mode, state, previous_session_id, server \\ __MODULE__)
      when mode in ["new", "clear"] and is_binary(agent_id) do
    GenServer.call(
      server,
      {:check_and_acquire, agent_id, mode, state, previous_session_id}
    )
  end

  @doc """
  Gate for instruction / set_model / set_effort / set_permission_mode
  handlers: refuses the operation while a reset is pending, and stamps
  `last_dispatch[agent_id]` on success so a reset within
  `#{@dispatch_cooldown_ms}ms` is refused even if AgentStates has not
  yet seen the resulting thinking state.
  """
  def guard_instruction(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:guard_instruction, agent_id})
  end

  @doc """
  Records the runner's `session_reset_result`.

  On success (`ok=true`) transitions the lock to `:awaiting_connect`
  and stashes the runner-reported `to_session_id` (which is `nil` for
  Codex's lazy thread-ID采番 and typically set for Claude). The
  `session_reset_completed` broadcast is NOT fired here — see
  `confirm_connection/2`. This split enforces ADR-0036 F2: completion
  is gated on the fresh wrapper's actual channel join, not on the
  runner's spawn-succeeded report, because a wrapper that dies between
  spawn and join would otherwise leave the operator staring at a
  "completed" session that no longer exists.

  On failure (`ok=false`) fires `session_reset_failed` immediately and
  releases the lock; the pointer is left untouched (the runner's
  rollback branch may have recovered the old session).

  Stale results (unknown agent, mismatched request_id after a prior
  timeout) are silently discarded per ADR-0036 F7's stale-completion
  rule — no broadcast, no side effect.

  Asynchronous cast: the runner needs no reply and this keeps the
  runner_channel path non-blocking.
  """
  def resolve(agent_id, request_id, ok, reason, to_session_id, server \\ __MODULE__) do
    GenServer.cast(
      server,
      {:resolve, agent_id, request_id, ok, reason, to_session_id}
    )
  end

  @doc """
  Fires the pending `session_reset_completed` broadcast for the fresh
  wrapper that just joined its `wrapper:<agent_id>` channel, detaches
  the pointer, releases the lock.

  Called from `WrapperChannel.after_join` (or the first envelope's
  handler when join alone is not enough) with the joining agent_id and
  the session_id the wrapper reported so far (`nil` when unknown). No-op
  when no lock is held, when the lock is not yet in `:awaiting_connect`
  (the runner has not reported `ok=true` — this is a normal restart, not
  a reset), or when the mismatched request_id indicates a stale join.

  Sync so tests can assert the sequence of side effects deterministically;
  the caller (wrapper_channel) already runs in its own process.
  """
  def confirm_connection(agent_id, joined_session_id \\ nil, server \\ __MODULE__) do
    GenServer.call(server, {:confirm_connection, agent_id, joined_session_id})
  end

  @doc "True when a reset lock is currently held for the agent."
  def pending?(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:pending?, agent_id})
  end

  @doc """
  Purges the agent's lock and dispatch-cooldown record. Called from the
  operator delete path so a subsequent respawn under the same agent_id
  does not inherit a stale cooldown or a dangling timer.
  """
  def delete(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:delete, agent_id})
  end

  @impl true
  def init(_arg), do: {:ok, %{pending: %{}, last_dispatch: %{}}}

  @impl true
  def handle_call(
        {:check_and_acquire, agent_id, mode, state, prev_sid},
        _from,
        s
      ) do
    now = monotonic_ms()

    # Guard the cooldown check with an explicit "stamp exists" branch:
    # `System.monotonic_time/1` is unsigned only in wall-clock terms and
    # a bare `now - 0` cannot be relied on to exceed `@dispatch_cooldown_ms`.
    within_cooldown? =
      case Map.get(s.last_dispatch, agent_id) do
        nil -> false
        stamped_at -> now - stamped_at < @dispatch_cooldown_ms
      end

    cond do
      Map.has_key?(s.pending, agent_id) ->
        {:reply, {:error, :session_reset_pending}, s}

      state not in @ready_states ->
        {:reply, {:error, :agent_busy}, s}

      within_cooldown? ->
        # Async state-report lag protection: a recent instruction may
        # already be executing on the wrapper even though AgentStates
        # still shows idle. Refuse now, let the cooldown expire.
        {:reply, {:error, :agent_busy}, s}

      true ->
        request_id = generate_request_id()

        timer_ref =
          Process.send_after(self(), {:timeout, agent_id, request_id}, @timeout_ms)

        lock = %{
          mode: mode,
          request_id: request_id,
          previous_session_id: prev_sid,
          acquired_at: now,
          timer_ref: timer_ref,
          # Two-phase completion (ADR-0036 F2): :spawning while waiting on
          # the runner, :awaiting_connect after runner ok=true. Completion
          # is gated on the fresh wrapper's channel join at
          # :awaiting_connect — see confirm_connection/2.
          phase: :spawning,
          # to_session_id runner reported (nil for Codex lazy采番); rolls
          # into the completed broadcast when confirm_connection fires.
          to_session_id: nil
        }

        {:reply, {:ok, request_id, prev_sid}, %{s | pending: Map.put(s.pending, agent_id, lock)}}
    end
  end

  def handle_call({:guard_instruction, agent_id}, _from, s) do
    if Map.has_key?(s.pending, agent_id) do
      {:reply, {:error, :session_reset_pending}, s}
    else
      {:reply, :ok, %{s | last_dispatch: Map.put(s.last_dispatch, agent_id, monotonic_ms())}}
    end
  end

  def handle_call({:pending?, agent_id}, _from, s) do
    {:reply, Map.has_key?(s.pending, agent_id), s}
  end

  def handle_call({:delete, agent_id}, _from, s) do
    case Map.get(s.pending, agent_id) do
      %{timer_ref: ref} -> _ = Process.cancel_timer(ref)
      _ -> :ok
    end

    {:reply, :ok,
     %{
       s
       | pending: Map.delete(s.pending, agent_id),
         last_dispatch: Map.delete(s.last_dispatch, agent_id)
     }}
  end

  def handle_call({:confirm_connection, agent_id, joined_session_id}, _from, s) do
    case Map.get(s.pending, agent_id) do
      %{phase: :awaiting_connect} = lock ->
        _ = Process.cancel_timer(lock.timer_ref)

        # The lock's to_session_id came from the runner (Codex will be nil;
        # Claude may already have it). If the joining wrapper reported a
        # non-nil session_id itself (only Claude does this via init), prefer
        # that; it is the fresher source and matches what the wrapper will
        # broadcast in its first envelope.
        effective_to_sid =
          case joined_session_id do
            binary when is_binary(binary) -> binary
            _ -> lock.to_session_id
          end

        # 実機検収 2 (2026-07-23 マスター指示): a /new or /clear reaching
        # confirm_connection is the ONE authoritative session-transition
        # event that must advance A's IA visibility boundary
        # (`ClearWatermarks`). Doing it here — not in the wrapper
        # `handle_info(:after_join)` — keeps the "boundary moves only
        # on real transitions" invariant: a normal reconnect / dogfood
        # restart / initial spawn all reach after_join but skip this
        # branch (their pending lock is nil), so the boundary stays put
        # and pre-restart / initial IA remain visible.
        #
        # ふじ 検収 2 fix-round M3 (2026-07-23): `advance_transition/3`
        # is transition-idempotent by `sid_opt` — a crash between this
        # call and SessionPointers.detach_session (below) followed by
        # a same-target reset retry no longer double-advances. Codex
        # lazy 采番 passes `nil` here; `wrapper_channel` calls
        # `ClearWatermarks.adopt_sid/2` on the first envelope that
        # carries a real session_id.
        {:ok, {_order, boundary_display, _sid}} =
          KaoiroServer.ClearWatermarks.advance_transition(agent_id, effective_to_sid)

        # ふじ 検収 2 fix-round M1 (2026-07-23): live clients must learn
        # about the advance so their in-memory logs projection re-filters
        # IA older than `boundary_display` — otherwise the old IA
        # stays visible until reload and then suddenly disappears
        # (breaks #109 AC). Additive wire; old clients ignore it.
        KaoiroServerWeb.Endpoint.broadcast(
          "agents:lobby",
          "session_boundary_advanced",
          %{"agent_id" => agent_id, "boundary" => boundary_display}
        )

        # phase-17 17-7 (must-3): write the boundary marker into
        # AgentStates AND broadcast it via the ordinary envelope path so
        # every currently-connected client (operator: full payload,
        # viewer: mode/state only via handle_out sanitize) sees it. The
        # `clear` mode also fires `history_reset` FIRST so client
        # transcripts drop before the marker arrives — reversing the
        # order would erase the marker along with the log.
        marker = build_boundary_envelope(agent_id, lock, effective_to_sid)

        case lock.mode do
          "clear" ->
            :ok = KaoiroServer.InterAgentHistory.delete_agent(agent_id)

            KaoiroServerWeb.Endpoint.broadcast(
              "agents:lobby",
              "history_reset",
              %{"agent_id" => agent_id, "preserve_inter_agent" => false}
            )

            _ = KaoiroServer.AgentStates.clear_history_with_boundary(agent_id, marker)

          _ ->
            _ = KaoiroServer.AgentStates.append_boundary(agent_id, marker)
        end

        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", marker)

        detach_session_safely(agent_id)

        broadcast_completed(agent_id, lock, effective_to_sid)

        {:reply, :ok, %{s | pending: Map.delete(s.pending, agent_id)}}

      _ ->
        # No pending, or still in :spawning (the runner hasn't reported
        # spawn success yet — so this join is either a normal restart or
        # the fresh wrapper joining before we heard from the runner; the
        # latter is impossible under Phoenix's ordering guarantees because
        # the runner spawn precedes the wrapper's socket open, but staying
        # a no-op here is the fail-safe).
        {:reply, :ok, s}
    end
  end

  @impl true
  def handle_cast({:resolve, agent_id, request_id, ok, reason, to_session_id}, s) do
    case Map.get(s.pending, agent_id) do
      %{request_id: ^request_id} = lock ->
        if ok do
          # Two-phase F2: runner spawn succeeded, but wait for the fresh
          # wrapper's actual channel join before firing completed. Keep
          # the timer running — it now covers the awaiting_connect window
          # as well as the spawn window.
          updated =
            lock
            |> Map.put(:phase, :awaiting_connect)
            |> Map.put(:to_session_id, to_session_id)

          {:noreply, %{s | pending: Map.put(s.pending, agent_id, updated)}}
        else
          # Failure path: fire the loud broadcast immediately, no detach.
          _ = Process.cancel_timer(lock.timer_ref)
          broadcast_failed(agent_id, lock, reason)
          {:noreply, %{s | pending: Map.delete(s.pending, agent_id)}}
        end

      _ ->
        # Stale result — a prior timeout already broadcast a failure, or
        # the agent was deleted. Ignore per ADR-0036 F7.
        {:noreply, s}
    end
  end

  @impl true
  def handle_info({:timeout, agent_id, request_id}, s) do
    case Map.get(s.pending, agent_id) do
      %{request_id: ^request_id} = lock ->
        # No detach on timeout: the old session may still be live and a
        # rollback path can recover it. UI shows the loud failure. Covers
        # both phases — a slow spawn AND a spawn that succeeds but whose
        # wrapper never joins.
        broadcast_failed(agent_id, lock, "timeout")

        {:noreply, %{s | pending: Map.delete(s.pending, agent_id)}}

      _ ->
        {:noreply, s}
    end
  end

  defp broadcast_completed(agent_id, lock, to_session_id) do
    # `previous_session_id` is optional per the protocol type
    # `SessionResetCompleted { previous_session_id?: string }` (only
    # `to_session_id: string | null` is nullable to cover Codex lazy
    # thread采番). Omit the key entirely when nil so the wire matches
    # the type shape (review advisory).
    payload =
      %{
        "request_id" => lock.request_id,
        "agent_id" => agent_id,
        "mode" => lock.mode,
        "to_session_id" => to_session_id
      }
      |> maybe_put_previous_session_id(lock.previous_session_id)

    KaoiroServerWeb.Endpoint.broadcast(
      "agents:lobby",
      "session_reset_completed",
      payload
    )
  end

  defp maybe_put_previous_session_id(payload, sid) when is_binary(sid),
    do: Map.put(payload, "previous_session_id", sid)

  defp maybe_put_previous_session_id(payload, _sid), do: payload

  # phase-17 17-7: build the session_boundary marker envelope. `state` is
  # fixed to "idle" — reset acquire only permits idle / waiting_input, and
  # a marker denotes the transition between sessions rather than any live
  # engine state. persona comes from the current AgentStates entry so
  # the marker attributes to the same persona the transcript is showing.
  # session_id is deliberately absent (envelope.session_id is optional);
  # the marker straddles two sessions and belongs to neither.
  defp build_boundary_envelope(agent_id, lock, effective_to_sid) do
    persona =
      case Map.get(KaoiroServer.AgentStates.snapshot(), agent_id) do
        %{"persona" => p} when is_map(p) -> p
        _ -> %{}
      end

    payload =
      %{
        "mode" => lock.mode,
        "request_id" => lock.request_id,
        "to_session_id" => effective_to_sid
      }
      |> maybe_put_previous_session_id(lock.previous_session_id)

    %{
      "version" => "0",
      "agent_id" => agent_id,
      "persona" => persona,
      "ts" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "type" => "session_boundary",
      "state" => "idle",
      "payload" => payload,
      "ext" => %{}
    }
  end

  defp broadcast_failed(agent_id, lock, reason) do
    payload = %{
      "request_id" => lock.request_id,
      "agent_id" => agent_id,
      "mode" => lock.mode,
      "reason" => reason
    }

    KaoiroServerWeb.Endpoint.broadcast(
      "agents:lobby",
      "session_reset_failed",
      payload
    )
  end

  # Best-effort detach: DETS I/O failure must not leak into
  # `resolve/6`'s lock release path. A raise here would bubble into the
  # GenServer's cast handler, restart SessionResets under the supervisor,
  # and drop every pending lock — one failed detach becoming a fleet-wide
  # reset failure. Log and continue instead; the pointer is agent-scoped
  # and the ordinary `SessionPointers.record` path on the fresh session's
  # first envelope will still overwrite it.
  defp detach_session_safely(agent_id) do
    try do
      SessionPointers.detach_session(agent_id)
    rescue
      e ->
        Logger.warning(
          "SessionResets.resolve: detach_session raised for " <>
            "#{agent_id}: #{Exception.message(e)}"
        )
    catch
      kind, reason ->
        Logger.warning(
          "SessionResets.resolve: detach_session #{kind} for " <>
            "#{agent_id}: #{inspect(reason)}"
        )
    end
  end

  defp monotonic_ms, do: :erlang.monotonic_time(:millisecond)

  # Prefixed random suffix so a reset request_id is visually distinct
  # from an SDK session_id in logs (`rs_` vs UUID-shaped).
  defp generate_request_id do
    "rs_" <> Base.url_encode64(:crypto.strong_rand_bytes(9), padding: false)
  end
end
