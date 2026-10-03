defmodule KaoiroServerWeb.StatusLineAnnouncerTest do
  # The announcer runs inside the AgentStates process, so it may read the
  # published row and broadcast and do nothing else (issue 482 design r3b A1,
  # r3c N1, r5 I5). It reads the application's own store, so this module is sync.
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias KaoiroServer.{AgentStates, AgentStatusLines, StatusLineWire, TestTimeouts}
  alias KaoiroServer.StatusLinesFixture, as: Fixture
  alias KaoiroServerWeb.{Endpoint, StatusLineAnnouncer, StatusLineVisibility}

  @topic "agents:lobby"

  setup do
    agent = "announcer-test.#{System.unique_integer([:positive])}"
    Endpoint.subscribe(@topic)

    on_exit(fn ->
      # A test killed by a timeout leaves the store suspended or stopped.
      store = Process.whereis(AgentStatusLines)
      if store, do: :sys.resume(store)

      {:ok, _} =
        Fixture.restart_child(KaoiroServer.Supervisor, AgentStatusLines, AgentStatusLines)

      AgentStatusLines.purge(agent)
    end)

    %{agent: agent}
  end

  defp live(agent) do
    {:ok, row} = AgentStatusLines.read_latest(agent)
    StatusLineWire.live_payload(agent, row)
  end

  test "broadcasts the committed line as the live event", %{agent: agent} do
    {:ok, _} = AgentStatusLines.put(agent, "# Reviewing\n\nissue 482")

    assert :ok = StatusLineAnnouncer.announce(agent)

    expected = live(agent)

    assert_receive %Phoenix.Socket.Broadcast{
      topic: @topic,
      event: "status_line",
      payload: ^expected
    }

    assert %{"agent_id" => ^agent, "head" => "# Reviewing\n\nissue 482", "seq" => 1} = expected
  end

  test "announces a stamped clear, so a cached older line can be dropped", %{agent: agent} do
    {:ok, _} = AgentStatusLines.put(agent, "working")
    {:ok, _} = AgentStatusLines.put(agent, "")

    assert :ok = StatusLineAnnouncer.announce(agent)

    assert_receive %Phoenix.Socket.Broadcast{
      event: "status_line",
      payload: %{"agent_id" => ^agent, "seq" => 2, "cleared" => true}
    }
  end

  test "announces nothing for an agent with no line", %{agent: agent} do
    assert :ok = StatusLineAnnouncer.announce(agent)

    refute_receive %Phoenix.Socket.Broadcast{event: "status_line"}
  end

  test "skips with a warning while the store is unavailable", %{agent: agent} do
    {:ok, _} = AgentStatusLines.put(agent, "working")
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, AgentStatusLines)

    log = capture_log(fn -> assert :ok = StatusLineAnnouncer.announce(agent) end)

    assert log =~ "skipped: store unavailable"
    refute_receive %Phoenix.Socket.Broadcast{event: "status_line"}
  end

  # The announcer is called from inside the AgentStates process. A call from
  # there to the store would block behind the suspended store and take
  # AgentStates down with a timeout.
  test "does not wait for the store: AgentStates answers while the store is suspended", %{
    agent: agent
  } do
    {:ok, _} = AgentStatusLines.put(agent, "working")
    name = :"agent_states_announcer_#{System.unique_integer([:positive])}"

    start_supervised!(
      {AgentStates,
       name: name,
       visible?: &StatusLineVisibility.viewer_visible?/1,
       on_viewer_visible: &StatusLineAnnouncer.announce/1}
    )

    hidden = %{"agent_id" => agent, "type" => "instruction_rejected", "state" => "idle"}
    visible = %{"agent_id" => agent, "type" => "state_change", "state" => "idle"}
    assert :ok = AgentStates.put(hidden, server: name)

    :ok = :sys.suspend(AgentStatusLines)

    put = Task.async(fn -> AgentStates.put(visible, server: name) end)
    assert {:ok, :ok} = Task.yield(put, TestTimeouts.out_of_band())

    assert_receive %Phoenix.Socket.Broadcast{
      event: "status_line",
      payload: %{"agent_id" => ^agent, "seq" => 1}
    }
  end
end
