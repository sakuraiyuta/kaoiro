defmodule KaoiroServerWeb.WrapperChannel do
  @moduledoc """
  Ingests envelopes from one wrapper (topic `wrapper:<agent_id>`), stores
  the latest state, and fans them out to clients (`agents:lobby`). An
  envelope's `session_id` (once the wrapper reports one) also refreshes
  the agent's restart-surviving pointer (ADR-0014 F1, issue #49).

  Validation covers only the envelope v0 frame keys; per ADR-0010 the
  payload stays opaque to the server (agent-agnostic relay). Joins are
  gated by the per-agent_id token list (ADR-0011); on terminate the
  server derives a planned `reconnecting` or unexpected `disconnected`
  envelope (specs/protocol.md). An exact-token join after a planned cycle
  derives the ordinary `reconnected` inform. Server →
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
  alias KaoiroServer.DeliveryStates
  alias KaoiroServer.IngressOrder
  alias KaoiroServer.PersonaAssets
  alias KaoiroServer.PlannedDisconnects
  alias KaoiroServer.SessionPointers
  alias KaoiroServer.SessionResets
  alias KaoiroServer.SessionStarts
  alias KaoiroServer.TaskStates
  alias KaoiroServer.TokenDenylist
  alias KaoiroServerWeb.AgentId
  alias KaoiroServerWeb.PeerConnectivity
  alias KaoiroServerWeb.SynthEnvelope

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

  # Bound on one `replay_ia` push (ADR-0051 D3-3). The final projection is
  # capped at 200 anyway (D6), so a larger batch could only ever be
  # discarded — refusing to walk it keeps a malformed / hostile sidecar
  # from costing an unbounded scan.
  @max_replay_ia_items 200

  # ADR-0015 stage 2: every wrapper -> server event is classified here
  # before its individual handler runs. A new handler cannot opt out of the
  # receiver rule by simply omitting a local warning call.
  @wrapper_event_policy %{
    "delivery_ack" => :versioned,
    "delivery_status_request" => :versioned,
    "directory_request" => :versioned,
    "history_reset" => :versioned,
    "history_replay_complete" => :versioned,
    "replay_ia" => :versioned,
    "session_reset_request" => :versioned,
    "envelope" => :envelope_frame
  }

  def wrapper_event_policy, do: @wrapper_event_policy

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
      delivery = bind_delivery(agent_id, params)
      # Drop the raw token once verified so it cannot leak via crash
      # logs / socket inspection.
      send(self(), :after_join)

      # ADR-0051 D2: the join REPLY is the hydration handshake. There is no
      # dedicated S→W event because a reconnect is always a fresh join, so
      # the verdict always has a join to ride. Allocating the attempt here
      # (rather than in :after_join) keeps it inside the same message the
      # wrapper is already waiting on, so the wrapper never has to guess
      # whether a verdict is still coming.
      reply =
        %{"hydration" => hydration_verdict(agent_id)}
        |> maybe_put_optional_field("delivery", delivery)

      {:ok, reply,
       socket
       |> assign(:agent_id, agent_id)
       |> assign(:persona_id, persona_id)
       |> assign(:transition_id, transition_id)
       |> assign(:wrapper_token, nil)}
    else
      {:error, reason} -> {:error, %{reason: to_string(reason)}}
    end
  end

  # `transition_id` identifies a session transition, not a wrapper process:
  # runner crash relaunch intentionally reuses it.  The random generation is
  # therefore the only lifetime identity for #247's dispatch observation.
  defp bind_delivery(agent_id, %{
         "inter_agent_delivery_ack" => "dispatch-v1",
         "delivery_generation" => generation
       })
       when is_binary(generation) and byte_size(generation) in 1..128 do
    DeliveryStates.bind(agent_id, generation)
  end

  defp bind_delivery(agent_id, _params) do
    :ok = DeliveryStates.disarm(agent_id)
    nil
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
          # ADR-0015 (issue #218): flat `version` frame key, like the
          # `persona_sync` / `display_name_sync` pushes below.
          push(socket, "persona_prompt", %{version: "0", prompt: prompt})

        nil ->
          # The join gate accepted this persona_id, but the pack has since
          # gone from the manifest (rebuild between join and after_join).
          # Fail closed by refusing the prompt — the wrapper's spawn
          # timeout will surface it.
          :ok
      end

      case KaoiroServer.PermissionModes.get(socket.assigns.agent_id) do
        mode when is_binary(mode) ->
          # ADR-0015 (issue #218): flat `version` frame key. The live relay
          # of this same event (`agents_channel.ex`'s `relay/5`) stamps it
          # server-side too, so the wrapper sees the same shape from both
          # producers.
          push(socket, "set_permission_mode", %{version: "0", mode: mode})

        _ ->
          :ok
      end

      push_persona_sync(socket, agent_id)
      broadcast_delivery_status(agent_id)
      _ = PeerConnectivity.confirm_connection(agent_id, transition_id)

      :ok
    end
  end

  # issue #197 段階3 (D14 acceptance 1): pushes the AUTHORITATIVE current
  # display_name + revision from `AgentDirectory` every join (fresh
  # connect AND reconnect alike), unconditionally — not only when it
  # differs from what the wrapper last applied. This is what closes the
  # race a bare `join/3`-time read would leave open: reading
  # AgentDirectory inside `join/3` itself (BEFORE this channel process's
  # PubSub subscription to `wrapper:<agent_id>` is guaranteed live) could
  # miss a `rename_agent` broadcast that lands in the gap between the
  # read and the subscribe. Running from `handle_info(:after_join, ...)`
  # — the same idiom this module already uses for the
  # `TokenDenylist.revoked?/1` re-check above (ふじ R1-race must-fix,
  # 2026-07-23) — guarantees the subscription is live first, so a
  # `rename_agent` racing this push is either seen here (AgentDirectory
  # already reflects it) or arrives moments later as its own sync
  # broadcast; either way nothing is lost. The wrapper's own revision
  # check (issue #197 段階3, `AgentHost`/`CodexHost` `applyPersonaSync`/
  # `applyDisplayNameSync`) makes this push idempotent against a live
  # relay arriving in either order (D15) — sending it unconditionally on
  # every join is simpler and no less correct than tracking a
  # per-connection "did I already push this revision" flag server-side.
  #
  # issue #219 D22: DUAL-emits both `persona_sync` (legacy `name` key,
  # old wrapper builds) and `display_name_sync` (new `display_name` key)
  # at the SAME revision — same rationale as the live-relay dual-emit in
  # `agents_channel.ex`'s `rename_agent` handler. `AgentDirectory.get/1`
  # never returns canonical persona data anymore (issue #219 D19) —
  # `display_name` is a pure instance-state field, no join against
  # `PersonaAssets` needed here.
  defp push_persona_sync(socket, agent_id) do
    case AgentDirectory.get(agent_id) do
      %{display_name: display_name, revision: revision} ->
        # ADR-0015 (issue #197 段階3, ふじ MF-1 レビュー指摘): flat
        # version stamp, matching the live-relay pushes from
        # `agents_channel.ex`'s `rename_agent` handler.
        push(socket, "persona_sync", %{
          "version" => "0",
          "name" => display_name,
          "revision" => revision
        })

        push(socket, "display_name_sync", %{
          "version" => "0",
          "display_name" => display_name,
          "revision" => revision
        })

      nil ->
        # No AgentDirectory entry. For a normally-spawned agent this
        # branch should be unreachable: `AgentDirectory.record/4` is now
        # a synchronous `GenServer.call` that `agents_channel.ex`'s spawn
        # handler commits strictly BEFORE broadcasting `spawn` to the
        # runner (issue #219 D22 corollary), so by the time the runner
        # can launch this wrapper process and it joins here, the entry
        # already exists. Kept as a defensive no-op rather than a crash
        # for any path this ordering guarantee does not cover. Nothing
        # to sync; the wrapper keeps whatever display_name it was
        # launched with, which is correct here since a not-yet-recorded
        # agent has never been renamed.
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

  # ADR-0015 stage 2's only inbound funnel (issue #270 MF-2).
  @impl true
  def handle_in(event, payload, socket) do
    case Map.get(@wrapper_event_policy, event, :unknown) do
      :versioned -> warn_on_wrapper_version_mismatch(payload, event)
      :envelope_frame -> warn_on_envelope_version_mismatch(payload, event)
      :unknown -> :ok
    end

    handle_wrapper_in(event, payload, socket)
  end

  defp handle_wrapper_in("envelope", envelope, socket) do
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
  #
  # issue #269: also merges AgentDirectory (DETS-persisted, ADR-0030)
  # entries that have no live AgentStates envelope — the "落ちた peer"
  # case a server restart or AgentStates cleanup (issue #14) leaves behind.
  # Merged in-line (not a separate array) so persona-name resolution stays
  # one flow for send_to_agent. AgentStates wins on a duplicate agent_id
  # (S9); requester self-exclusion applies once, after the merge.
  defp handle_wrapper_in("directory_request", _payload, socket) do
    self_id = socket.assigns.agent_id
    activities = AgentActivity.snapshot()
    peer_index = ConversationStates.peer_index()
    deliveries = DeliveryStates.all()
    states = AgentStates.snapshot()

    live =
      Enum.map(states, fn {id, env} ->
        directory_entry(
          id,
          env,
          Map.get(activities, id),
          Map.get(peer_index, id, []),
          Map.get(deliveries, id)
        )
      end)

    # issue #269 仕様5: AgentStates 側を優先。同一 agent_id を重複させない。
    directory_only =
      AgentDirectory.all()
      |> Map.drop(Map.keys(states))
      |> Enum.map(fn {id, entry} ->
        directory_only_entry(id, entry, Map.get(peer_index, id, []))
      end)
      |> Enum.reject(&is_nil/1)

    # issue #269 仕様5 / S9: requester 除外は合流後にここ 1 箇所だけ
    # (live / directory_only の両方をこの 1 箇所でカバーする)。
    #
    # ふじ MF-1: この除外を N=32 の cap より前に置く。requester 自身が
    # AgentDirectory にのみ存在する窓 (AgentStates 未登録、例えば spawn
    # 直後に自分の初回 envelope をまだ送っていない状態) では、cap を
    # 先にかけると self が枠を 1 つ消費してから落ち、真の eligible peer
    # 数より少なく返る事故になる (33 件 eligible のとき 31 件しか返らない
    # など)。self reject → directory_only 印付きのみを 32 件で cap、の
    # 順にすることでこれを閉じる。
    merged = Enum.reject(live ++ directory_only, &(&1["agent_id"] == self_id))
    {directory_only_kept, live_kept} = Enum.split_with(merged, &(&1["directory_only"] == true))
    agents = live_kept ++ bound_directory_only(directory_only_kept, self_id)

    {:reply, {:ok, %{"agents" => agents, "users" => users_projection()}}, socket}
  end

  defp handle_wrapper_in("delivery_status_request", _payload, socket) do
    reply =
      %{}
      |> maybe_put_optional_field("delivery", DeliveryStates.get(socket.assigns.agent_id))

    {:reply, {:ok, reply}, socket}
  end

  defp handle_wrapper_in("delivery_ack", %{"delivery_seq" => seq}, socket)
       when is_integer(seq) and seq > 0 do
    status = DeliveryStates.ack(socket.assigns.agent_id, seq)
    broadcast_delivery_status(socket.assigns.agent_id)
    {:reply, {:ok, %{"delivery" => status}}, socket}
  end

  defp handle_wrapper_in("delivery_ack", _payload, socket) do
    {:reply, :ok, socket}
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
  defp handle_wrapper_in("history_reset", payload, socket) do
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
  defp handle_wrapper_in("history_replay_complete", %{"replay_id" => replay_id}, socket)
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

  defp handle_wrapper_in("history_replay_complete", _payload, socket) do
    {:reply, :ok, socket}
  end

  # Display-replay-only IA ingress (ADR-0051 D3-3). Deliberately NOT the
  # ordinary `envelope` route: that one runs `route_inter_agent`, which
  # would re-push to the peer wrapper and re-inject into its SDK — turning
  # a history restore into a re-run of the conversation. Here the ONLY
  # effect is a per-pane projection upsert; routing, ConversationStates,
  # peer pushes and SDK injection are all untouched.
  #
  # The pane is bound to the channel topic, so a wrapper can only ever
  # restore its own pane — the payload cannot name another agent's.
  defp handle_wrapper_in(
         "replay_ia",
         %{"replay_id" => replay_id, "items" => items},
         socket
       )
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

  defp handle_wrapper_in("replay_ia", _payload, socket) do
    {:reply, {:error, %{reason: "invalid value: replay_ia"}}, socket}
  end

  # ADR-0043 D1/D3: a wrapper may request a reset only for its own agent,
  # after its MCP tool has been broker-approved and after the wrapper has
  # reached its turn boundary. The request does not re-parse model text and
  # joins the exact SessionResets gate used by operator `session_reset`.
  defp handle_wrapper_in("session_reset_request", payload, socket) do
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
           ),
         :ok <- begin_planned_reset(agent_id, request_id) do
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

      # Acceptance reserves a server-side reset transaction but is not its
      # completion. Return its correlation id so this old wrapper can match a
      # later terminal failure if the runner cannot actually replace it (#258).
      {:reply, {:ok, %{request_id: request_id}}, socket}
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

    {recipient_envelope, delivery_changed?} =
      case DeliveryStates.issue(to) do
        seq when is_integer(seq) -> {Map.put(stamped, "delivery_seq", seq), true}
        nil -> {stamped, false}
      end

    _ = AgentStates.upsert_ia(to, stamp, recipient_envelope)

    push_to_wrapper(to, recipient_envelope)
    if delivery_changed?, do: broadcast_delivery_status(to)
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
  # admin is a valid role, so it must not be dropped as an unknown one:
  # the `nil` catch-all below discards the WHOLE entry (user_entry/1), and
  # a missing clause here would silently remove every admin from the
  # projection while operators and viewers came through.
  #
  # This is NOT ADR-0050 D2's non-hideability. D2 says an admin's OWN
  # visibility cannot be restricted by the per-pair graph — nothing can be
  # hidden from an admin. That is a different axis from whether users are
  # projected to agents at all: `KAOIRO_EXPOSE_USERS_TO_AGENTS=false`
  # legitimately hides every user, admins included.
  defp role_string(:admin), do: "admin"
  defp role_string(_other), do: nil

  defp directory_entry(id, envelope, activity, peers, delivery) do
    persona =
      case envelope do
        %{"persona" => %{} = p} -> Map.take(p, ["id", "name", "sprite_set"])
        _ -> %{}
      end

    # issue #219 D19/D26 (ADR-0021 F6-3): `display_name` rides the same
    # envelope top-level field this module's after-join persona_sync/
    # display_name_sync pushes keep in sync (see `push_persona_sync/2`),
    # so it is always fresh for a live agent. `persona{id,name,sprite_set}`
    # above stays the pack canonical value — unaffected by rename
    # (issue #219 D19) — so a peer sees BOTH the stable identity and the
    # current, possibly-renamed, label. Absent only for a not-yet-updated
    # legacy wrapper build; `maybe_put_directory_field/3` drops the key
    # entirely rather than emitting an empty string.
    #
    # advisory (issue #219, クロエ実測検証): reuses `valid_display_name/1`
    # — the same 1-64-grapheme / no-control-char bound `user_entry/1`
    # already applies to a user's `display_name` — rather than a bare
    # `is_binary/1` check. issue #219 made this field the UI label's
    # authoritative source while D24 tightened the pack `name` field's
    # own validation; leaving THIS projection unvalidated would have made
    # the authoritative label source the one unvalidated field in the
    # peer-directory contract. Not a regression (the prior `Map.take/2`
    # era did not validate `persona.name` either), but worth aligning now
    # that this field carries the weight D19 gave it. An out-of-bound
    # value (from a compromised/buggy wrapper) is dropped like an absent
    # one, not truncated or passed through.
    display_name =
      case envelope do
        %{"display_name" => name} ->
          case valid_display_name(name) do
            {:ok, trimmed} -> trimmed
            :error -> nil
          end

        _ ->
          nil
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
      |> maybe_put_directory_field("display_name", display_name)
      |> maybe_put_directory_field("engine", ext["engine"])
      |> maybe_put_directory_field("model", ext["model"])
      |> maybe_put_directory_field("effort", ext["effort"])
      |> Map.put("conversation", %{"active" => peers != [], "peers" => peers})

    entry = maybe_put_context(entry, ext)
    entry = maybe_put_rate_limits(entry, ext, id)

    entry
    |> put_activity_fields(id, envelope, activity)
    |> maybe_put_optional_field("inter_agent_delivery", delivery)
  end

  defp broadcast_delivery_status(agent_id) do
    case DeliveryStates.get(agent_id) do
      nil ->
        # No capability / legacy process means unknown, not healthy 0/0.
        # The dashboard still receives a deletion event so it cannot retain
        # a prior generation's watermark after the ledger is disarmed.
        KaoiroServerWeb.Endpoint.broadcast(
          "agents:lobby",
          "delivery_status",
          %{"agent_id" => agent_id}
        )

      status ->
        # ADR-0015 (issue #218): flat `version` frame key on the
        # wrapper-bound copy, same as `SynthEnvelope.deliver/2`'s.
        KaoiroServerWeb.Endpoint.broadcast(
          "wrapper:#{agent_id}",
          "delivery_status",
          Map.put(status, :version, "0")
        )

        KaoiroServerWeb.Endpoint.broadcast(
          "agents:lobby",
          "delivery_status",
          %{"agent_id" => agent_id, "delivery" => status}
        )
    end
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

  # directory-only entry (issue #269)。AgentStates に envelope を持たない
  # AgentDirectory エントリの射影。identity + last_seen + conversation だけを
  # 出し、engine / model / effort / context / rate_limits / session 系は
  # 載せない — 値が存在しないのであって「0」でも「健全」でもない
  # (absent = unknown の既存規約)。
  #
  # agent_id は AgentId.valid?/1 を通す (issue #269 S7): AgentDirectory の
  # DETS ロードは is_binary しか見ておらず、この経路が DETS 由来の id を
  # agent へ出す最初の経路になるため、user_entry/1 と同じ discipline を
  # ここで適用する。落ちたエントリは丸ごと drop。
  defp directory_only_entry(id, %{persona_id: persona_id} = entry, peers)
       when is_binary(id) do
    if AgentId.valid?(id) do
      display_name =
        case valid_display_name(Map.get(entry, :display_name)) do
          {:ok, trimmed} -> trimmed
          :error -> nil
        end

      %{
        "agent_id" => id,
        "persona" => directory_persona(persona_id),
        "state" => "disconnected",
        "directory_only" => true
      }
      |> maybe_put_directory_field("display_name", display_name)
      |> Map.put("conversation", %{"active" => peers != [], "peers" => peers})
      |> maybe_put_last_seen(Map.get(entry, :last_seen))
    else
      nil
    end
  end

  defp directory_only_entry(_id, _entry, _peers), do: nil

  # persona の typed unresolved (issue #219 D21)。
  # agents_channel.ex の join_directory_entry/1 と同じ規則 —
  # pack が解決すれば canonical、しなければ %{"id" => persona_id} を返し、
  # persona キー自体は必ず present にする (issue #269 S1)。
  # Map.take は F6-2 の nested allow-list 規律 (canonical map を素通しにしない)。
  defp directory_persona(persona_id) when is_binary(persona_id) do
    case PersonaAssets.get_persona(persona_id) do
      nil -> %{"id" => persona_id}
      canonical -> Map.take(canonical, ["id", "name", "sprite_set"])
    end
  end

  defp directory_persona(_persona_id), do: %{}

  # last_seen は memory-only hint (AgentDirectory 由来の unix 秒)。ISO8601
  # UTC に変換して既存の directory 時刻 field (session_started_at /
  # last_activity_at) と表現を揃える (issue #269 S5)。nil (server 再起動後
  # / 未 touch) や domain 外の値は field ごと省略する。
  defp maybe_put_last_seen(entry, ts)
       when is_integer(ts) and ts >= 0 and ts <= @max_safe_integer do
    case DateTime.from_unix(ts) do
      {:ok, dt} -> Map.put(entry, "last_seen", DateTime.to_iso8601(dt))
      {:error, _} -> entry
    end
  end

  defp maybe_put_last_seen(entry, _ts), do: entry

  # directory-only 分の件数上限 (issue #269 S6)。AgentDirectory は operator
  # が明示 delete するまで消えず、agent_id は spawn ごとに新規採番される
  # ため無制限に増える。過去の全 agent が毎回 model の context を食う構造を
  # 避けるため N=32 に切り、last_seen 降順 (unknown は最後尾、同着は
  # agent_id 昇順) で残す。切った件数は agent/request 単位で 1 行 warn
  # (既存の rate_limits drop 集約と同じ方針)。
  @directory_only_limit 32

  defp bound_directory_only(entries, agent_id) do
    sorted =
      Enum.sort_by(entries, fn e ->
        {-last_seen_sort_key(e), e["agent_id"]}
      end)

    {kept, dropped} = Enum.split(sorted, @directory_only_limit)

    if dropped != [] do
      Logger.warning(
        "directory-only projection capped at #{@directory_only_limit}; " <>
          "dropped #{length(dropped)} entr(ies) for #{agent_id}"
      )
    end

    kept
  end

  # sort key for bound_directory_only/2: unix seconds when `last_seen` is
  # present (larger = more recent), or -1 when absent so unknown entries
  # always sort after every known one (last_seen is always >= 0).
  defp last_seen_sort_key(%{"last_seen" => iso}) when is_binary(iso) do
    case DateTime.from_iso8601(iso) do
      {:ok, dt, _offset} -> DateTime.to_unix(dt)
      {:error, _} -> -1
    end
  end

  defp last_seen_sort_key(_entry), do: -1

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

  # Unlike the directory's optional display fields, delivery is a structured
  # status map. Keep `nil` absent (legacy wrapper means unknown), while
  # preserving the map verbatim for capability-aware clients.
  defp maybe_put_optional_field(entry, _key, nil), do: entry
  defp maybe_put_optional_field(entry, key, value), do: Map.put(entry, key, value)

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
        _ = PeerConnectivity.disconnect(agent_id, ts)

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
  #
  # `payload.new_conversation` (issue #262) is validated HERE, not in the
  # shared `validate_inter_agent_payload/1`, for the same reason: a stored
  # sidecar row from before this field existed must still replay.
  #
  # ABSENCE is allowed (review, クロエ M1) — only a present-but-non-boolean
  # value is rejected. Requiring the key would hard-reject every live send
  # from a wrapper that predates issue #262, and that population is not
  # hypothetical: the Phoenix client owns reconnect/heartbeat
  # (wrapper/core/src/transport.ts), so an old wrapper survives a server
  # deploy and keeps pushing without ever restarting. ADR-0015 already
  # covers exactly this shape of client/server skew (`version` field) with
  # best-effort accept, not a hard block — the same instance the codebase
  # already exercises live (`refresh_engine_catalog: client declared
  # protocol version (absent); relaying as "0"`). `preflight_inter_agent/2`
  # treats an absent value as `true` (with a one-time-per-message
  # `Logger.warning`, see `warn_legacy_new_conversation_absent/0`) — this
  # is now the ONLY place that permissive default is allowed to live.
  # `ConversationStates.record_message/8` deliberately does NOT default
  # `new_conversation?` (director ruling, issue #262 delta 2巡目): every
  # caller of that internal API, this one included, must state the value
  # explicitly, so a future caller cannot silently reproduce this same
  # bug through the internal API instead of the wire.
  defp validate_live_inter_agent_payload(payload) do
    with :ok <- validate_inter_agent_payload(payload) do
      cond do
        not (is_integer(payload["turn_number"]) and payload["turn_number"] > 0) ->
          {:error, "invalid value: payload.turn_number"}

        Map.has_key?(payload, "new_conversation") and
            not is_boolean(payload["new_conversation"]) ->
          {:error, "invalid value: payload.new_conversation"}

        true ->
          :ok
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

  defp begin_planned_reset(agent_id, request_id) do
    case PlannedDisconnects.begin(agent_id, request_id, :reset) do
      :ok ->
        :ok

      {:error, :agent_busy} = error ->
        # SessionResets allocates the request id and lock atomically with its
        # state/cooldown checks, so the planned-intent CAS necessarily comes
        # second. If another lifecycle command won that race, release exactly
        # this unrelayed reset before returning the established lifecycle
        # vocabulary to the requesting wrapper.
        _ = SessionResets.cancel(agent_id, request_id)
        error
    end
  end

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
    # issue #262: true when the SENDING wrapper's own conversation_id was
    # omitted by its caller and freshly allocated (see record_message/8) —
    # OR the field is simply absent, which this branch treats as a pre-#262
    # wrapper rather than a validation failure (review, クロエ M1). Only an
    # EXPLICIT `false` narrows this to "confirm the id already exists";
    # `validate_live_inter_agent_payload/1` already rejects a
    # present-but-non-boolean value, so the only two shapes reaching here
    # are absent, `true`, or `false`.
    new_conversation? =
      case payload do
        %{"new_conversation" => false} -> false
        %{"new_conversation" => true} -> true
        _ -> warn_legacy_new_conversation_absent()
      end

    cond do
      to == from ->
        {:error, :self_routing}

      not AgentStates.known?(to) ->
        {:error, :unknown_agent}

      true ->
        # Active detection and target registration are one state-machine
        # call. A concurrent close that wins makes this return :noop and the
        # message continues normally; peer_reconnecting is never returned
        # before its eventual close-notice target has been adopted.
        case KaoiroServerWeb.PeerConnectivity.track_bounce(to, cid, from) do
          {:tracked, _intent} ->
            {:error, :peer_reconnecting}

          {:capacity, _intent} ->
            # No target slot means no later close notice can be promised.
            # Keep this distinct from peer_reconnecting so the sender gets a
            # terminal tool rejection rather than waiting for a notice that
            # will deliberately never be emitted for this attempt.
            {:error, :peer_reconnecting_capacity}

          :noop ->
            case ConversationStates.record_message(
                   cid,
                   from,
                   to,
                   body,
                   turn_number,
                   done?,
                   new_conversation?
                 ) do
              # Within limits. `:both_done` means every participating agent
              # has now signalled done; the tracker has already closed the
              # entry into a tombstone atomically (issue #177; spec MUST: 両
              # owner-side done で対話完了). No extra close needed.
              ok when ok in [:ok, :both_done] ->
                {:ok, {:accept, to, nil}}

              {:exceeded, reason} ->
                {:ok, {:accept, to, {cid, from, to, reason}}}

              # Cross-conversation pollution attempt, global cap reached,
              # or an explicitly-named conversation_id with no entry at all
              # (issue #262): reject at the routing boundary.
              {:error, reason} ->
                {:error, reason}
            end
        end
    end
  end

  defp preflight_inter_agent(_envelope, _from), do: {:ok, :not_inter_agent}

  # Mirrors warn_relayed_version/3 in agents_channel.ex (ADR-0015 best-effort
  # accept) for the same shape of client/server skew: a wrapper that predates
  # issue #262 never learned to send `new_conversation`, and the Phoenix
  # client owns reconnect/heartbeat (wrapper/core/src/transport.ts), so such
  # a wrapper survives a server redeploy without restarting and keeps
  # pushing without the field. Not a hard limit on how long this is
  # honoured -- once every connected wrapper is confirmed to be issue-#262-
  # or-later, `validate_live_inter_agent_payload/1` can go back to requiring
  # the key (see protocol-inter-agent.md).
  defp warn_legacy_new_conversation_absent do
    Logger.warning(
      "inter_agent_message: client declared new_conversation (absent); " <>
        "accepting as true (issue #262 legacy best-effort accept)"
    )

    true
  end

  # ADR-0015 stage 2 receiver rule for wrapper -> server control messages.
  # A wrapper already authenticated for this topic may be an older build, so
  # absence and mismatch warn but never block its existing control flow.
  defp warn_on_wrapper_version_mismatch(%{"version" => "0"}, _event), do: :ok

  defp warn_on_wrapper_version_mismatch(%{"version" => version}, event) do
    Logger.warning(
      "#{event}: wrapper declared protocol version " <>
        inspect(version, printable_limit: 64, limit: 8) <>
        "; accepting as \"0\" (ADR-0015 best-effort accept)"
    )
  end

  defp warn_on_wrapper_version_mismatch(_payload, event) do
    Logger.warning(
      "#{event}: wrapper declared protocol version (absent); " <>
        "accepting as \"0\" (ADR-0015 best-effort accept)"
    )
  end

  # Envelope validation rejects a missing frame key before the payload can be
  # accepted. This only reports a present-but-skewed value, so malformed
  # envelopes do not produce a second, misleading best-effort warning.
  defp warn_on_envelope_version_mismatch(%{"version" => "0"}, _event), do: :ok

  defp warn_on_envelope_version_mismatch(%{"version" => version}, event) do
    Logger.warning(
      "#{event}: wrapper declared protocol version " <>
        inspect(version, printable_limit: 64, limit: 8) <>
        "; accepting as \"0\" (ADR-0015 best-effort accept)"
    )
  end

  defp warn_on_envelope_version_mismatch(_payload, _event), do: :ok

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
      SynthEnvelope.deliver(recipient, synth_escalate_envelope(cid, recipient, reason, ts))
    end
  end

  defp synth_escalate_envelope(cid, recipient, reason, ts) do
    SynthEnvelope.build(
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

  # Ingress stamps are Elixir 2-tuples but must survive JSON, so the wire
  # form is a 2-element integer array (ADR-0051 D3-4 / protocol.md). Same
  # shape everywhere: delivered envelope, acceptance ack, sidecar row,
  # `replay_ia` item. (Envelope building + delivery for server-synthesized
  # IA notices moved to `KaoiroServerWeb.SynthEnvelope` — issue #221 — but
  # `encode_stamp/1` stays here too since the live ingress path above
  # (`:619`) also needs it.)
  defp encode_stamp({us, seq}), do: [us, seq]

  defp decode_stamp([us, seq]) when is_integer(us) and is_integer(seq), do: {:ok, {us, seq}}
  defp decode_stamp(_), do: :error

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
