defmodule KaoiroServer.AgentStatusLinesAppTest do
  # The application's own store, started by the supervision tree with its
  # production options and nothing injected. It is a singleton shared with every
  # other module, so this one is sync and uses its own agent id.
  use ExUnit.Case, async: false

  alias KaoiroServer.AgentStatusLines
  alias KaoiroServer.StatusLinesFixture, as: Fixture

  @agent "asl-app-test.agent"

  setup do
    on_exit(fn ->
      # A test killed by a timeout leaves the child stopped; nothing else
      # restarts it. Restoring it here is what keeps the next module honest.
      {:ok, _} =
        Fixture.restart_child(KaoiroServer.Supervisor, AgentStatusLines, AgentStatusLines)

      AgentStatusLines.purge(@agent)
    end)

    :ok
  end

  defp configured_path, do: Application.fetch_env!(:kaoiro_server, :agent_status_lines_path)

  test "a real put through the default composition is published and on disk" do
    assert {:ok, %{status: :set, seq: seq}} = AgentStatusLines.put(@agent, "from the app tree")

    assert {:ok, %{entry: %{seq: ^seq, text: "from the app tree"}}} =
             AgentStatusLines.read_latest(@agent)

    assert {:ok, %{retention: 20, source: source}} = AgentStatusLines.settings()
    assert source in [:default, :env]

    assert %{agents: %{@agent => [%{seq: ^seq, text: "from the app tree"} | _]}} =
             Fixture.disk(configured_path())
  end

  test "stopping and restarting the child keeps the line and the readers converge" do
    {:ok, %{seq: seq}} = AgentStatusLines.put(@agent, "survives a child restart")
    {:ok, before} = AgentStatusLines.heads()
    assert Map.has_key?(before, @agent)

    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, AgentStatusLines)

    assert :unavailable = AgentStatusLines.heads()
    assert :unavailable = AgentStatusLines.read_latest(@agent)
    assert :unavailable = AgentStatusLines.settings()
    assert {:error, :status_line_unavailable} = AgentStatusLines.history(@agent)
    assert {:error, :status_line_unavailable} = AgentStatusLines.put(@agent, "nobody home")

    assert {:ok, _pid} =
             Fixture.restart_child(KaoiroServer.Supervisor, AgentStatusLines, AgentStatusLines)

    assert {:ok, %{entry: %{seq: ^seq, text: "survives a child restart"}}} =
             AgentStatusLines.read_latest(@agent)

    assert {:ok, %{seq: next}} = AgentStatusLines.put(@agent, "and writes again")
    assert next == seq + 1
  end
end
