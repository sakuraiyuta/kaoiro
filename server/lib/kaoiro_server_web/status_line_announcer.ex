defmodule KaoiroServerWeb.StatusLineAnnouncer do
  @moduledoc """
  Re-announces an agent's latest status line when the agent has just become
  visible to viewers (issue 482 design r3b A1).

  A viewer that joined while the agent was hidden holds no line for it. After a
  server restart `AgentStates` starts empty, so this happens to every viewer for
  every agent; the line is announced again when the agent's first visible
  envelope is stored.

  `announce/1` runs inside the `AgentStates` process. It therefore reads the
  committed row from ETS and broadcasts, and nothing else: no `AgentStates`
  call, no store call, no write. If the store is unavailable the announcement is
  skipped with a warning; a viewer may then show the line as unset until the
  agent writes again or the viewer rejoins.

  A cleared line is announced too, as the stamped clear it is: a viewer that
  cached an older line while the agent was visible needs the clear to drop it.
  """

  require Logger

  alias KaoiroServer.{AgentStatusLines, StatusLineWire}

  @topic "agents:lobby"

  @spec announce(String.t()) :: :ok
  def announce(agent_id) when is_binary(agent_id) do
    case AgentStatusLines.read_latest(agent_id) do
      {:ok, nil} ->
        :ok

      {:ok, row} ->
        KaoiroServerWeb.Endpoint.broadcast(
          @topic,
          "status_line",
          StatusLineWire.live_payload(agent_id, row)
        )

        :ok

      :unavailable ->
        Logger.warning("status line announcement for #{agent_id} skipped: store unavailable")
        :ok
    end
  end
end
