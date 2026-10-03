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

  @rich "# second\n\n- 日本語\tok"

  # Seeds the two records that must survive next to the `extra` ones, then
  # starts a store on the file. `extra` maps a label to the entries stored
  # under it. Every id carries a number unique to the call: this module and
  # `AgentStatusLinesTest` are async, so the captured log can hold the warnings
  # of the other tests too, and only an id that no other test can use proves a
  # warning came from this store.
  defp load(extra) do
    n = System.unique_integer([:positive])
    ids = %{good: "a.good.#{n}", cleared: "a.cleared.#{n}"}
    extra_ids = Map.new(extra, fn {label, _entries} -> {label, "#{label}.#{n}"} end)

    ctx = Fixture.names()
    on_exit(fn -> Enum.each(Path.wildcard(ctx.path <> "*"), &File.rm/1) end)

    Fixture.seed(
      ctx.path,
      [
        {{:agent, ids.good}, [Fixture.entry(2, @rich), Fixture.entry(1, "first")]},
        {{:agent, ids.cleared}, [Fixture.entry(2, nil), Fixture.entry(1, "first")]}
      ] ++ for({label, entries} <- extra, do: {{:agent, extra_ids[label]}, entries})
    )

    log =
      capture_log(fn ->
        started =
          Fixture.start_store(Map.to_list(Map.take(ctx, [:name, :table, :building, :path])))

        send(self(), {:started, started})
      end)

    assert_received {:started, started}
    %{started: started, log: log, ids: ids, extra: extra_ids}
  end

  # The survivors are exactly what was seeded, in the view, in the history and
  # on disk; every extra record is invalid, gone from all three and named in a
  # warning, while no warning names a survivor.
  defp assert_only_survivors(%{started: started, log: log, ids: ids, extra: extra}) do
    survivors = Enum.sort([ids.good, ids.cleared])

    {:ok, heads} = AgentStatusLines.heads(started.table)
    assert heads |> Map.keys() |> Enum.sort() == survivors
    assert heads[ids.good].entry == Fixture.entry(2, @rich)
    assert heads[ids.cleared].entry == Fixture.entry(2, nil)

    assert {:ok, [%{seq: 2}, %{seq: 1}]} = AgentStatusLines.history(ids.good, started.name)

    disk = Fixture.disk(started.path)
    assert disk.agents |> Map.keys() |> Enum.sort() == survivors
    assert disk.agents[ids.good] == [Fixture.entry(2, @rich), Fixture.entry(1, "first")]
    assert disk.other == []

    for {_label, id} <- extra, do: assert(log =~ "discarding invalid record (agent #{id})")
    refute log =~ ids.good
    refute log =~ ids.cleared
  end

  test "valid records alone are all kept, and no warning names them" do
    assert_only_survivors(load([]))
  end

  test "text of exactly the byte limit is kept" do
    limit = String.duplicate("a", AgentStatusLines.max_bytes())
    loaded = load(limit: [Fixture.entry(1, limit)])

    assert {:ok, %{entry: %{text: ^limit}, bytes: bytes}} =
             AgentStatusLines.read_latest(loaded.extra.limit, loaded.started.table)

    assert bytes == AgentStatusLines.max_bytes()
  end

  test "an improper entries list is dropped instead of stopping init" do
    assert_only_survivors(load(improper: [Fixture.entry(1, "x") | :broken_tail]))
  end

  describe "a control character that a write rejects" do
    for {label, text} <- [
          {"vertical tabs around a letter", <<11, 120, 11>>},
          {"an escape sequence", "color \e[31mred"},
          {"a DEL", "del" <> <<127>>},
          {"a NUL", "nul" <> <<0>>}
        ] do
      test "is dropped: #{label}" do
        loaded = load(bad: [Fixture.entry(1, unquote(text))])

        assert_only_survivors(loaded)
        assert AgentStatusLines.read_latest(loaded.extra.bad, loaded.started.table) == {:ok, nil}
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
        loaded = load(bad: [Fixture.entry(1, unquote(text))])

        assert_only_survivors(loaded)
        assert AgentStatusLines.read_latest(loaded.extra.bad, loaded.started.table) == {:ok, nil}
      end
    end
  end

  test "one bad entry drops the whole record, whichever position it holds" do
    entries = [Fixture.entry(3, "newest"), Fixture.entry(2, <<11>>), Fixture.entry(1, "oldest")]
    loaded = load(mixed: entries)

    assert_only_survivors(loaded)
    assert AgentStatusLines.history(loaded.extra.mixed, loaded.started.name) == {:ok, []}
  end
end
