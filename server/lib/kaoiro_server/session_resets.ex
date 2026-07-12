defmodule KaoiroServer.SessionResets do
  @moduledoc """
  Session-reset pending-lock SSOT (ADR-0036 F6/F7, phase-17 17-4). Owns
  the per-agent lock that blocks a second `/new`・`/clear` from racing
  a first, blocks new instructions / model / effort / permission_mode
  switches while a reset is in flight, and gates a reset against a
  just-dispatched instruction whose `thinking` state_change has not yet
  reached AgentStates.

  Two concurrency windows are closed here in a single GenServer:

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
  Records the runner's `session_reset_result` and fires the matching
  `session_reset_completed` / `session_reset_failed` broadcast.

  On success (`ok=true`) also calls `SessionPointers.detach_session/1`
  so the pointer's session_id is explicitly nil before the fresh
  wrapper's first envelope reattaches a new one via the ordinary
  `SessionPointers.record` path. On failure, the pointer is left
  untouched — the old session may still be live for rollback (ADR-0036
  F2 rollback branch).

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
          timer_ref: timer_ref
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

  @impl true
  def handle_cast({:resolve, agent_id, request_id, ok, reason, to_session_id}, s) do
    case Map.get(s.pending, agent_id) do
      %{request_id: ^request_id} = lock ->
        _ = Process.cancel_timer(lock.timer_ref)

        # Guard the detach so a DETS write failure cannot leave the lock
        # dangling — the lock's removal (and its broadcast) must happen
        # regardless of the pointer write's fate. The DETS store's own
        # corrupt-file guard already recovers on next open (SessionPointers
        # docs); logging preserves diagnosability.
        if ok, do: detach_session_safely(agent_id)

        broadcast_result(ok, agent_id, lock, to_session_id, reason)

        {:noreply, %{s | pending: Map.delete(s.pending, agent_id)}}

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
        # rollback path can recover it. UI shows the loud failure.
        broadcast_result(false, agent_id, lock, nil, "timeout")

        {:noreply, %{s | pending: Map.delete(s.pending, agent_id)}}

      _ ->
        {:noreply, s}
    end
  end

  defp broadcast_result(true, agent_id, lock, to_session_id, _reason) do
    payload = %{
      "request_id" => lock.request_id,
      "agent_id" => agent_id,
      "mode" => lock.mode,
      "previous_session_id" => lock.previous_session_id,
      "to_session_id" => to_session_id
    }

    KaoiroServerWeb.Endpoint.broadcast(
      "agents:lobby",
      "session_reset_completed",
      payload
    )
  end

  defp broadcast_result(false, agent_id, lock, _to_session_id, reason) do
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
