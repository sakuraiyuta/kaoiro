defmodule KaoiroServer.AgentStatusLinesLoadTest do
  # A record read from the file is checked with the rules a write passes (issue
  # 482 design r3 D1): one the write path would not have stored is dropped with
  # a warning and removed from the file, never repaired in place and never
  # allowed to stop init. Every case seeds a real DETS file and starts a real
  # store on it.
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias KaoiroServer.AgentStatusLines
  alias KaoiroServer.StatusLinesFixture, as: Fixture

  @survivors ["a.cleared", "a.good"]
  @rich "# second\n\n- 日本語\tok"

  # Seeds the two records that must survive next to `invalid`, then starts a
  # store on the file.
  defp load(invalid) do
    ctx = Fixture.names()
    on_exit(fn -> Enum.each(Path.wildcard(ctx.path <> "*"), &File.rm/1) end)

    Fixture.seed(ctx.path, [
      {{:agent, "a.good"}, [Fixture.entry(2, @rich), Fixture.entry(1, "first")]},
      {{:agent, "a.cleared"}, [Fixture.entry(2, nil), Fixture.entry(1, "first")]}
      | invalid
    ])

    log =
      capture_log(fn ->
        started =
          Fixture.start_store(Map.to_list(Map.take(ctx, [:name, :table, :building, :path])))

        send(self(), {:started, started})
      end)

    assert_received {:started, started}
    {started, log}
  end

  defp occurrences(log, needle), do: length(String.split(log, needle)) - 1

  # The survivors are exactly what was seeded, in the view, in the history and
  # on disk; the invalid records are gone from all three.
  defp assert_only_survivors(started, log, dropped) do
    {:ok, heads} = AgentStatusLines.heads(started.table)
    assert heads |> Map.keys() |> Enum.sort() == @survivors
    assert heads["a.good"].entry == Fixture.entry(2, @rich)
    assert heads["a.cleared"].entry == Fixture.entry(2, nil)

    assert {:ok, [%{seq: 2}, %{seq: 1}]} = AgentStatusLines.history("a.good", started.name)

    disk = Fixture.disk(started.path)
    assert disk.agents |> Map.keys() |> Enum.sort() == @survivors
    assert disk.agents["a.good"] == [Fixture.entry(2, @rich), Fixture.entry(1, "first")]
    assert disk.other == []

    assert occurrences(log, "discarding invalid record") == dropped
  end

  test "valid records alone are all kept, with nothing dropped" do
    {started, log} = load([])
    assert_only_survivors(started, log, 0)
  end

  test "text of exactly the byte limit is kept" do
    limit = String.duplicate("a", AgentStatusLines.max_bytes())
    {started, _log} = load([{{:agent, "a.limit"}, [Fixture.entry(1, limit)]}])

    assert {:ok, %{entry: %{text: ^limit}, bytes: bytes}} =
             AgentStatusLines.read_latest("a.limit", started.table)

    assert bytes == AgentStatusLines.max_bytes()
  end

  test "an improper entries list is dropped instead of stopping init" do
    {started, log} = load([{{:agent, "a.improper"}, [Fixture.entry(1, "x") | :broken_tail]}])

    assert_only_survivors(started, log, 1)
    assert log =~ "agent a.improper"
  end

  describe "a control character that a write rejects" do
    for {label, text} <- [
          {"vertical tabs around a letter", <<11, 120, 11>>},
          {"an escape sequence", "color \e[31mred"},
          {"a DEL", "del" <> <<127>>},
          {"a NUL", "nul" <> <<0>>}
        ] do
      test "is dropped: #{label}" do
        {started, log} = load([{{:agent, "a.bad"}, [Fixture.entry(1, unquote(text))]}])

        assert_only_survivors(started, log, 1)
        assert log =~ "agent a.bad"
        assert AgentStatusLines.read_latest("a.bad", started.table) == {:ok, nil}
      end
    end
  end

  describe "text that validation would change" do
    for {label, text} <- [
          {"leading and trailing spaces", "  padded  "},
          {"a CRLF line break", "one\r\ntwo"},
          {"a lone CR", "one\rtwo"},
          {"an empty string", ""},
          {"only whitespace", " \n\t "}
        ] do
      test "is dropped, not repaired: #{label}" do
        {started, log} = load([{{:agent, "a.bad"}, [Fixture.entry(1, unquote(text))]}])

        assert_only_survivors(started, log, 1)
        assert AgentStatusLines.read_latest("a.bad", started.table) == {:ok, nil}
      end
    end
  end

  test "one bad entry drops the whole record, whichever position it holds" do
    entries = [Fixture.entry(3, "newest"), Fixture.entry(2, <<11>>), Fixture.entry(1, "oldest")]
    {started, log} = load([{{:agent, "a.mixed"}, entries}])

    assert_only_survivors(started, log, 1)
    assert AgentStatusLines.history("a.mixed", started.name) == {:ok, []}
  end
end
