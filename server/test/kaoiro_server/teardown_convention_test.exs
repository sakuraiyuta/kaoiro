defmodule KaoiroServer.TeardownConventionTest do
  use ExUnit.Case, async: true

  # issue #318. A store started with `start_link` inside a test is LINKED to
  # the test process, and ExUnit ends a case by exiting that process with
  # `:shutdown` without waiting for it to die, so a teardown that stops the
  # store races the link signal and fails on its own even though the test
  # body passed. KaoiroServer.TestTeardown.stop_quietly/1 absorbs exactly
  # that race and re-raises everything else (issue #171). 22 teardown sites
  # already went through it and one never adopted it, which is what #318 was;
  # this keeps the 23rd from being written raw.
  #
  # Scope is `on_exit/1` bodies only. A stop in a test BODY is deliberate
  # (restart and reopen coverage) and is not this race at all — the test
  # process is still alive there, so nothing is racing the stop.
  #
  # Also out of scope on purpose: `Process.exit(pid, :kill)` and friends.
  # They cannot fail the way this guard is about — nothing waits on the
  # result, so there is no stop to lose the race.
  #
  # Residual: only what is written IN an `on_exit` body is seen. A teardown
  # that delegates the stop to another function — including a helper under
  # `test/support` — is not, and following calls across functions would take
  # the compiled artifact rather than the source.
  @test_root Path.expand("..", __DIR__)

  # Any `stop`/`terminate` call, whatever it is qualified by. Matching on the
  # function NAME rather than on `GenServer.stop` keeps an alias
  # (`alias GenServer, as: GS`) from walking past — the same evasion a source
  # regex let through in issue #310. `stop_quietly` is a different name and
  # so never matches.
  @raw_stop_names [:stop, :terminate]

  describe "the scan" do
    # Pinned on INLINE sources, never by planting a violating file under
    # test/: a real violation would leave the suite permanently red, and
    # excluding it again would rebuild the very blind spot this checker is
    # for. Nothing here is evaluated — the sources are only parsed — so
    # undefined names in them are deliberate.
    test "reports a raw stop in a bare on_exit" do
      assert [:stop] = raw_stops_in(~S|on_exit(fn -> GenServer.stop(pid) end)|)
    end

    # test/support modules do not `use ExUnit.Case`, so a teardown written
    # in one can only be the qualified spelling. Matching the bare atom
    # alone made every such file a blind spot (クロエ #318 round 1 must).
    test "reports a raw stop in a QUALIFIED on_exit" do
      assert [:stop] = raw_stops_in(~S|ExUnit.Callbacks.on_exit(fn -> GenServer.stop(pid) end)|)
    end

    # One dimension per pin, so a broken clause reddens one test and names
    # itself. The qualified SPELLING is pinned just above; this one varies
    # the qualifier of the STOP and nothing else.
    test "an aliased qualifier does not walk past it" do
      assert [:stop] = raw_stops_in(~S|on_exit(fn -> GS.stop(pid) end)|)
    end

    test "reports :sys.terminate as well as stop" do
      assert [:terminate] = raw_stops_in(~S|on_exit(fn -> :sys.terminate(pid, :normal) end)|)
    end

    # A bare call, with no module in front: an imported one, or a `stop/1`
    # the test module defines itself. Worth keeping distinct from the
    # qualified clause because it also catches part of the residual, where
    # the teardown hands the stop to a local function (クロエ #318 round 2
    # nit-1 — the clause was there but nothing pinned it).
    test "reports an unqualified stop call" do
      assert [:stop] = raw_stops_in(~S|on_exit(fn -> stop(pid) end)|)
    end

    # A balanced-paren slicer ended the body at the `)` inside the string
    # and never saw the stop after it. Elixir's own parser decides where the
    # call ends, so that cannot happen.
    test "a `)` inside a string literal does not end the body early" do
      source = ~S|on_exit(fn -> _label = "closing) paren"; GenServer.stop(pid) end)|

      assert [:stop] = raw_stops_in(source)
    end

    test "reports a stop passed as a capture" do
      assert [:stop] = raw_stops_in(~S|on_exit(fn -> Enum.each(pids, &GenServer.stop/1) end)|)
    end

    test "does not report what it must not" do
      # The helper this checker exists to enforce.
      assert [] == raw_stops_in(~S|on_exit(fn -> stop_quietly(pid) end)|)
      # A stop in a test body: deliberate, and not this race.
      assert [] == raw_stops_in(~S|test "reopen" do GenServer.stop(pid) end|)
      # Comments are absent from the AST.
      assert [] ==
               raw_stops_in(~S"""
               on_exit(fn ->
                 # GenServer.stop(pid)
                 :ok
               end)
               """)

      # Out of scope by design: nothing waits on it.
      assert [] == raw_stops_in(~S|on_exit(fn -> Process.exit(pid, :kill) end)|)
    end
  end

  describe "the suite" do
    # What the scan DETECTS is pinned above, on inline sources. These two
    # answer the one remaining question — whether the scan is still reading
    # the real suite at all — and nothing else. Two tests, not one, because
    # they fail for different reasons and a single threshold covering both
    # can be lowered by an honest change (クロエ #318 round 1 nit-2). The
    # two qualified callbacks under `test/support` hold `File.rm` and
    # `Application.put_env`, no stop, so picking them up leaves the
    # suite-wide check green — as it should.
    test "the scan reads the whole suite" do
      # 179 callbacks measured 2026-09-07 (177 bare, 2 qualified). No routine
      # change moves that by an order of magnitude, so a scan that stopped
      # parsing shows up here rather than passing with an empty result.
      count = length(on_exit_callbacks_in_suite())

      assert count >= 100,
             "the on_exit scan found #{count} callbacks; it is not reading the suite"
    end

    test "the stop_quietly matcher still matches" do
      # 22 adopting sites measured 2026-09-07. Deliberately a low bar:
      # folding store tests together honestly reduces this, and it must not
      # drag the scan's own liveness bar down with it.
      adopters =
        Enum.count(on_exit_callbacks_in_suite(), fn {_file, _line, ast} ->
          calls?(ast, :stop_quietly)
        end)

      assert adopters >= 1, "no teardown goes through stop_quietly; the matcher is not matching"
    end

    test "every on_exit teardown stops its process through TestTeardown" do
      raw =
        for {file, line, ast} <- on_exit_callbacks_in_suite(),
            name <- raw_stop_calls(ast),
            uniq: true do
          "#{file}:#{line} (#{name})"
        end

      assert raw == [],
             "teardown must stop its process through " <>
               "KaoiroServer.TestTeardown.stop_quietly/1 (issue #318): " <>
               Enum.join(raw, ", ")
    end
  end

  defp on_exit_callbacks_in_suite do
    for file <- Path.wildcard(Path.join(@test_root, "**/*.{ex,exs}")),
        {line, ast} <- file |> File.read!() |> on_exit_callbacks(),
        do: {Path.relative_to(file, @test_root), line, ast}
  end

  defp raw_stops_in(source),
    do: for({_line, ast} <- on_exit_callbacks(source), do: raw_stop_calls(ast)) |> List.flatten()

  # Parsed, not sliced, and both spellings — symmetrically with
  # raw_stop_calls/1, whose qualified clause this one was missing.
  defp on_exit_callbacks(source) do
    source
    |> Code.string_to_quoted!()
    |> collect(fn
      {:on_exit, meta, args} when is_list(args) -> {meta[:line], args}
      {{:., _, [_qualifier, :on_exit]}, meta, args} when is_list(args) -> {meta[:line], args}
      _ -> nil
    end)
  end

  defp raw_stop_calls(ast) do
    collect(ast, fn
      {{:., _, [_qualifier, name]}, _, args} when name in @raw_stop_names and is_list(args) ->
        name

      {name, _, args} when name in @raw_stop_names and is_list(args) ->
        name

      _ ->
        nil
    end)
  end

  defp calls?(ast, name) do
    [] !=
      collect(ast, fn
        {^name, _, args} when is_list(args) -> name
        {{:., _, [_qualifier, ^name]}, _, args} when is_list(args) -> name
        _ -> nil
      end)
  end

  defp collect(ast, matcher) do
    {_ast, found} =
      Macro.prewalk(ast, [], fn node, acc ->
        case matcher.(node) do
          nil -> {node, acc}
          hit -> {node, [hit | acc]}
        end
      end)

    Enum.reverse(found)
  end
end
