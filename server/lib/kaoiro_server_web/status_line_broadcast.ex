defmodule KaoiroServerWeb.StatusLineBroadcast do
  @moduledoc """
  How the status line store reaches connected dashboards (issue 482).

  `AgentStatusLines` is a domain module and takes a `:broadcast` callback, as
  `ConversationStates` takes `:on_auto_closed`; this is the production one. The
  events travel unversioned on `agents:lobby` and are intercepted by
  `AgentsChannel`, which stamps them and filters them per role.
  """

  @topic "agents:lobby"

  @spec broadcast(String.t(), map()) :: :ok | {:error, term()}
  def broadcast(event, payload) when is_binary(event) and is_map(payload) do
    KaoiroServerWeb.Endpoint.broadcast(@topic, event, payload)
  end
end
