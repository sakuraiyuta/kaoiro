defmodule KaoiroServerWeb.SynthEnvelope do
  @moduledoc """
  Builds and delivers server-synthesized `inter_agent_message` envelopes
  (`agent_id: "server"`, protocol-inter-agent spec's server-derived
  notices: hard-limit escalation, planned reconnect lifecycle,
  peer-unreachable, and — issue #221 — TTL auto-close propagation).

  Centralizing the envelope SHAPE here (rather than each call site building
  its own) is what keeps the Envelope contract's required fields
  (`protocol/src/index.ts`) from drifting between them: `display_name`
  went missing from exactly this shape before this module existed (issue
  #219 added it as a required frame field; the synth-envelope builder was
  never updated to match — caught and fixed as issue #221 direction 4).

  issue #221 D19-style boundary: `KaoiroServer.ConversationStates` (core)
  passes only DATA to its `:on_auto_closed` callback — conversation_id,
  participant agent_ids, close reason atom — never wire vocabulary
  (`kind` / `turn_number` / `owner` / `persona` / `display_name`). This
  module is where that data becomes an envelope; `ConversationStates`
  itself has zero `KaoiroServerWeb` dependency (kept, so its own test
  suite never needs to boot the web layer).
  """

  alias KaoiroServer.AgentStates
  alias KaoiroServer.DeliveryStates
  alias KaoiroServer.IngressOrder

  @doc """
  Builds one recipient-addressed synthetic envelope. `payload` must be a
  complete `inter_agent_message` payload map (including `"to"`); `ts` is
  the ISO timestamp stamped on the outer frame.
  """
  @spec build(map(), String.t()) :: map()
  def build(payload, ts) do
    %{
      "version" => "0",
      "agent_id" => "server",
      # Synthesized server-side, no real persona — sentinel so the
      # envelope frame stays consistent with the Envelope contract
      # (protocol/src/index.ts; persona AND display_name are both
      # required frame fields, issue #219).
      "persona" => %{"id" => "server", "name" => "server", "sprite_set" => "server"},
      "display_name" => "server",
      "ts" => ts,
      "type" => "inter_agent_message",
      "state" => "idle",
      "payload" => payload,
      "ext" => %{}
    }
  end

  @doc """
  Delivers one already-built envelope to `recipient`: allocates an ingress
  stamp, records it in the recipient's IA sidecar (`AgentStates.upsert_ia/3`
  so `replay_ia` can restore it after reconnect), and broadcasts to both the
  recipient's wrapper topic and the operator dashboard's lobby feed —
  matching the delivery this module's predecessor (`wrapper_channel.ex`'s
  private `deliver_synth_inter_agent/2`) always performed.
  """
  @spec deliver(String.t(), map()) :: :ok
  def deliver(recipient, envelope) do
    {us, seq} = stamp = IngressOrder.allocate()
    stamped = Map.put(envelope, "ingress_stamp", [us, seq])

    routed =
      case DeliveryStates.issue(recipient) do
        delivery_seq when is_integer(delivery_seq) ->
          Map.put(stamped, "delivery_seq", delivery_seq)

        nil ->
          stamped
      end

    _ = AgentStates.upsert_ia(recipient, stamp, routed)
    KaoiroServerWeb.Endpoint.broadcast("wrapper:#{recipient}", "envelope", routed)
    KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", stamped)
    status = DeliveryStates.get(recipient)

    # ADR-0015 (issue #218): the wrapper-bound copy carries the flat
    # `version` frame key like every other server -> wrapper message. The
    # `agents:lobby` copy below is server -> client and keeps its own shape
    # (`agent_id` + nested `delivery`) — that leg is a documented #218
    # follow-up, not part of this issue's scope.
    KaoiroServerWeb.Endpoint.broadcast(
      "wrapper:#{recipient}",
      "delivery_status",
      Map.put(status || %{}, :version, "0")
    )

    KaoiroServerWeb.Endpoint.broadcast(
      "agents:lobby",
      "delivery_status",
      %{"agent_id" => recipient, "delivery" => status}
    )

    :ok
  end

  @doc """
  Broadcasts a server-synthesized `kind: "done"` notice to every agent in
  `agent_ids` telling them `conversation_id` auto-closed (issue #221 —
  `open_conversation_ttl` GC reclaim; deliberately NOT `escalate-to-user`,
  which invited the recipient to open a brand-new conversation "to
  continue" — see ConversationStates moduledoc). `turn_number: 0` +
  `agent_id: "server"` + `meta.done: true` together are what
  `agent-common`'s `receiveInbound()` recognises as server provenance
  (`isSynthetic`, issue #177 review M1) and learns as `closed` — the
  receiving wrapper's track updates without ever waking the model (issue
  #221 direction 1: `receiveInbound()` returns `inject: false` for a
  `terminal`-mode envelope).

  Callback target for `KaoiroServer.ConversationStates`'s `:on_auto_closed`
  option (wired in `KaoiroServer.Application`) — this function's arity and
  argument order are that callback's contract.
  """
  @spec deliver_conversation_closed(String.t(), [String.t()], atom()) :: :ok
  def deliver_conversation_closed(conversation_id, agent_ids, reason) do
    ts = DateTime.utc_now() |> DateTime.to_iso8601()

    for recipient <- agent_ids do
      payload = %{
        "to" => recipient,
        "conversation_id" => conversation_id,
        "turn_number" => 0,
        "kind" => "done",
        "body" => "conversation closed: #{reason}",
        "meta" => %{"done" => true, "propose_next" => ""},
        "owner" => %{"kind" => "user", "id" => "system"}
      }

      deliver(recipient, build(payload, ts))
    end

    :ok
  end
end
