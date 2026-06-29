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

  alias KaoiroServer.AgentStates
  alias KaoiroServer.Auth
  alias KaoiroServer.ConversationStates
  alias KaoiroServer.SessionPointers
  alias KaoiroServerWeb.AgentId

  @frame_keys ~w(version agent_id ts type state)
  @inter_agent_kinds ~w(request response query inform propose accept reject escalate-to-user done)

  # Resource bound only; content/type refinement is Phase 1.5-4. Clients
  # must still treat all envelope strings as untrusted when rendering.
  @max_envelope_bytes 65_536

  @impl true
  def join("wrapper:" <> agent_id, _params, socket) do
    with :ok <- validate_agent_id(agent_id),
         :ok <- Auth.authorize_wrapper(agent_id, socket.assigns[:wrapper_token]),
         :ok <- reject_if_connected(agent_id) do
      # Drop the raw token once verified so it cannot leak via crash
      # logs / socket inspection.
      send(self(), :after_join)

      {:ok,
       socket
       |> assign(:agent_id, agent_id)
       |> assign(:wrapper_token, nil)}
    else
      {:error, reason} -> {:error, %{reason: to_string(reason)}}
    end
  end

  # Push the persisted permission_mode pick once the join completes (#58).
  # Phoenix Channels require push/3 to run after the join reply; send/2 +
  # handle_info is the standard idiom. Nothing happens when no mode was
  # persisted yet — the wrapper falls back to its config / `default`.
  @impl true
  def handle_info(:after_join, socket) do
    case KaoiroServer.PermissionModes.get(socket.assigns.agent_id) do
      mode when is_binary(mode) ->
        push(socket, "set_permission_mode", %{mode: mode})

      _ ->
        :ok
    end

    {:noreply, socket}
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
    with :ok <- validate(envelope, socket.assigns.agent_id),
         :ok <- route_inter_agent(envelope, socket.assigns.agent_id),
         :ok <- store(envelope) do
      record_session_pointer(envelope)
      # The full envelope (incl. operator-only log/result tool I/O) goes onto
      # agents:lobby unfiltered; role gating is per-subscriber in
      # AgentsChannel.handle_out. Invariant: ONLY AgentsChannel may subscribe
      # to this topic — any new subscriber MUST apply the same role gate
      # (#27, specs/threat-model.md).
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)
      {:reply, :ok, socket}
    else
      # A reply before any state (append_log :noop) has no snapshot entry
      # to anchor it; drop the live broadcast too so "latest state is
      # authoritative" holds (history was already not retained). Ack the
      # wrapper — it did nothing wrong.
      :noop ->
        {:reply, :ok, socket}

      {:error, reason} when is_atom(reason) ->
        {:reply, {:error, %{reason: to_string(reason)}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  # Resume history reconstruction (ADR-0014 phase-2, issue #50): the wrapper
  # is about to replay its JSONL-derived transcript as `log` envelopes, so it
  # first asks the server to drop the agent's current ring buffer (overwrite,
  # not append — a server that survived the crash still holds the same
  # session's pre-crash lines). Broadcast `history_reset` so every connected
  # operator clears its transcript before the replayed lines arrive
  # (operator-only gate in AgentsChannel). Empty payload; the topic carries
  # the agent_id. `:noop` (no state entry yet) is still acked — the wrapper
  # did nothing wrong.
  @impl true
  def handle_in("history_reset", _payload, socket) do
    agent_id = socket.assigns.agent_id

    case AgentStates.reset_history(agent_id) do
      :ok ->
        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_reset", %{
          "agent_id" => agent_id
        })

        {:reply, :ok, socket}

      :noop ->
        {:reply, :ok, socket}
    end
  end

  # log / result are reply transcript lines kept as history (ADR-0012);
  # state_change / permission_request refresh the latest state.
  defp store(%{"type" => type} = envelope) when type in ["log", "result"] do
    AgentStates.append_log(envelope)
  end

  # inter_agent_message envelopes carry the sender's wrapper state on the
  # outer frame (typically tool_running) but are NOT an authoritative state
  # update — they only route + observe. Skip the store so the agent's actual
  # latest state from state_change envelopes is not clobbered.
  defp store(%{"type" => "inter_agent_message"}), do: :ok

  defp store(envelope), do: AgentStates.put(envelope, owner: self())

  # Persist the agent's latest SDK session_id as a restart-surviving
  # pointer (ADR-0014 F1, issue #49). Only fires once the wrapper has
  # reported a real session_id; cwd rides along from ext when present.
  defp record_session_pointer(%{"agent_id" => agent_id, "session_id" => sid} = envelope)
       when is_binary(sid) and sid != "" do
    cwd =
      case envelope do
        %{"ext" => %{"cwd" => c}} when is_binary(c) -> c
        _ -> nil
      end

    SessionPointers.record(agent_id, sid, cwd)
  end

  defp record_session_pointer(_envelope), do: :ok

  @impl true
  def terminate(_reason, socket) do
    # Server-derived disconnected (specs/protocol.md). AgentStates only
    # applies it while this channel still owns the entry, so a stale
    # terminate after a reconnect cannot clobber the new state.
    ts = DateTime.utc_now() |> DateTime.to_iso8601()

    case AgentStates.disconnect(socket.assigns.agent_id, self(), ts) do
      {:ok, envelope} ->
        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      :noop ->
        :ok
    end
  end

  defp validate(envelope, agent_id) when is_map(envelope) do
    cond do
      missing = Enum.find(@frame_keys, &(not Map.has_key?(envelope, &1))) ->
        {:error, "missing key: #{missing}"}

      envelope["agent_id"] != agent_id ->
        {:error, "agent_id does not match topic"}

      :erlang.external_size(envelope) > @max_envelope_bytes ->
        {:error, "envelope too large"}

      envelope["type"] == "inter_agent_message" ->
        validate_inter_agent_payload(envelope["payload"])

      true ->
        :ok
    end
  end

  defp validate(_envelope, _agent_id), do: {:error, "envelope must be an object"}

  # Routes an inter_agent_message envelope to the destination wrapper after
  # checking per-conversation quotas (protocol-inter-agent spec). Other types
  # pass through. On quota overshoot, synthesizes an escalate-to-user envelope
  # for both participants and returns :ok so the original still broadcasts to
  # the dashboard for full observability.
  defp route_inter_agent(%{"type" => "inter_agent_message", "payload" => payload} = envelope, from) do
    to = payload["to"]
    cid = payload["conversation_id"]
    body = payload["body"] || ""
    done? = get_in(payload, ["meta", "done"]) == true

    cond do
      to == from ->
        {:error, :self_routing}

      not AgentStates.known?(to) ->
        {:error, :unknown_agent}

      true ->
        case ConversationStates.record_message(cid, from, to, body, done?) do
          # Within limits — relay to the destination wrapper. `:both_done`
          # means every participating agent has now signalled done; the
          # tracker has already dropped the entry atomically (spec MUST:
          # 両 owner-side done で対話完了). No extra close needed.
          ok when ok in [:ok, :both_done] ->
            push_to_wrapper(to, envelope)
            :ok

          {:exceeded, reason} ->
            push_to_wrapper(to, envelope)
            broadcast_escalate(cid, from, to, reason)
            :ok

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

  defp route_inter_agent(_envelope, _from), do: :ok

  defp push_to_wrapper(to, envelope) do
    KaoiroServerWeb.Endpoint.broadcast("wrapper:#{to}", "envelope", envelope)
  end

  # Synthesizes a server-derived escalate-to-user envelope (agent_id=server)
  # so both wrappers and every operator dashboard see the auto-termination.
  # The envelope is recipient-addressed: each side gets its own envelope with
  # payload.to == that recipient so (a) any future receiver-side payload.to
  # self-check works, and (b) the dashboard's transcript router (which keys
  # on agent_id ∪ payload.to) populates both transcripts.
  defp broadcast_escalate(cid, from, to, reason) do
    ts = DateTime.utc_now() |> DateTime.to_iso8601()

    for recipient <- [from, to] do
      envelope = synth_escalate_envelope(cid, recipient, reason, ts)
      KaoiroServerWeb.Endpoint.broadcast("wrapper:#{recipient}", "envelope", envelope)
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)
    end
  end

  defp synth_escalate_envelope(cid, recipient, reason, ts) do
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
      "payload" => %{
        "to" => recipient,
        "conversation_id" => cid,
        "turn_number" => 0,
        "kind" => "escalate-to-user",
        "body" => "conversation auto-terminated: #{reason}",
        "meta" => %{"done" => true, "propose_next" => ""},
        "owner" => %{"kind" => "user", "id" => "system"}
      },
      "ext" => %{}
    }
  end

  # Structural check on the inter-agent payload. The body text is left
  # opaque per protocol-inter-agent spec; only the routing/quota fields
  # need to be present and well-shaped.
  defp validate_inter_agent_payload(%{} = payload) do
    cond do
      not is_binary(payload["to"]) or not AgentId.valid?(payload["to"]) ->
        {:error, "invalid value: payload.to"}

      not is_binary(payload["conversation_id"]) ->
        {:error, "missing key: payload.conversation_id"}

      not is_integer(payload["turn_number"]) ->
        {:error, "missing key: payload.turn_number"}

      payload["kind"] not in @inter_agent_kinds ->
        {:error, "invalid value: payload.kind"}

      not is_binary(payload["body"]) ->
        {:error, "missing key: payload.body"}

      not valid_inter_agent_meta?(payload["meta"], payload["kind"]) ->
        {:error, "invalid value: payload.meta"}

      not valid_inter_agent_owner?(payload["owner"]) ->
        {:error, "invalid value: payload.owner"}

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
end
