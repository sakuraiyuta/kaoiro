defmodule KaoiroServerWeb.OperatorInputModesTest do
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.WorkStore

  @ia_none %{"version" => "v1", "early" => "none", "yield" => "none", "stage_reports" => true}
  @ia_fold %{"version" => "v1", "early" => "fold", "yield" => "none", "stage_reports" => true}

  setup do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-operator:operator")
    on_exit(fn -> Application.delete_env(:kaoiro_server, :client_tokens) end)
  end

  defp join_wrapper(agent_id, params) do
    {:ok, reply, socket} =
      KaoiroServerWeb.WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(
        KaoiroServerWeb.WrapperChannel,
        "wrapper:" <> agent_id,
        Map.merge(
          %{
            "persona_id" => "default",
            "inter_agent_delivery_ack" => "dispatch-v1",
            "delivery_generation" => agent_id,
            "delivery_resync" => "skip-v1",
            "inter_agent_reply_basis" => "v1"
          },
          params
        )
      )

    assert_reply push(socket, "envelope", %{
                   "version" => "0",
                   "agent_id" => agent_id,
                   "persona" => %{"id" => "mio", "name" => "Mio", "sprite_set" => "mio"},
                   "ts" => "2026-09-30T00:00:00Z",
                   "type" => "state_change",
                   "state" => "idle",
                   "payload" => %{},
                   "ext" => %{}
                 }),
                 :ok

    on_exit(fn -> KaoiroServer.DeliveryStates.delete(agent_id) end)
    {reply, socket}
  end

  defp operator do
    fingerprint = KaoiroServer.Auth.socket_id("tok-operator")

    {:ok, _reply, socket} =
      KaoiroServerWeb.ClientSocket
      |> socket(nil, %{
        role: :operator,
        credential: {:token_fingerprint, fingerprint},
        socket_id: fingerprint
      })
      |> subscribe_and_join(KaoiroServerWeb.AgentsChannel, "agents:lobby")

    socket
  end

  defp relayed_intent(agent_id, payload) do
    @endpoint.subscribe("wrapper:" <> agent_id)

    ref =
      push(
        operator(),
        "instruction",
        Map.merge(%{"agent_id" => agent_id, "text" => "x"}, payload)
      )

    assert_reply ref, :ok

    assert_receive %Phoenix.Socket.Broadcast{
      topic: "wrapper:" <> ^agent_id,
      event: "instruction",
      payload: relayed
    }

    relayed["delivery_intent"]
  end

  defp agent_id, do: "op-modes-#{System.unique_integer([:positive])}"

  test "an operator declaration is echoed and makes a defaulted instruction early" do
    id = agent_id()

    {reply, _socket} =
      join_wrapper(id, %{
        "inter_agent_delivery_modes" => @ia_none,
        "operator_input_modes" => %{"version" => "v1", "early" => "steer"}
      })

    assert reply["operator_input_modes"] == "v1"
    assert relayed_intent(id, %{}) == "early"
  end

  test "without an operator declaration the inter-agent declaration still decides" do
    id = agent_id()
    {reply, _socket} = join_wrapper(id, %{"inter_agent_delivery_modes" => @ia_none})

    refute Map.has_key?(reply, "operator_input_modes")
    assert relayed_intent(id, %{}) == "normal"

    fold = agent_id()
    {_reply, _socket} = join_wrapper(fold, %{"inter_agent_delivery_modes" => @ia_fold})
    assert relayed_intent(fold, %{}) == "early"
  end

  test "an operator declaration of none overrides an early inter-agent declaration" do
    id = agent_id()

    {_reply, _socket} =
      join_wrapper(id, %{
        "inter_agent_delivery_modes" => @ia_fold,
        "operator_input_modes" => %{"version" => "v1", "early" => "none"}
      })

    assert relayed_intent(id, %{}) == "normal"
  end

  test "an invalid operator declaration is not echoed and does not change the default" do
    for invalid <- [
          %{"version" => "v2", "early" => "steer"},
          %{"version" => "v1", "early" => "now"},
          %{"version" => "v1"},
          "steer"
        ] do
      id = agent_id()

      {reply, _socket} =
        join_wrapper(id, %{
          "inter_agent_delivery_modes" => @ia_none,
          "operator_input_modes" => invalid
        })

      refute Map.has_key?(reply, "operator_input_modes")
      assert relayed_intent(id, %{}) == "normal"
    end
  end

  test "an explicit intent is relayed unchanged" do
    id = agent_id()

    {_reply, _socket} =
      join_wrapper(id, %{
        "inter_agent_delivery_modes" => @ia_none,
        "operator_input_modes" => %{"version" => "v1", "early" => "steer"}
      })

    assert relayed_intent(id, %{"delivery_intent" => "normal"}) == "normal"
  end

  test "the operator declaration leaves inter-agent early admission untouched" do
    id = agent_id()

    {_reply, _socket} =
      join_wrapper(id, %{
        "inter_agent_delivery_modes" => @ia_none,
        "operator_input_modes" => %{"version" => "v1", "early" => "steer"}
      })

    assert WorkStore.modes(id)["early"] == "none"
    assert WorkStore.modes_snapshot()[id]["early"] == "none"
  end

  test "leaving clears the declaration so a rejoin without it falls back" do
    id = agent_id()

    {_reply, socket} =
      join_wrapper(id, %{
        "inter_agent_delivery_modes" => @ia_none,
        "operator_input_modes" => %{"version" => "v1", "early" => "steer"}
      })

    Process.unlink(socket.channel_pid)
    ref = Process.monitor(socket.channel_pid)
    close(socket)
    assert_receive {:DOWN, ^ref, _, _, _}
    assert WorkStore.operator_modes(id) == nil

    {_reply, _socket} = join_wrapper(id, %{"inter_agent_delivery_modes" => @ia_none})
    assert relayed_intent(id, %{}) == "normal"
  end
end
