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

  test "every on_exit teardown stops its process through TestTeardown" do
    blocks =
      for file <- test_sources(),
          {line, ast} <- on_exit_calls(file),
          do: {Path.relative_to(file, @test_root), line, ast}

    raw =
      for {file, line, ast} <- blocks, name <- raw_stop_calls(ast), uniq: true do
        "#{file}:#{line} (#{name})"
      end

    adopters = for {_f, _l, ast} <- blocks, calls?(ast, :stop_quietly), do: ast

    # Two liveness guards, because they fail for different reasons and one
    # threshold covering both can be lowered by an honest change (クロエ
    # #318 round 1 nit-2). The scan is alive: the suite's `on_exit` count is
    # in the hundreds (179 measured 2026-09-07) and no routine change moves
    # it by an order of magnitude, so a scan that stopped parsing shows up
    # here rather than passing with an empty `raw`.
    assert length(blocks) >= 100,
           "the on_exit scan found #{length(blocks)} callbacks; it is not reading the suite"

    # The `stop_quietly` matcher is alive. Separate from the count above so
    # that folding store tests together cannot quietly lower the scan's own
    # liveness bar along with it.
    assert length(adopters) >= 1,
           "no teardown goes through stop_quietly; the matcher is not matching"

    assert raw == [],
           "teardown must stop its process through " <>
             "KaoiroServer.TestTeardown.stop_quietly/1 (issue #318): " <>
             Enum.join(raw, ", ")
  end

  defp test_sources do
    @test_root |> Path.join("**/*.{ex,exs}") |> Path.wildcard()
  end

  # Parsed, not sliced: Elixir's own parser decides where an `on_exit(...)`
  # call ends, so a `)` inside a string literal or a comment cannot end the
  # body early and hide a stop after it (the fail-open a balanced-paren
  # slicer had). Comments are absent from the AST, so a commented-out stop
  # is correctly ignored too.
  # Both spellings, symmetrically with raw_stop_calls/1. `test/support`
  # modules do not `use ExUnit.Case`, so `on_exit/1` is not imported there
  # and a teardown written in one is ALWAYS the qualified
  # `ExUnit.Callbacks.on_exit(...)` — matching only the bare atom made every
  # such file a blind spot (クロエ #318 round 1 must; two qualified sites
  # exist today).
  defp on_exit_calls(file) do
    file
    |> File.read!()
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
