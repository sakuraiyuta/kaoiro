defmodule KaoiroServer.AgentStatusLinesLogTest do
  # The start-up line is the only signal that DETS repaired a truncated file
  # into an empty valid table, so its counts are asserted. The test logger
  # level is :warning; lowering it for this module is process-global, hence
  # sync.
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias KaoiroServer.AgentStatusLines
  alias KaoiroServer.StatusLinesFixture, as: Fixture

  @moduletag :capture_log

  setup do
    :logger.set_module_level(AgentStatusLines, :info)
    on_exit(fn -> :logger.unset_module_level(AgentStatusLines) end)
  end

  test "reports the identity count, the entry count, the file size and the retention" do
    ctx = Fixture.start_store()
    AgentStatusLines.put("a.one", "one", ctx.name)
    AgentStatusLines.put("a.one", "two", ctx.name)
    AgentStatusLines.put("a.two", "other", ctx.name)
    AgentStatusLines.set_retention(9, ctx.name)
    Fixture.stop_store(ctx)

    log =
      capture_log(fn ->
        Fixture.start_store(path: ctx.path, fallback: %{retention: 20, source: :default})
      end)

    assert log =~ "2 agents, 3 entries"
    assert [_, size] = Regex.run(~r/file (\d+) bytes/, log)
    assert String.to_integer(size) > 0
    assert log =~ "retention 9 (stored)"
    assert log =~ "dirty=false"
  end

  test "an empty store reports zeros" do
    log = capture_log(fn -> Fixture.start_store() end)

    assert log =~ "0 agents, 0 entries"
  end
end
