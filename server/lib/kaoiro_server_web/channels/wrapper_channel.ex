defmodule KaoiroServerWeb.WrapperChannel do
  @moduledoc """
  Ingests envelopes from one wrapper (topic `wrapper:<agent_id>`), stores
  the latest state, and fans them out to clients (`agents:lobby`). An
  envelope's `session_id` (once the wrapper reports one) also refreshes
  the agent's restart-surviving pointer (ADR-0014 F1, issue #49).

  Validation covers only the envelope v0 frame keys; per ADR-0010 the
  payload stays opaque to the server (agent-agnostic relay). Joins are
  gated by the per-agent_id token list (ADR-0011); on terminate the
  server derives a `disconnected` envelope (specs/protocol.md). Server →
  wrapper pushes (`instruction` / `permission_decision`) arrive via
  Endpoint.broadcast on this topic and need no handler here.
  """

  use Phoenix.Channel

  require Logger

  alias KaoiroServer.AgentDirectory
  alias KaoiroServer.AgentActivity
  alias KaoiroServer.AgentStates
  alias KaoiroServer.Auth
  alias KaoiroServer.ClearWatermarks
  alias KaoiroServer.ConversationStates
  alias KaoiroServer.IngressOrder
  alias KaoiroServer.PersonaAssets
  alias KaoiroServer.SessionPointers
  alias KaoiroServer.SessionResets
  alias KaoiroServer.SessionStarts
  alias KaoiroServer.TaskStates
  alias KaoiroServer.TokenDenylist
  alias KaoiroServerWeb.AgentId

  # Intercept the operator-initiated revoke broadcast (issue #72) so it
  # goes through `handle_out/3` (channel-local stop) instead of the
  # default noop-relay to the client. Without this intercept the
  # Broadcast would fan out to the wrapper's WS as an ordinary event
  # without ever closing the channel process — the whole point of the
  # broadcast is to force the drop.
  intercept(["revoked"])

  @frame_keys ~w(version agent_id ts type state)
  @inter_agent_kinds ~w(request response query inform propose accept reject escalate-to-user done)

  # Resource bound only; content/type refinement is Phase 1.5-4. Clients
  # must still treat all envelope strings as untrusted when rendering.
  @max_envelope_bytes 65_536
  @session_reset_modes ["new", "clear"]

  # M1 round-3 fix (2026-08-09, ふじ round 3, issue #180): `task_id` on a
  # `task` envelope had no length cap of its own — only the WHOLE
  # envelope was bounded (`@max_envelope_bytes` above). Since task_id
  # doubles as a JSON *map key* on the outbound `TaskStates` snapshot
  # wire (`%{agent_id => %{task_id => envelope}}`), an individually-
  # small-but-unbounded-length task_id let a handful of ingress-cap-
  # compliant envelopes blow past the snapshot's own byte budget in ways
  # the budget's per-entry accounting had not measured (ふじ's own
  # measurement: 96 valid envelopes -> an 11.9MB actual snapshot).
  # `payload.agent_id` needs NO analogous cap here — it must equal the
  # topic-derived `agent_id` (the guard below), which
  # `KaoiroServerWeb.AgentId.valid?/1` (issue #61) already bounds to
  # 1..256 chars at JOIN time, so it inherits that bound for free.
  # `KaoiroServer.TaskStates.@max_task_snapshot_bytes`'s margin comment
  # cites BOTH this constant and `AgentId`'s pre-existing 256-char bound
  # for its per-agent outer-key-overhead arithmetic.
  @max_task_id_field_bytes 256

  # issue #188 / ADR-0049 F4: a tasklist is a bounded whole-list snapshot,
  # not an unbounded transcript. These ingress caps deliberately mirror the
  # wrapper-side normalizer; the server still verifies them because wrappers
  # are a trust boundary, and a bypass must not inflate TaskStates/snapshots.
  @max_tasklist_items 50
  @max_tasklist_item_text_bytes 256
  @max_tasklist_items_json_bytes 16_384

  # Upper bound on conversations notified in one disconnect (#131). Phase 1
  # caps a conversation at 2 agents and a wrapper realistically holds a
  # handful; the tracker's own cap is global (max_conversations), so without
  # this a single wrapper's disconnect could fan out thousands of broadcasts.
  @max_unreachable_notices 50

  # Bound on one `replay_ia` push (ADR-0051 D3-3). The final projection is
  # capped at 200 anyway (D6), so a larger batch could only ever be
  # discarded — refusing to walk it keeps a malformed / hostile sidecar
  # from costing an unbounded scan.
  @max_replay_ia_items 200

  @impl true
  def join("wrapper:" <> agent_id, params, socket) do
    transition_id =
      if Map.has_key?(params, "transition_id"),
        do: Map.get(params, "transition_id"),
        else: :absent

    with :ok <- validate_agent_id(agent_id),
         :ok <- Auth.authorize_wrapper(agent_id, socket.assigns[:wrapper_token]),
         {:ok, persona_id} <- fetch_persona_id(params),
         :ok <- authorize_persona(persona_id),
         :ok <- reject_if_connected(agent_id) do
      # Drop the raw token once verified so it cannot leak via crash
      # logs / socket inspection.
      send(self(), :after_join)

      # ADR-0051 D2: the join REPLY is the hydration handshake. There is no
      # dedicated S→W event because a reconnect is always a fresh join, so
      # the verdict always has a join to ride. Allocating the attempt here
      # (rather than in :after_join) keeps it inside the same message the
      # wrapper is already waiting on, so the wrapper never has to guess
      # whether a verdict is still coming.
      {:ok, %{"hydration" => hydration_verdict(agent_id)},
       socket
       |> assign(:agent_id, agent_id)
       |> assign(:persona_id, persona_id)
       |> assign(:transition_id, transition_id)
       |> assign(:wrapper_token, nil)}
    else
      {:error, reason} -> {:error, %{reason: to_string(reason)}}
    end
  end

  # Push the initial handshake state once the join completes:
  # - `persona_prompt`: the ready-to-inject personality + common footer
  #   (ADR-0029 F5, protocol.md「人格プロンプト配送」). The wrapper
  #   awaits this before opening its SDK session (fail-closed, F3).
  # - `set_permission_mode`: the persisted per-agent operator pick, when
  #   any (#58). Nothing pushed when no mode was persisted.
  #
  # Phoenix Channels require push/3 to run after the join reply; send/2 +
  # handle_info is the standard idiom.
  @impl true
  def handle_info(:after_join, socket) do
    # ふじ R1-race must-fix (2026-07-23, 3rd review): close the join
    # window between (1) Auth.authorize_wrapper's denylist check and
    # (4) Phoenix subscribing the channel to `wrapper:<agent_id>`. If
    # an operator's `delete_agent` / `revoke_wrapper_token` completes
    # inside 1-4, the `revoked` broadcast fires against a
    # still-unsubscribed channel process — `handle_out("revoked", …)`
    # is never invoked and the channel goes on to push persona_prompt,
    # re-seed AgentStates via the wrapper's first envelope, etc.
    # Re-checking the denylist HERE (after subscribe is guaranteed by
    # the fact that our :after_join self-message is being processed)
    # and stopping without side effects closes the window. Any revoke
    # that lands after this point is picked up by the existing
    # `intercept ["revoked"]` handler.
    if TokenDenylist.revoked?(socket.assigns.agent_id) do
      {:stop, :shutdown, socket}
    else
      case after_join_handshake(socket) do
        result when result in [:deleted, :duplicate_waiter] -> {:stop, :shutdown, socket}
        :ok -> {:noreply, socket}
      end
    end
  end

  defp after_join_handshake(socket) do
    agent_id = socket.assigns.agent_id
    transition_id = socket.assigns.transition_id
    reset_id = KaoiroServer.SessionResets.pending_request_id(agent_id)

    # L2 order is intentionally pinned: confirm commits the existing reset
    # only after join-id CAS, then creates the Activity pending transaction,
    # then lets Activity decide activation/rebind using the same outcome.
    reset_result =
      KaoiroServer.SessionResets.confirm_connection(agent_id, nil, transition_id, SessionResets)

    if reset_result in [:deleted, :duplicate_waiter] do
      # Deletion released a deferred join. Rebinding here would recreate the
      # just-deleted Activity entry before the channel terminates. A duplicate
      # waiter is likewise rejected before it can steal owner generation or
      # receive a persona prompt.
      reset_result
    else
      if reset_result in [:matched, :legacy_absent] and is_binary(reset_id) do
        :ok =
          AgentActivity.begin_transition(
            agent_id,
            reset_id,
            :reset,
            DateTime.utc_now() |> DateTime.to_iso8601()
          )
      end

      _ =
        AgentActivity.activate_or_rebind(agent_id, self(), transition_id,
          reset_result: reset_result
        )

      case PersonaAssets.prompt(socket.assigns.persona_id) do
        prompt when is_binary(prompt) ->
          push(socket, "persona_prompt", %{prompt: prompt})

        nil ->
          # The join gate accepted this persona_id, but the pack has since
          # gone from the manifest (rebuild between join and after_join).
          # Fail closed by refusing the prompt — the wrapper's spawn
          # timeout will surface it.
          :ok
      end

      case KaoiroServer.PermissionModes.get(socket.assigns.agent_id) do
        mode when is_binary(mode) ->
          push(socket, "set_permission_mode", %{mode: mode})

        _ ->
          :ok
      end

      :ok
    end
  end

  # Operator-initiated token revoke (issue #72): the AgentsChannel
  # `revoke_wrapper_token` handler broadcasts on this wrapper's topic to
  # force-drop a currently-connected wrapper (otherwise the denylist
  # only takes effect on the next join). The channel stops with a normal
  # `:shutdown`; `terminate/2` still runs and derives the usual
  # `disconnected` envelope, so the dashboard reflects the drop without
  # a special-case UI. Any subsequent reconnect fails at
  # `Auth.authorize_wrapper/2` because the denylist entry is now
  # persistent. The event is `intercept`ed at the top of the module so
  # this callback runs instead of the default noop-relay to the wrapper.
  @impl true
  def handle_out("revoked", _payload, socket) do
    {:stop, :shutdown, socket}
  end

  # ADR-0051 D2 verdict, shaped for the wire
  # (`{replay_required, replay_id?}`). `replay_id` is server-allocated so
  # the reset / `replay_ia` / complete triple and the server's own
  # in-flight record can never disagree about which attempt they belong
  # to — the ambiguity a wrapper-allocated id left open.
  defp hydration_verdict(agent_id) do
    case AgentStates.hydration_verdict(agent_id, self()) do
      {:required, replay_id} -> %{"replay_required" => true, "replay_id" => replay_id}
      :not_required -> %{"replay_required" => false}
    end
  end

  # persona_id rides join params (channel-level) rather than the socket
  # connect params (which only carry the auth token). Blank / missing is
  # an explicit reject — the wrapper MUST declare which persona it is
  # (ADR-0029 F3, protocol.md「人格プロンプト配送」).
  defp fetch_persona_id(params) do
    case params do
      %{"persona_id" => pid} when is_binary(pid) and pid != "" -> {:ok, pid}
      _ -> {:error, :missing_persona_id}
    end
  end

  # Enforce the「野良 persona 禁止」rule (ADR-0029 F3): the wrapper's
  # declared persona.id must be one server-side manifest knows (or the
  # reserved `default`). Also constrain the charset — the id rides the
  # sprite URL path.
  defp authorize_persona(persona_id) do
    cond do
      not AgentId.valid?(persona_id) -> {:error, :invalid_persona_id}
      PersonaAssets.known_persona?(persona_id) -> :ok
      true -> {:error, :unknown_persona}
    end
  end

  # Reject a second concurrent wrapper for an agent_id that already has a
  # live connection (ADR-0024 D5, reject-newcomer). The incumbent keeps the
  # slot, so a token-holding third party cannot adversarially evict a live
  # agent. A genuine reconnect is allowed once the old connection's terminate
  # has run (its owner pid is then dead); after an abrupt drop that is delayed
  # by the socket timeout window, during which the reconnect retries.
  defp reject_if_connected(agent_id) do
    if AgentStates.connected?(agent_id), do: {:error, :already_connected}, else: :ok
  end

  # Enforce the protocol.md agent_id charset at the join boundary (issue
  # #61). Checked before auth: the charset is public, so an early reject
  # leaks nothing a client cannot already derive.
  defp validate_agent_id(agent_id) do
    if AgentId.valid?(agent_id), do: :ok, else: {:error, :invalid_agent_id}
  end

  @impl true
  def handle_in("envelope", envelope, socket) do
    agent_id = socket.assigns.agent_id

    with :ok <- validate(envelope, agent_id),
         {:ok, inter_agent} <- preflight_inter_agent(envelope, agent_id) do
      # ふじ 検収 2 fix-round M2 (2026-07-23): advance boundary BEFORE
      # any ingress stamp is allocated. Pre-M2 this ran after store, so
      # if the first envelope of a new session was an inter_agent_message
      # its IA order was allocated first and the boundary allocated a
      # strictly larger order — the very current-session IA was then
      # filtered out on reload. Running maybe_advance first flips the
      # ordering so any IA stamped by this envelope gets a post-boundary
      # order.
      #
      # Also handles Codex lazy 采番 adopt: an envelope whose
      # session_id matches an already-boundary'd sid (Trigger 1 stored
      # nil, now filled) patches the boundary's sid so future retries
      # are transition-idempotent.
      maybe_advance_session_boundary(envelope, agent_id)

      # This timestamp belongs to the accepting WrapperChannel, not the
      # activity GenServer: a delayed cast must not make last_activity_at
      # look newer than the envelope the server actually accepted.
      received_at = DateTime.utc_now() |> DateTime.to_iso8601()

      case inter_agent do
        {:accept, to, escalate} ->
          accept_inter_agent(envelope, agent_id, to, escalate, received_at, socket)

        :not_inter_agent ->
          store_and_broadcast(envelope, agent_id, received_at, socket)
      end
    else
      {:error, reason} when is_atom(reason) ->
        {:reply, {:error, %{reason: to_string(reason)}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  # Peer directory request (protocol-inter-agent, phase-8 companion tool).
  # The wrapper's `mcp__kaoiro__list_agents` tool calls this to resolve
  # persona names → agent_ids before send_to_agent. Reply carries every
  # currently-known agent EXCEPT the requester. Phase-8's name-resolution
  # minimum was deliberately widened by #102: engine / model / effort are
  # peer-visible execution traits for delegation. Other operator-grade ext
  # (cwd / permission / session / context / capabilities / source) stays out.
  @impl true
  def handle_in("directory_request", _payload, socket) do
    self_id = socket.assigns.agent_id
    activities = AgentActivity.snapshot()
    peer_index = ConversationStates.peer_index()

    agents =
      AgentStates.snapshot()
      |> Enum.reject(fn {id, _} -> id == self_id end)
      |> Enum.map(fn {id, env} ->
        directory_entry(id, env, Map.get(activities, id), Map.get(peer_index, id, []))
      end)

    {:reply, {:ok, %{"agents" => agents, "users" => users_projection()}}, socket}
  end

  # Resume history reconstruction (ADR-0014 phase-2, issue #50): the wrapper
  # is about to replay its JSONL-derived transcript as `log` envelopes, so it
  # first asks the server to drop the agent's current ring buffer (overwrite,
  # not append — a server that survived the crash still holds the same
  # session's pre-crash lines). Broadcast `history_reset` so every connected
  # operator clears its transcript before the replayed lines arrive
  # (operator-only gate in AgentsChannel). replay_id pairs this reset with
  # `history_replay_complete`, the deterministic boundary after the final
  # reconstructed JSONL row. `:noop` (no state entry yet) is still acked —
  # the wrapper did nothing wrong.
  @impl true
  def handle_in("history_reset", payload, socket) do
    agent_id = socket.assigns.agent_id
    replay_id = if is_map(payload), do: Map.get(payload, "replay_id"), else: nil

    case AgentStates.reset_history(agent_id) do
      :ok ->
        # ADR-0051 D3-3: IA is re-projected from the wrapper's sidecar via
        # `replay_ia` inside this same replay window, so preserving the
        # old copies would double every restored bubble. The field is kept
        # on the wire and sent explicitly as `false` because an OLD
        # dashboard reads an ABSENT `preserve_inter_agent` as `true` —
        # dropping it would leave stale IA on those tabs. Physically
        # removing the field is a later step, after old tabs are gone.
        reset_payload = %{
          "agent_id" => agent_id,
          "preserve_inter_agent" => false
        }

        reset_payload =
          if is_binary(replay_id) and replay_id != "" do
            Map.put(reset_payload, "replay_id", replay_id)
          else
            reset_payload
          end

        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_reset", reset_payload)

        {:reply, :ok, socket}

      :noop ->
        {:reply, :ok, socket}
    end
  end

  # Explicitly closes a reset/replay window. Reconstructed log envelopes use
  # the ordinary `envelope` route, so this marker is the only deterministic
  # distinction available to a dashboard before the next live assistant line.
  @impl true
  def handle_in("history_replay_complete", %{"replay_id" => replay_id}, socket)
      when is_binary(replay_id) and replay_id != "" do
    agent_id = socket.assigns.agent_id

    KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_replay_complete", %{
      "agent_id" => agent_id,
      "replay_id" => replay_id
    })

    # ADR-0051 D2: CAS. Only the attempt still recorded for THIS
    # connection may declare the projection hydrated — a completion from
    # a superseded connection (its replay was abandoned mid-way when the
    # channel dropped) would otherwise mark a newer attempt done and
    # strand the timeline half-rebuilt. The dashboard pairing above is
    # independent of the CAS and always broadcasts.
    _ = AgentStates.complete_hydration(agent_id, replay_id, self())

    {:reply, :ok, socket}
  end

  def handle_in("history_replay_complete", _payload, socket), do: {:reply, :ok, socket}

  # Display-replay-only IA ingress (ADR-0051 D3-3). Deliberately NOT the
  # ordinary `envelope` route: that one runs `route_inter_agent`, which
  # would re-push to the peer wrapper and re-inject into its SDK — turning
  # a history restore into a re-run of the conversation. Here the ONLY
  # effect is a per-pane projection upsert; routing, ConversationStates,
  # peer pushes and SDK injection are all untouched.
  #
  # The pane is bound to the channel topic, so a wrapper can only ever
  # restore its own pane — the payload cannot name another agent's.
  @impl true
  def handle_in("replay_ia", %{"replay_id" => replay_id, "items" => items}, socket)
      when is_binary(replay_id) and replay_id != "" and is_list(items) do
    agent_id = socket.assigns.agent_id

    if AgentStates.hydration_in_flight?(agent_id, replay_id, self()) do
      # One lookup per push rather than per item: the bound cannot change
      # mid-batch in a way that matters (a clear landing during the replay
      # is caught by the read-time filter in AgentsChannel).
      bound = Map.get(ClearWatermarks.all_filter_bounds(), agent_id)

      items
      |> Enum.take(@max_replay_ia_items)
      |> Enum.each(&replay_ia_item(agent_id, &1, bound))

      {:reply, :ok, socket}
    else
      # Not the attempt this server is waiting on: a wrapper resending an
      # abandoned replay must not repopulate a pane the new attempt is
      # rebuilding.
      {:reply, {:error, %{reason: "stale_replay"}}, socket}
    end
  end

  def handle_in("replay_ia", _payload, socket) do
    {:reply, {:error, %{reason: "invalid value: replay_ia"}}, socket}
  end

  # ADR-0043 D1/D3: a wrapper may request a reset only for its own agent,
  # after its MCP tool has been broker-approved and after the wrapper has
  # reached its turn boundary. The request does not re-parse model text and
  # joins the exact SessionResets gate used by operator `session_reset`.
  @impl true
  def handle_in("session_reset_request", payload, socket) do
    agent_id = socket.assigns.agent_id

    with {:ok, mode} <- fetch_reset_mode(payload),
         {:ok, reason} <- fetch_reset_reason(payload),
         {:ok, envelope} <- fetch_reset_envelope(agent_id),
         :ok <- require_reset_capability(envelope, mode),
         {:ok, state} <- fetch_kaoiro_state(envelope),
         {:ok, request_id, prev_sid} <-
           SessionResets.check_and_acquire(
             agent_id,
             mode,
             state,
             Map.get(envelope, "session_id"),
             :agent_self,
             SessionResets
           ) do
      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "session_reset_started",
        started_reset_payload(agent_id, mode, request_id, prev_sid, reason)
      )

      KaoiroServerWeb.Endpoint.broadcast(
        "runner:#{AgentId.host_id_from(agent_id)}",
        "reset_session",
        %{
          "version" => "0",
          "agent_id" => agent_id,
          "mode" => mode,
          "request_id" => request_id
        }
        |> maybe_put_previous_session_id(prev_sid)
        |> maybe_put_resume_snapshot(agent_id)
      )

      {:reply, :ok, socket}
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: reset_request_reason(reason)}}, socket}
    end
  end

  # Non-IA envelopes: retain, then fan out. Unchanged from pre-ADR-0051
  # except that `inter_agent_message` no longer reaches it (see
  # `accept_inter_agent/6`).
  defp store_and_broadcast(envelope, agent_id, received_at, socket) do
    case store(envelope) do
      :ok ->
        # G1: record only after validate / preflight / store have all
        # accepted the envelope. In particular an orphan reply must not
        # consume an AgentActivity entry merely because it reached the
        # channel.
        record_accepted_envelope(envelope, agent_id, received_at)
        # The full envelope (incl. operator-only log/result tool I/O)
        # goes onto agents:lobby unfiltered; role gating is per-
        # subscriber in AgentsChannel.handle_out. Invariant: ONLY
        # AgentsChannel may subscribe to this topic — any new
        # subscriber MUST apply the same role gate (#27,
        # specs/threat-model.md).
        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)
        {:reply, :ok, socket}

      :noop ->
        # A reply before any state (append_log :noop) has no snapshot
        # entry to anchor it; drop the live broadcast too so "latest
        # state is authoritative" holds (history was already not
        # retained). Ack the wrapper — it did nothing wrong.
        {:reply, :ok, socket}

      {:error, reason} ->
        # Boundary advance intentionally precedes retention so a first IA
        # gets a post-boundary order. A cap failure still leaves the
        # transition durable; only volatile AgentStates retention failed.
        {:reply, {:error, %{reason: to_string(reason)}}, socket}
    end
  end

  # Live inter-agent accept (ADR-0051 D3-1). The causal order below is the
  # contract, not an implementation detail — protocol-inter-agent pins it:
  #
  #   1. validate + preflight (already done by the caller): EVERY check
  #      that can still decide a reject, including the conversation quota,
  #      runs before anything is projected. A rejected IA must never be
  #      left sitting in a pane.
  #   2. allocate the ingress stamp — the durable, globally unique
  #      ordering-domain value the wrapper stores verbatim and replays
  #      back, and the value `ClearWatermarks` is compared against.
  #   3. upsert BOTH panes under that one stamp, so the sender copy and
  #      the receiver copy are two views of one message rather than two
  #      messages.
  #   4. push to the peer wrapper (the only routing left after the
  #      upsert) and broadcast to operators.
  #   5. reply the stamp as the acceptance ack — this, not the MCP tool
  #      result, is what triggers the sender's sidecar append (D3-2).
  defp accept_inter_agent(envelope, from, to, escalate, received_at, socket) do
    stamp = IngressOrder.allocate()
    wire_stamp = encode_stamp(stamp)
    stamped = Map.put(envelope, "ingress_stamp", wire_stamp)

    retained = AgentStates.upsert_ia(from, stamp, stamped)
    _ = AgentStates.upsert_ia(to, stamp, stamped)

    push_to_wrapper(to, stamped)
    if escalate != nil, do: broadcast_escalate(escalate)

    # Same "no snapshot entry to anchor it" rule store_and_broadcast
    # applies: a sender with no latest state yet gets routed but not
    # displayed. The ack still carries the stamp — the message WAS
    # accepted, and the sender's sidecar is what restores its own pane
    # once an entry exists.
    if retained == :ok do
      record_accepted_envelope(envelope, from, received_at)
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", stamped)
    end

    {:reply, {:ok, %{"ingress_stamp" => wire_stamp}}, socket}
  end

  defp record_accepted_envelope(envelope, agent_id, received_at) do
    AgentActivity.record_envelope(envelope, self(), received_at)
    record_session_pointer(envelope)
    # phase-17 17-7: fill the pending boundary marker's to_session_id
    # when a fresh Codex session finally reports its thread ID
    # (SessionResets.confirm_connection could not confirm it earlier
    # because Codex's采番 is lazy). No-op unless a stash exists.
    maybe_patch_boundary_to_session_id(envelope, agent_id)
    # Refresh the memory-only last_seen hint used by the client's
    # live/offline merge (ADR-0030). Cheap fire-and-forget; no disk I/O.
    AgentDirectory.touch(agent_id)
    :ok
  end

  # log / result are reply transcript lines kept as history (ADR-0012);
  # state_change / permission_request refresh the latest state.
  defp store(%{"type" => type} = envelope) when type in ["log", "result"] do
    AgentStates.append_log(envelope)
  end

  # refresh_models_result is a transient completion signal for a paired
  # refreshModels() waiter (ADR-0039 F9 v2 = 藤 review turn-10 must-fix 1).
  # It carries only { request_id, ok, reason?, models_count? } — never a
  # state — so overwriting the latest AgentStates entry with it would erase
  # the rich models the immediately-preceding state_change just delivered.
  # Broadcast only; do NOT store.
  defp store(%{"type" => "refresh_models_result"}), do: :ok

  # Subagent/workflow task lifecycle (issue #180, ADR-0019/0047/0048). A
  # dedicated flat table, not the per-agent_id AgentStates slot — see
  # TaskStates' moduledoc. Broadcast (below, unchanged for every type)
  # still fans this out to agents:lobby same as any other envelope.
  defp store(%{"type" => "task"} = envelope), do: TaskStates.put(envelope)

  defp store(envelope), do: AgentStates.put(envelope, owner: self())

  # "users" projection for directory_request (issue #197 段階2, ADR-0021
  # F6-8). Fail-closed (director D4): the third arg to get_env/3 is the
  # implementation default and it is `false` — only the exact `true`
  # config value (server/config/runtime.exs, KAOIRO_EXPOSE_USERS_TO_AGENTS)
  # opens this. "原則見える" (issue #197 制約節) is realized as a config
  # DEFAULT, never as this implementation's own default.
  #
  # `== true` rather than a plain truthy `if`: Elixir treats every value
  # but `false`/`nil` as truthy, so a plain `if` would open this for a
  # stray non-boolean config value (e.g. the literal string `"true"`
  # landing in config by a typo'd release override) instead of keeping
  # it closed. Only the exact boolean `true` opens it.
  defp users_projection do
    if Application.get_env(:kaoiro_server, :expose_users_to_agents, false) == true do
      KaoiroServer.Users.all_with_role()
      |> Enum.map(&user_entry/1)
      |> Enum.filter(&(&1 != nil))
    else
      []
    end
  end

  # Peer directory "users" entry (issue #197 段階2). A LITERAL map with
  # every value re-validated at its own type/shape — deliberately NOT
  # Map.take/2 (director D1). Map.take only narrows which KEYS survive;
  # it passes the VALUES through unchecked, so a future shape change on
  # Users' side (display_name becoming a map/tuple, an unexpected role
  # atom) would ride onto the wire untouched. A `Users.all_with_role/1`
  # entry whose shape does not check out here is dropped entirely (the
  # `nil` clause below) rather than partially emitted, so one malformed
  # entry cannot corrupt the response's contract for that user.
  #
  # `id` reuses AgentId's charset guard: ADR-0050 D1 puts user_id and
  # agent_id in the SAME id space (`[A-Za-z0-9._-]`, issue #61), so the
  # existing single-source-of-truth pattern applies here too rather than
  # duplicating the regex.
  defp user_entry(%{id: id, kind: "user", display_name: display_name, role: role}) do
    with true <- is_binary(id) and AgentId.valid?(id),
         {:ok, name} <- valid_display_name(display_name),
         role_str when is_binary(role_str) <- role_string(role) do
      %{"id" => id, "kind" => "user", "display_name" => name, "role" => role_str}
    else
      _ -> nil
    end
  end

  defp user_entry(_malformed), do: nil

  # Same length/control-char bound as an agent's custom name
  # (`AgentsChannel.apply_custom_name/2`, issue #22: <= 64 chars, no
  # `\x00-\x1f`/`\x7f`). ふじ M5 レビュー指摘: `Users` holds
  # arbitrary-length IdP / shared-token-config display_name text (no
  # length bound at creation time), and this projection was only
  # checking non-empty binary — an overlong or control-char name would
  # have reached the wire untouched, unlike an agent's custom name which
  # is already bounded there. The bound is duplicated rather than shared
  # (`apply_custom_name/2` is private to a different channel/audience)
  # because a cross-channel helper is out of this stage's scope; the
  # VALUE of the bound must still match so a name cannot break the grid
  # layout one path enforces and the other does not.
  defp valid_display_name(name) when is_binary(name) do
    trimmed = String.trim(name)

    if trimmed != "" and String.length(trimmed) <= 64 and
         not String.match?(trimmed, ~r/[\x00-\x1f\x7f]/) do
      {:ok, trimmed}
    else
      :error
    end
  end

  defp valid_display_name(_name), do: :error

  defp role_string(:operator), do: "operator"
  defp role_string(:viewer), do: "viewer"
  defp role_string(_other), do: nil

  defp directory_entry(id, envelope, activity, peers) do
    persona =
      case envelope do
        %{"persona" => %{} = p} -> Map.take(p, ["id", "name", "sprite_set"])
        _ -> %{}
      end

    state =
      case envelope do
        %{"state" => s} when is_binary(s) -> s
        _ -> "idle"
      end

    ext =
      case envelope do
        %{"ext" => %{} = value} -> value
        _ -> %{}
      end

    entry =
      %{"agent_id" => id, "persona" => persona, "state" => state}
      |> maybe_put_directory_field("engine", ext["engine"])
      |> maybe_put_directory_field("model", ext["model"])
      |> maybe_put_directory_field("effort", ext["effort"])
      |> Map.put("conversation", %{"active" => peers != [], "peers" => peers})

    entry = maybe_put_context(entry, ext)
    entry = maybe_put_rate_limits(entry, ext, id)
    put_activity_fields(entry, id, envelope, activity)
  end

  # `context` is capability-gated rather than presence-gated. In particular,
  # an old Claude wrapper can report context while lacking the capability; the
  # dashboard hides it in that situation, so the peer directory must too.
  defp maybe_put_context(entry, %{
         "session_capabilities" => %{"supports_context_usage" => true},
         "context" => %{} = context
       }) do
    with %{
           "used_tokens" => used_tokens,
           "max_tokens" => max_tokens,
           "used_percentage" => used_percentage
         } <- Map.take(context, ["used_tokens", "max_tokens", "used_percentage"]),
         true <- is_finite_number(used_tokens),
         true <- is_finite_number(max_tokens),
         true <- is_finite_number(used_percentage) do
      Map.put(entry, "context", %{
        "used_tokens" => used_tokens,
        "max_tokens" => max_tokens,
        "used_percentage" => used_percentage
      })
    else
      _ -> entry
    end
  end

  defp maybe_put_context(entry, _ext), do: entry

  defp maybe_put_rate_limits(entry, %{"rate_limits" => limits}, agent_id) when is_map(limits) do
    {projected, dropped} = project_rate_limits(limits)

    if dropped > 0 do
      # directory_request is auto-allow. Aggregate all malformed windows into
      # one warning per agent/request instead of producing unbounded logs.
      Logger.warning(
        "directory rate_limits projection dropped #{dropped} window(s) for #{agent_id}"
      )
    end

    if map_size(projected) == 0, do: entry, else: Map.put(entry, "rate_limits", projected)
  end

  defp maybe_put_rate_limits(entry, _ext, _agent_id), do: entry

  defp project_rate_limits(limits) do
    {valid, dropped} =
      Enum.reduce(limits, {[], 0}, fn {key, value}, {valid, dropped} ->
        case project_rate_limit_window(key, value) do
          {:ok, window} -> {[window | valid], dropped}
          :drop -> {valid, dropped + 1}
        end
      end)

    ordered =
      valid
      |> Enum.sort_by(fn {key, _} -> window_sort_key(key) end)
      |> Enum.take(8)

    {Map.new(ordered), dropped + max(length(valid) - length(ordered), 0)}
  end

  defp project_rate_limit_window(key, value)
       when is_binary(key) and byte_size(key) <= 32 and is_map(value) do
    if Regex.match?(~r/^[A-Za-z0-9_-]+$/, key) do
      # Values are optional, but a present malformed value invalidates the
      # whole window. Keeping its valid siblings would make a redacted window
      # indistinguishable from an engine that intentionally reports only
      # those fields.
      with {:ok, projected} <-
             maybe_put_rate_field(%{}, value, "status", &valid_status?/1),
           {:ok, projected} <-
             maybe_put_rate_field(
               projected,
               value,
               "utilization",
               &is_finite_number/1
             ),
           {:ok, projected} <-
             maybe_put_rate_field(
               projected,
               value,
               "resets_at",
               &valid_resets_at?/1
             ) do
        if map_size(projected) == 0, do: :drop, else: {:ok, {key, projected}}
      else
        :drop -> :drop
      end
    else
      :drop
    end
  end

  defp project_rate_limit_window(_key, _value), do: :drop

  defp maybe_put_rate_field(map, source, key, validator) do
    case Map.fetch(source, key) do
      :error -> {:ok, map}
      {:ok, value} -> if validator.(value), do: {:ok, Map.put(map, key, value)}, else: :drop
    end
  end

  defp window_sort_key("five_hour"), do: {0, ""}
  defp window_sort_key("seven_day"), do: {1, ""}
  defp window_sort_key(key), do: {2, key}

  defp valid_status?(value),
    do: is_binary(value) and String.valid?(value) and byte_size(value) <= 64

  defp valid_resets_at?(value),
    do: is_integer(value) and value >= 0 and value <= 9_007_199_254_740_991

  @max_safe_integer 9_007_199_254_740_991

  defp is_finite_number(value) when is_integer(value), do: abs(value) <= @max_safe_integer

  defp is_finite_number(value) when is_float(value) do
    value == value and value <= @max_safe_integer and value >= -@max_safe_integer
  end

  defp is_finite_number(_), do: false

  defp put_activity_fields(entry, id, envelope, activity) do
    entry =
      case activity do
        %{last_activity_at: value} when is_binary(value) ->
          Map.put(entry, "last_activity_at", value)

        _ ->
          entry
      end

    case session_projection(id, envelope, activity) do
      {:observed, started_at, turns} ->
        entry |> Map.put("session_started_at", started_at) |> Map.put("turns", turns)

      {:fallback, started_at} ->
        Map.put(entry, "session_started_at", started_at)

      :omit ->
        entry
    end
  end

  # G2: a casted record may briefly lag AgentStates. Never project
  # session-specific values unless both stores name the same non-empty sid.
  defp session_projection(_id, %{"session_id" => sid}, %{
         session_id: sid,
         session_started_at: started_at,
         session_start_observed: true,
         turns: turns,
         projection_suppressed: false
       })
       when is_binary(sid) and sid != "" and is_binary(started_at) and is_integer(turns) and
              turns >= 0,
       do: {:observed, started_at, turns}

  # Suppression applies before every resolution branch, including the
  # SessionStarts restart fallback. Otherwise a same-sid legacy restore can
  # re-publish old start metadata after the tracker lost its observation.
  defp session_projection(_id, _envelope, %{projection_suppressed: true}), do: :omit

  defp session_projection(id, %{"session_id" => sid}, %{session_start_observed: false})
       when is_binary(sid) and sid != "" do
    case SessionStarts.get(id) do
      {_order, started_at, ^sid} when is_binary(started_at) -> {:fallback, started_at}
      _ -> :omit
    end
  end

  defp session_projection(id, %{"session_id" => sid}, nil) when is_binary(sid) and sid != "" do
    case SessionStarts.get(id) do
      {_order, started_at, ^sid} when is_binary(started_at) -> {:fallback, started_at}
      _ -> :omit
    end
  end

  defp session_projection(_id, _envelope, _activity), do: :omit

  defp maybe_put_directory_field(entry, key, value)
       when is_binary(value) and value != "",
       do: Map.put(entry, key, value)

  defp maybe_put_directory_field(entry, _key, _value), do: entry

  # Persist the agent's latest SDK session_id as a restart-surviving
  # pointer (ADR-0014 F1, issue #49). Only fires once the wrapper has
  # reported a real session_id; cwd / engine ride along from ext when
  # present (engine keeps restore relaunching the same engine, ADR-0032).
  defp record_session_pointer(%{"agent_id" => agent_id, "session_id" => sid} = envelope)
       when is_binary(sid) and sid != "" do
    cwd =
      case envelope do
        %{"ext" => %{"cwd" => c}} when is_binary(c) -> c
        _ -> nil
      end

    engine =
      case envelope do
        %{"ext" => %{"engine" => e}} when e in ["claude-code", "codex"] -> e
        _ -> nil
      end

    SessionPointers.record(agent_id, sid, cwd, engine)
    record_snapshot_from_ext(agent_id, envelope)
  end

  defp record_session_pointer(envelope) do
    # session_id が乗らない envelope でも ext.effective (ADR-0014 F1 追補,
    # phase-15 D8) が来ていれば snapshot だけ更新する。record_snapshot は
    # 未知 agent で no-op なので、pointer が seed される前 (spawn 直後)
    # に届いた効果的な envelope は自然に無視される。
    case envelope do
      %{"agent_id" => agent_id} when is_binary(agent_id) ->
        record_snapshot_from_ext(agent_id, envelope)

      _ ->
        :ok
    end
  end

  # Trigger 2 records A's session start when the envelope reports a session_id that
  # differs from A's durable SessionPointers sid. This catches
  # explicit session-switch cases (restore/resume to a different sid)
  # that never go through SessionResets — Trigger 1 in
  # `SessionResets.confirm_connection` covers /new and /clear.
  #
  # Deliberately reads SessionPointers (durable) instead of
  # AgentStates.snapshot (揮発): a dogfood restart + wrapper reconnect
  # with the SAME sid would appear as "AgentStates unknown → sid",
  # falsely advancing the boundary and hiding the very durable IA
  # #105 restored. SessionPointers survives restart, so a resume of
  # the same session compares equal here → no advance.
  #
  # Also skips `prior_sid == nil` (未発話 agent の初回 sid 報告): a
  # fresh spawn's first state_change (SDK init) would otherwise hide
  # any IA that arrived before init. SessionResets covers the
  # legitimate nil→sid case (/clear detach then fresh session) via
  # its own boundary advance in Trigger 1.
  #
  # ふじ 検収 2 fix-round M3 (2026-07-23): `advance_transition/3` is
  # transition-idempotent by sid, so a stale envelope racing with
  # Trigger 1 cannot double-advance. Codex lazy 采番 adopt: when the
  # existing boundary was seeded with `nil` sid (Trigger 1 for Codex),
  # the first envelope carrying the real session_id patches it via
  # `adopt_sid/2` — no allocation, order/display unchanged, but future
  # retries of the same transition now match idempotently.
  #
  # Visibility is unchanged here: `clear_history` alone adopts the recorded
  # start and broadcasts the live client re-filter signal (#109).
  defp maybe_advance_session_boundary(%{"session_id" => new_sid}, agent_id)
       when is_binary(new_sid) and new_sid != "" do
    prior =
      case SessionPointers.get(agent_id) do
        %{session_id: sid} when is_binary(sid) -> sid
        _ -> nil
      end

    cond do
      prior != nil and prior != new_sid ->
        case KaoiroServer.SessionStarts.adopt_pending_sid(agent_id, new_sid, prior) do
          {:ok, _same_boundary} ->
            # R1: a crash preserved Trigger 1's nil-sid boundary but not its
            # pointer detach. pending_from_sid proves this is the same reset,
            # so adopt without allocating or broadcasting a second boundary.
            :ok

          :noop ->
            {:ok, {_order, _display, _sid}} =
              KaoiroServer.SessionStarts.advance_transition(agent_id, new_sid)
        end

        :ok

      true ->
        # Codex lazy: adopt existing nil-sid boundary if the record
        # exists (Trigger 1 might have seeded it during /clear or /new
        # with nil sid). No-op when no such record.
        _ = KaoiroServer.SessionStarts.adopt_sid(agent_id, new_sid)
        :ok
    end
  end

  defp maybe_advance_session_boundary(_envelope, _agent_id), do: :ok

  # phase-17 17-7: patch the pending boundary marker's to_session_id
  # once a fresh session finally reports one. Only fires when a stash
  # exists (SessionResets marker path set it), so a normal envelope
  # from a non-reset agent pays only one call + one map lookup.
  defp maybe_patch_boundary_to_session_id(%{"session_id" => sid}, agent_id)
       when is_binary(sid) do
    _ = AgentStates.patch_boundary_to_session_id(agent_id, sid)
    :ok
  end

  defp maybe_patch_boundary_to_session_id(_envelope, _agent_id), do: :ok

  # Pending and failed switches carry the prior effective value for display,
  # but are not a commit point. Skipping them keeps the persisted snapshot at
  # the last turn that completed without an outstanding switch (ADR-0035 F3).
  defp record_snapshot_from_ext(agent_id, %{
         "ext" => %{"effective" => effective} = ext
       })
       when is_map(effective) and not is_map_key(ext, "switch_error") and
              not is_map_key(ext, "pending_model") and
              not is_map_key(ext, "pending_effort") do
    SessionPointers.record_snapshot(agent_id, effective)
  end

  defp record_snapshot_from_ext(_agent_id, _envelope), do: :ok

  @impl true
  # Phoenix.Channel.Server invokes this callback even when `join/3` returned
  # an error. In that normal rejection lifecycle, the original socket has
  # never reached the successful join branch below and therefore has no
  # `:agent_id` assign. It has never owned AgentStates, so there is no
  # disconnect or hydration work to do.
  def terminate(_reason, %Phoenix.Socket{assigns: %{agent_id: agent_id}}) do
    # Server-derived disconnected (specs/protocol.md). AgentStates only
    # applies it while this channel still owns the entry, so a stale
    # terminate after a reconnect cannot clobber the new state.
    ts = DateTime.utc_now() |> DateTime.to_iso8601()

    # ADR-0051 D2: a replay abandoned mid-way (the wrapper dropped between
    # `history_reset` and the completion boundary) rolls back to
    # unhydrated so the next join re-requests it. Same owner guard as
    # `disconnect/3` — a stale terminate arriving after a reconnect must
    # not roll back the NEW connection's attempt.
    AgentStates.release_hydration(agent_id, self())

    case AgentStates.disconnect(agent_id, self(), ts) do
      {:ok, envelope} ->
        # ADR-0048 F1: the parent's departure discards its tasks. Piggy-
        # backs on AgentStates.disconnect/3's own owner check succeeding
        # (this terminate really did belong to the live connection) rather
        # than TaskStates tracking ownership itself — a stale terminate
        # after a reconnect never reaches this branch.
        #
        # M3 fix-round (2026-08-09, ふじ review): discard BEFORE the
        # broadcast below, not after. A client joining in the window
        # around this disconnect reads `TaskStates.snapshot()` from its
        # OWN process at some point relative to this one; the only
        # observable signal it has for "this agent's tasks are gone" is
        # either (a) this `disconnected` broadcast, if it was already
        # subscribed when this fires, or (b) its own snapshot read.
        # Discarding first guarantees: any snapshot read that lands AFTER
        # this broadcast is unconditionally post-purge (the same process
        # cannot reach the broadcast call before this GenServer.call
        # returns), so a client that missed the broadcast (joined too
        # late to see it) can never observe stale tasks either — its
        # later snapshot read is already clean. Discarding AFTER (the
        # original #180 order) left exactly that combination open: a
        # join whose snapshot read landed between broadcast and discard
        # got stale tasks it would never be told to drop, having already
        # missed the one broadcast for this disconnect.
        TaskStates.discard_for_agent(agent_id)
        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)
        # Only on an adopted disconnect: a stale terminate that lost the
        # entry to a reconnect must not tell peers the agent is gone.
        broadcast_peer_unreachable(agent_id, ts)

      :noop ->
        :ok
    end
  end

  def terminate(_reason, %Phoenix.Socket{}), do: :ok

  defp validate(envelope, agent_id) when is_map(envelope) do
    cond do
      missing = Enum.find(@frame_keys, &(not Map.has_key?(envelope, &1))) ->
        {:error, "missing key: #{missing}"}

      envelope["agent_id"] != agent_id ->
        {:error, "agent_id does not match topic"}

      :erlang.external_size(envelope) > @max_envelope_bytes ->
        {:error, "envelope too large"}

      envelope["type"] == "inter_agent_message" ->
        validate_live_inter_agent_payload(envelope["payload"])

      envelope["type"] == "task" ->
        validate_task_payload(envelope["payload"], agent_id)

      true ->
        :ok
    end
  end

  defp validate(_envelope, _agent_id), do: {:error, "envelope must be an object"}

  # issue #177 review M1: live ingress (this path) is exclusively
  # wrapper-origin — a server-synthesized notice (hard-limit escalate,
  # disconnected) is never submitted through `handle_in("envelope", ...)`;
  # the server constructs and pushes it directly (`deliver_synth_inter_agent`).
  # `turn_number=0` is reserved for that server provenance, so a wrapper
  # claiming it (or any non-positive value) here is either a bug or an
  # attempt to forge the server's reserved value and force a peer's
  # RECEIVING wrapper into believing the conversation was authoritatively
  # closed when it never was (split-brain: server=open, peer=closed).
  # Rejecting it structurally, before `preflight_inter_agent` /
  # `ConversationStates.record_message` ever run, closes that off
  # regardless of what the receiving wrapper does with a forged value that
  # slipped through. `validate_replayed_envelope/1` below intentionally
  # calls the unrestricted `validate_inter_agent_payload/1` directly — a
  # wrapper's own IA sidecar legitimately holds historical turn_number=0
  # rows from real server-synthesized notices it received.
  defp validate_live_inter_agent_payload(payload) do
    with :ok <- validate_inter_agent_payload(payload) do
      case payload["turn_number"] do
        n when is_integer(n) and n > 0 -> :ok
        _ -> {:error, "invalid value: payload.turn_number"}
      end
    end
  end

  # code-review (issue #180, round 1): `TaskStates` indexes/attributes every
  # task purely by `payload["agent_id"]` (self-contained per ADR-0047 F2),
  # never cross-checking it against the envelope's own topic-validated
  # `agent_id`. A mismatched payload.agent_id would file the task under the
  # wrong owner, so `WrapperChannel.terminate/2`'s
  # `TaskStates.discard_for_agent(agent_id)` (keyed by the REAL, connection-
  # owning agent_id) could never find and remove it — an orphaned entry that
  # grows the flat table forever. Reject at the frame boundary instead,
  # mirroring the `inter_agent_message` special case above.
  #
  # S1 fix-round (2026-08-09, ふじ review): beyond the agent_id match, also
  # validate ADR-0047 F2's other 3 required payload fields (task_id /
  # task_type / status non-empty strings) plus F1's `kind` enum and the
  # kind/status correspondence (started/updated carry status="running";
  # completed carries status in completed/failed/stopped) HERE, at the
  # frame boundary — a malformed task envelope must be rejected outright
  # (never reach `store_and_broadcast`) rather than sail through to a live
  # broadcast while `TaskStates.put/1`'s own defensive check quietly drops
  # it from the table. Leaving that inconsistency in place would let
  # operators see a task on the live wire that the snapshot never confirms
  # existed. Deliberately NOT relaxed for "trusted" wrappers — #175's
  # lesson (declared/self-reported values are forgeable) applies here too.
  defp validate_task_payload(%{"agent_id" => payload_agent_id} = payload, agent_id)
       when payload_agent_id == agent_id do
    with :ok <- require_task_field(payload, "task_id", @max_task_id_field_bytes),
         :ok <- require_task_field(payload, "task_type"),
         :ok <- require_task_kind_status(payload),
         :ok <- validate_tasklist_payload(payload) do
      :ok
    end
  end

  defp validate_task_payload(payload, _agent_id) when is_map(payload),
    do: {:error, "payload.agent_id does not match topic"}

  defp validate_task_payload(_payload, _agent_id), do: {:error, "payload must be an object"}

  defp require_task_field(payload, field, max_bytes \\ nil) do
    case Map.get(payload, field) do
      v when is_binary(v) and v != "" and (is_nil(max_bytes) or byte_size(v) <= max_bytes) ->
        :ok

      _ ->
        {:error, "invalid value: payload.#{field}"}
    end
  end

  defp require_task_kind_status(%{"kind" => kind, "status" => status}) do
    case {kind, status} do
      {k, "running"} when k in ["started", "updated"] -> :ok
      {"completed", s} when s in ["completed", "failed", "stopped"] -> :ok
      _ -> {:error, "invalid value: payload.kind/status combination"}
    end
  end

  defp require_task_kind_status(_payload), do: {:error, "invalid value: payload.kind"}

  # `tasklist` is one reserved entity per parent agent. Guard the reservation
  # both ways: accepting only the task_type -> task_id half would let an
  # ordinary child task deliberately use the fixed tasklist key and replace
  # the parent's todo snapshot in TaskStates.
  defp validate_tasklist_payload(
         %{
           "task_type" => "tasklist",
           "task_id" => "tasklist",
           "kind" => "updated",
           "status" => "running"
         } = payload
       ),
       do: validate_tasklist_contents(payload)

  # A tasklist is an LWW snapshot, not a child task lifecycle. In particular,
  # `completed` would erase this entity from TaskStates and make an empty list
  # indistinguishable from absent state, while `started` has no semantic role.
  defp validate_tasklist_payload(%{"task_type" => "tasklist", "task_id" => "tasklist"}),
    do: {:error, "tasklist requires payload.kind=updated and payload.status=running"}

  defp validate_tasklist_payload(%{"task_type" => "tasklist"}),
    do: {:error, "tasklist requires payload.task_id=tasklist"}

  defp validate_tasklist_payload(%{"task_id" => "tasklist"}),
    do: {:error, "payload.task_id=tasklist requires payload.task_type=tasklist"}

  defp validate_tasklist_payload(_payload), do: :ok

  # An empty array is valid: it is the LWW update that says this parent has no
  # todo items right now. `omitted`, when present, is a structured aggregate
  # rather than a fake display item so the dashboard can retain an honest
  # completed/total count even after wrapper-side truncation.
  defp validate_tasklist_contents(%{"items" => items} = payload) when is_list(items) do
    with :ok <- validate_tasklist_item_count(items),
         :ok <- validate_tasklist_items(items),
         :ok <- validate_tasklist_items_json_size(items),
         :ok <- validate_tasklist_omitted(payload) do
      :ok
    end
  end

  defp validate_tasklist_contents(_payload), do: {:error, "invalid value: payload.items"}

  defp validate_tasklist_item_count(items) when length(items) <= @max_tasklist_items, do: :ok

  defp validate_tasklist_item_count(_items),
    do: {:error, "payload.items exceeds tasklist item limit"}

  defp validate_tasklist_items(items) do
    if Enum.all?(items, &valid_tasklist_item?/1) do
      :ok
    else
      {:error, "invalid value: payload.items"}
    end
  end

  defp valid_tasklist_item?(%{"text" => text, "status" => status})
       when is_binary(text) and byte_size(text) <= @max_tasklist_item_text_bytes and
              status in ["pending", "in_progress", "completed"],
       do: true

  defp valid_tasklist_item?(_item), do: false

  # JSON byte length, rather than raw text byte lengths, is the real wire
  # bound: quotes/backslashes grow when Jason escapes them. `Jason.encode/1`
  # also keeps a direct caller with an otherwise-unencodable test value from
  # crashing the channel process.
  defp validate_tasklist_items_json_size(items) do
    case Jason.encode(items) do
      {:ok, json} when byte_size(json) <= @max_tasklist_items_json_bytes -> :ok
      {:ok, _json} -> {:error, "payload.items exceeds tasklist JSON byte limit"}
      {:error, _reason} -> {:error, "invalid value: payload.items"}
    end
  end

  defp validate_tasklist_omitted(%{"omitted" => omitted})
       when is_map(omitted) do
    case omitted do
      %{"count" => count, "completed" => completed}
      when is_integer(count) and count > 0 and is_integer(completed) and completed >= 0 and
             completed <= count ->
        :ok

      _ ->
        {:error, "invalid value: payload.omitted"}
    end
  end

  defp validate_tasklist_omitted(_payload), do: :ok

  defp fetch_reset_mode(%{"mode" => mode}) when mode in @session_reset_modes,
    do: {:ok, mode}

  defp fetch_reset_mode(_payload), do: {:error, :invalid_mode}

  # The reason never enters an instruction or runner payload. Bound it by the
  # channel's established inbound frame limit before copying it only to the
  # operator-gated lifecycle broadcast.
  defp fetch_reset_reason(%{"reason" => reason})
       when is_binary(reason) and byte_size(reason) <= @max_envelope_bytes,
       do: {:ok, reason}

  defp fetch_reset_reason(%{"reason" => _}), do: {:error, {:invalid_value, "reason"}}
  defp fetch_reset_reason(payload) when is_map(payload), do: {:ok, nil}

  # `session_reset_request` is a control wire, not a human-facing form: its
  # reply reason must stay in ADR-0036 F7's fixed lifecycle vocabulary. A
  # malformed mode/reason cannot safely be more specific without adding a new
  # wire word, so it fails closed as an unsupported reset request.
  defp reset_request_reason(reason)
       when reason in [
              :agent_busy,
              :session_reset_pending,
              :unsupported_session_reset,
              :runner_unavailable
            ],
       do: Atom.to_string(reason)

  defp reset_request_reason(_reason), do: "unsupported_session_reset"

  defp fetch_reset_envelope(agent_id) do
    case AgentStates.snapshot()[agent_id] do
      envelope when is_map(envelope) -> {:ok, envelope}
      _ -> {:error, :unsupported_session_reset}
    end
  end

  defp fetch_kaoiro_state(%{"state" => state}) when is_binary(state), do: {:ok, state}
  defp fetch_kaoiro_state(_envelope), do: {:error, :agent_busy}

  defp require_reset_capability(envelope, mode) do
    caps = envelope |> Map.get("ext", %{}) |> Map.get("session_capabilities")

    with true <- is_map(caps),
         true <- Map.get(caps, "supports_session_reset") == true,
         modes when is_list(modes) and modes != [] <- Map.get(caps, "session_reset_modes"),
         true <- mode in modes do
      :ok
    else
      _ -> {:error, :unsupported_session_reset}
    end
  end

  defp started_reset_payload(agent_id, mode, request_id, previous_session_id, reason) do
    %{
      "request_id" => request_id,
      "agent_id" => agent_id,
      "mode" => mode,
      "origin" => "agent_self"
    }
    |> maybe_put_previous_session_id(previous_session_id)
    |> maybe_put_reason(reason)
  end

  defp maybe_put_previous_session_id(payload, sid) when is_binary(sid),
    do: Map.put(payload, "previous_session_id", sid)

  defp maybe_put_previous_session_id(payload, _sid), do: payload

  defp maybe_put_reason(payload, reason) when is_binary(reason),
    do: Map.put(payload, "reason", reason)

  defp maybe_put_reason(payload, _reason), do: payload

  defp maybe_put_resume_snapshot(payload, agent_id) do
    case SessionPointers.get(agent_id) do
      %{snapshot: snapshot} when is_map(snapshot) -> Map.put(payload, "resume_snapshot", snapshot)
      _ -> payload
    end
  end

  # Decides whether an inter_agent_message may be accepted, WITHOUT
  # projecting or routing anything (ADR-0051 D3-1 step 1). Every reject
  # this server can produce for an IA is decided here, so the caller can
  # rely on "past this point the message is accepted" before it touches a
  # pane. Other types pass through as `:not_inter_agent`.
  #
  # `ConversationStates.record_message/6` checks the quota AND advances
  # the counters in one GenServer call. protocol-inter-agent lists the
  # counter update after the projection, but splitting the call to match
  # that order would open a TOCTOU between check and update — the quota
  # is one of the reject-deciding checks, so the atomic call belongs
  # here. The hard requirement (no reject-able check after the upsert)
  # holds either way.
  #
  # On quota overshoot the message still routes and is still displayed
  # (full observability); the escalate notice is returned for the caller
  # to emit after the projection, since it is a consequence of accepting,
  # not a reject.
  defp preflight_inter_agent(
         %{"type" => "inter_agent_message", "payload" => payload},
         from
       ) do
    to = payload["to"]
    cid = payload["conversation_id"]
    body = payload["body"] || ""
    turn_number = payload["turn_number"]
    done? = get_in(payload, ["meta", "done"]) == true

    cond do
      to == from ->
        {:error, :self_routing}

      not AgentStates.known?(to) ->
        {:error, :unknown_agent}

      true ->
        case ConversationStates.record_message(cid, from, to, body, turn_number, done?) do
          # Within limits. `:both_done` means every participating agent has
          # now signalled done; the tracker has already closed the entry
          # into a tombstone atomically (issue #177; spec MUST: 両
          # owner-side done で対話完了). No extra close needed.
          ok when ok in [:ok, :both_done] ->
            {:ok, {:accept, to, nil}}

          {:exceeded, reason} ->
            {:ok, {:accept, to, {cid, from, to, reason}}}

          # Cross-conversation pollution attempt or global cap reached:
          # reject the envelope at the routing boundary so a third party
          # cannot wipe the legitimate participants' counters by reusing
          # their conversation_id, and so a malicious flood of fresh cids
          # cannot grow the tracker without bound.
          {:error, reason} ->
            {:error, reason}
        end
    end
  end

  defp preflight_inter_agent(_envelope, _from), do: {:ok, :not_inter_agent}

  defp push_to_wrapper(to, envelope) do
    KaoiroServerWeb.Endpoint.broadcast("wrapper:#{to}", "envelope", envelope)
  end

  # Synthesizes a server-derived escalate-to-user envelope (agent_id=server)
  # so both wrappers and every operator dashboard see the auto-termination.
  # The envelope is recipient-addressed: each side gets its own envelope with
  # payload.to == that recipient so (a) any future receiver-side payload.to
  # self-check works, and (b) each recipient's wrapper records it in its own
  # sidecar and restores it into its own pane.
  defp broadcast_escalate({cid, from, to, reason}) do
    ts = DateTime.utc_now() |> DateTime.to_iso8601()

    for recipient <- [from, to] do
      deliver_synth_inter_agent(recipient, synth_escalate_envelope(cid, recipient, reason, ts))
    end
  end

  defp synth_escalate_envelope(cid, recipient, reason, ts) do
    synth_inter_agent_envelope(
      %{
        "to" => recipient,
        "conversation_id" => cid,
        "turn_number" => 0,
        "kind" => "escalate-to-user",
        "body" => "conversation auto-terminated: #{reason}",
        "meta" => %{"done" => true, "propose_next" => ""},
        "owner" => %{"kind" => "user", "id" => "system"}
      },
      ts
    )
  end

  # Tells the peers still in an open conversation with the leaving wrapper
  # that this agent became unreachable, so the sender agent can tell a real
  # failure from a plain reply_pending timeout (protocol-inter-agent
  # 「応答不能エラーの通知」, issue #131). The notice is server-derived: it
  # is NOT recorded against the conversation's turn/token budget, and the
  # entry stays so a reconnecting wrapper can resume the same
  # conversation_id (stale entries fall to the existing wallclock GC).
  #
  # The tracker hands out each conversation ONCE per disconnect and only
  # re-arms it when the agent speaks there again, so a crash-looping
  # wrapper cannot re-inject the same notice into its peers' turns every
  # few seconds. `@max_unreachable_notices` additionally bounds the burst:
  # every notice costs two Endpoint broadcasts (one of them fanned out to
  # every dashboard), and a wrapper may hold far more open conversations
  # than it has live peers.
  defp broadcast_peer_unreachable(agent_id, ts) do
    message = "peer #{agent_id} is unreachable: wrapper disconnected"

    {targets, unclaimed} =
      ConversationStates.claim_unreachable_targets(agent_id, @max_unreachable_notices)

    for {cid, peers} <- targets, peer <- peers do
      deliver_synth_inter_agent(peer, synth_unreachable_envelope(cid, peer, message, ts))
    end

    if unclaimed > 0 do
      Logger.warning(
        "disconnect notice cap hit for #{agent_id}: " <>
          "#{unclaimed} conversation(s) left unnotified"
      )
    end

    :ok
  end

  # kind stays within the 9-value enum ("inform"); `payload.error` is the
  # discriminator and `body` repeats the reason for older receivers that
  # do not read it. meta.done is false — whether to end the conversation is
  # the receiving agent's call (spec Phase 1).
  defp synth_unreachable_envelope(cid, recipient, message, ts) do
    synth_inter_agent_envelope(
      %{
        "to" => recipient,
        "conversation_id" => cid,
        "turn_number" => 0,
        "kind" => "inform",
        "body" => message,
        "error" => %{"code" => "disconnected", "message" => message},
        "meta" => %{"done" => false, "propose_next" => ""},
        "owner" => %{"kind" => "user", "id" => "system"}
      },
      ts
    )
  end

  # Server-synthesized IA (agent_id="server") reaches exactly one pane —
  # the recipient's (ADR-0051 D3-1). There is no sender pane to mirror it
  # into: "server" holds no transcript, and the peer named in the notice
  # is precisely the side that could not receive it. The stamp is
  # allocated the same way a live accept allocates one, so the notice
  # sorts and clear-filters identically and the recipient's wrapper can
  # record it verbatim in its sidecar.
  defp deliver_synth_inter_agent(recipient, envelope) do
    stamp = IngressOrder.allocate()
    stamped = Map.put(envelope, "ingress_stamp", encode_stamp(stamp))
    _ = AgentStates.upsert_ia(recipient, stamp, stamped)
    KaoiroServerWeb.Endpoint.broadcast("wrapper:#{recipient}", "envelope", stamped)
    KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", stamped)
    :ok
  end

  # Ingress stamps are Elixir 2-tuples but must survive JSON, so the wire
  # form is a 2-element integer array (ADR-0051 D3-4 / protocol.md). Same
  # shape everywhere: delivered envelope, acceptance ack, sidecar row,
  # `replay_ia` item.
  defp encode_stamp({us, seq}), do: [us, seq]

  defp decode_stamp([us, seq]) when is_integer(us) and is_integer(seq), do: {:ok, {us, seq}}
  defp decode_stamp(_), do: :error

  defp synth_inter_agent_envelope(payload, ts) do
    %{
      "version" => "0",
      "agent_id" => "server",
      # Synthesized server-side, no real persona — include a sentinel so the
      # envelope frame stays consistent with the Envelope contract
      # (protocol/src/index.ts; persona is a required frame field).
      "persona" => %{"id" => "server", "name" => "server", "sprite_set" => "server"},
      "ts" => ts,
      "type" => "inter_agent_message",
      "state" => "idle",
      "payload" => payload,
      "ext" => %{}
    }
  end

  # One restored row. Everything about it is untrusted host-local data, so
  # each step fails CLOSED (drop the row, keep replaying the rest):
  #  - a missing / malformed stamp cannot be re-derived, and falling back
  #    to the wrapper's wire `ts` would re-introduce the clock-skew bug
  #    the ingress-order domain exists to kill (D3-4);
  #  - a row already hidden by this pane's clear watermark must not come
  #    back;
  #  - a structurally invalid envelope must not enter the projection the
  #    live path validates on the way in.
  # Deliberately NO `agent_id == topic` check: a receiver pane legitimately
  # holds envelopes authored by the peer or by "server".
  defp replay_ia_item(pane_agent_id, %{"envelope" => envelope, "ingress_stamp" => raw}, bound)
       when is_map(envelope) do
    with {:ok, stamp} <- decode_stamp(raw),
         :ok <- validate_replayed_envelope(envelope),
         false <- ClearWatermarks.hidden?(bound, stamp, envelope) do
      _ = AgentStates.upsert_ia(pane_agent_id, stamp, envelope)

      # ADR-0051 D3-3 追補: a dashboard that was ALREADY connected when the
      # replay ran has just been told to drop its IA (`history_reset` now
      # sends `preserve_inter_agent: false`), and nothing else would ever
      # put them back before an F5 — the projection upsert alone is
      # invisible to a live client. This is display fan-out only, none of
      # the routing D3-3 forbids.
      #
      # ふじ 30-10 must-fix M2: it rides its OWN event carrying the pane,
      # not the ordinary `envelope`. An `envelope` has no pane field, so the
      # client widens it to `agent_id ∪ payload.to` — which drops a restored
      # row into an offline peer's pane that a reload does NOT show, and
      # crosses the own-pane boundary the per-pane projection exists to
      # draw. The pane here is the replaying wrapper's channel assign; the
      # payload never gets a say in it.
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_replay_envelope", %{
        "pane_agent_id" => pane_agent_id,
        "envelope" => envelope
      })

      :ok
    else
      _ -> :ok
    end
  end

  defp replay_ia_item(_pane_agent_id, _item, _bound), do: :ok

  defp validate_replayed_envelope(envelope) do
    cond do
      missing = Enum.find(@frame_keys, &(not Map.has_key?(envelope, &1))) ->
        {:error, "missing key: #{missing}"}

      envelope["type"] != "inter_agent_message" ->
        {:error, "invalid value: type"}

      :erlang.external_size(envelope) > @max_envelope_bytes ->
        {:error, "envelope too large"}

      true ->
        validate_inter_agent_payload(envelope["payload"])
    end
  end

  # Structural check on the inter-agent payload. The body text is left
  # opaque per protocol-inter-agent spec; only the routing/quota fields
  # need to be present and well-shaped.
  defp validate_inter_agent_payload(%{} = payload) do
    cond do
      not is_binary(payload["to"]) or not AgentId.valid?(payload["to"]) ->
        {:error, "invalid value: payload.to"}

      not Map.has_key?(payload, "conversation_id") ->
        {:error, "missing key: payload.conversation_id"}

      not is_binary(payload["conversation_id"]) ->
        {:error, "invalid value: payload.conversation_id"}

      not Map.has_key?(payload, "turn_number") ->
        {:error, "missing key: payload.turn_number"}

      not is_integer(payload["turn_number"]) ->
        {:error, "invalid value: payload.turn_number"}

      payload["kind"] not in @inter_agent_kinds ->
        {:error, "invalid value: payload.kind"}

      not Map.has_key?(payload, "body") ->
        {:error, "missing key: payload.body"}

      not is_binary(payload["body"]) ->
        {:error, "invalid value: payload.body"}

      not valid_inter_agent_meta?(payload["meta"], payload["kind"]) ->
        {:error, "invalid value: payload.meta"}

      not valid_inter_agent_owner?(payload["owner"]) ->
        {:error, "invalid value: payload.owner"}

      not valid_inter_agent_error?(payload["error"]) ->
        {:error, "invalid value: payload.error"}

      true ->
        :ok
    end
  end

  defp validate_inter_agent_payload(_), do: {:error, "missing key: payload"}

  defp valid_inter_agent_meta?(%{"done" => done, "propose_next" => pn} = meta, "reject")
       when is_boolean(done) and is_binary(pn) do
    is_binary(meta["reject_reason"]) and meta["reject_reason"] != ""
  end

  defp valid_inter_agent_meta?(%{"done" => done, "propose_next" => pn}, _kind)
       when is_boolean(done) and is_binary(pn),
       do: true

  defp valid_inter_agent_meta?(_meta, _kind), do: false

  defp valid_inter_agent_owner?(%{"kind" => kind, "id" => id})
       when kind in ["user", "agent"] and is_binary(id),
       do: true

  defp valid_inter_agent_owner?(_), do: false

  # Optional 応答不能 notice (#131). Absent on ordinary messages. Shape only:
  # `code` is an open string whose meaning belongs to the receiving agent,
  # not to the server (protocol-inter-agent Constraints carve-out).
  defp valid_inter_agent_error?(nil), do: true

  defp valid_inter_agent_error?(%{"code" => code, "message" => message}),
    do: is_binary(code) and code != "" and is_binary(message)

  defp valid_inter_agent_error?(_), do: false
end
