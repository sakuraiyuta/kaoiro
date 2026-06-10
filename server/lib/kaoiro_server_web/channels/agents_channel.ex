defmodule KaoiroServerWeb.AgentsChannel do
  @moduledoc """
  Client-facing fan-out. After joining `agents:lobby` the channel pushes a
  `snapshot` event with the current agent_id => latest envelope map;
  `envelope` broadcasts follow as agents change state.
  """

  use Phoenix.Channel

  alias KaoiroServer.AgentStates

  @impl true
  def join("agents:lobby", _params, socket) do
    # The PubSub subscription only becomes active once join/3 returns, so a
    # snapshot replied here could miss an envelope broadcast in between.
    # Pushing it from handle_info runs after the subscription is live; a
    # broadcast racing the snapshot is then delivered twice at worst
    # (idempotent: last write per agent_id wins), never lost.
    send(self(), :after_join)
    {:ok, socket}
  end

  @impl true
  def handle_info(:after_join, socket) do
    push(socket, "snapshot", %{"agents" => AgentStates.snapshot()})
    {:noreply, socket}
  end
end
