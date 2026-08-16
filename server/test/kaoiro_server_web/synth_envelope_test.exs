defmodule KaoiroServerWeb.SynthEnvelopeTest do
  # Builds + delivers server-synthesized `inter_agent_message` envelopes
  # (issue #221). Shares `@endpoint` via ChannelCase purely for
  # `subscribe/1` — this module under test is a plain function module, not
  # a channel, so no join/push machinery is needed.
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServerWeb.SynthEnvelope

  # Mirrors `protocol/src/index.ts`'s `Envelope` interface's REQUIRED (no
  # `?`) fields as of issue #221 (protocol/src/index.ts:552-591): version,
  # agent_id, persona, display_name, ts, type, state, payload, ext.
  # session_id / seq are optional and deliberately excluded. This list is
  # the explicit assert クロエ asked for (issue #221 direction 4 follow-up,
  # condition 3): it does not, and cannot, auto-track the TS source — a
  # future required field added there must ALSO be added here, and only
  # then does this test protect `build/2` from omitting it again the way
  # `display_name` was omitted before this module existed.
  @required_envelope_keys ~w(version agent_id persona display_name ts type state payload ext)

  describe "build/2" do
    test "includes every required Envelope field (protocol/src/index.ts)" do
      envelope = SynthEnvelope.build(%{"to" => "peer.a"}, "2026-01-01T00:00:00Z")

      for key <- @required_envelope_keys do
        assert Map.has_key?(envelope, key), "missing required Envelope field: #{key}"
      end
    end

    test "display_name and persona both carry the server sentinel (issue #221 direction 4)" do
      envelope = SynthEnvelope.build(%{"to" => "peer.a"}, "2026-01-01T00:00:00Z")

      assert envelope["display_name"] == "server"

      assert envelope["persona"] == %{
               "id" => "server",
               "name" => "server",
               "sprite_set" => "server"
             }

      assert envelope["agent_id"] == "server"
    end
  end

  describe "deliver_conversation_closed/3" do
    test "ack-capable recipient receives a delivery_seq while the dashboard projection does not" do
      recipient = "test.synth-delivery"
      cid = "cnv-synth-delivery-#{System.unique_integer([:positive])}"
      on_exit(fn -> KaoiroServer.DeliveryStates.delete(recipient) end)
      KaoiroServer.DeliveryStates.bind(recipient, "process-a")

      @endpoint.subscribe("wrapper:" <> recipient)
      @endpoint.subscribe("agents:lobby")

      assert :ok =
               SynthEnvelope.deliver_conversation_closed(
                 cid,
                 [recipient],
                 :open_conversation_ttl
               )

      assert_received %Phoenix.Socket.Broadcast{
        topic: "wrapper:" <> ^recipient,
        event: "envelope",
        payload: routed
      }

      assert routed["delivery_seq"] == 1

      assert_received %Phoenix.Socket.Broadcast{
        topic: "agents:lobby",
        event: "envelope",
        payload: observed
      }

      refute Map.has_key?(observed, "delivery_seq")
    end

    test "broadcasts a kind:done, turn_number:0, agent_id:server envelope to every participant" do
      a = "test.synth-closed-a"
      b = "test.synth-closed-b"
      cid = "cnv-synth-closed-#{System.unique_integer([:positive])}"

      @endpoint.subscribe("wrapper:" <> a)
      @endpoint.subscribe("wrapper:" <> b)
      @endpoint.subscribe("agents:lobby")

      assert :ok = SynthEnvelope.deliver_conversation_closed(cid, [a, b], :open_conversation_ttl)

      for recipient <- [a, b] do
        assert_received %Phoenix.Socket.Broadcast{
          topic: "wrapper:" <> ^recipient,
          event: "envelope",
          payload: %{
            "agent_id" => "server",
            "display_name" => "server",
            "type" => "inter_agent_message",
            "payload" => %{
              "to" => ^recipient,
              "conversation_id" => ^cid,
              "turn_number" => 0,
              "kind" => "done",
              "meta" => %{"done" => true}
            }
          }
        }
      end

      # Operator dashboard visibility (ADR-0021) — one broadcast per
      # recipient, same as the existing escalate-to-user / unreachable
      # paths this module consolidates.
      assert_received %Phoenix.Socket.Broadcast{topic: "agents:lobby", event: "envelope"}
      assert_received %Phoenix.Socket.Broadcast{topic: "agents:lobby", event: "envelope"}
    end

    test "never uses escalate-to-user (issue #221: that kind invited a pointless new-thread continuation)" do
      a = "test.synth-closed-not-escalate"
      cid = "cnv-synth-closed-kind-#{System.unique_integer([:positive])}"

      @endpoint.subscribe("wrapper:" <> a)

      assert :ok = SynthEnvelope.deliver_conversation_closed(cid, [a], :open_conversation_ttl)

      assert_received %Phoenix.Socket.Broadcast{payload: %{"payload" => %{"kind" => kind}}}
      assert kind == "done"
      refute kind == "escalate-to-user"
    end
  end
end
