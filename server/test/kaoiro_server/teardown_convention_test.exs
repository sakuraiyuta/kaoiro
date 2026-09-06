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
  # Residual: a teardown that delegates to a local helper, and stops the
  # process inside THAT function, is not seen — only the `on_exit` body is
  # walked. No such teardown exists today, and following calls across
  # functions would take the compiled artifact rather than the source.
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

    # Guards the scan itself: an AST it could no longer walk would leave
    # `raw` empty and pass while measuring nothing.
    assert length(adopters) >= 20,
           "the on_exit scan found #{length(adopters)} teardown sites; it is not reading the suite"

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
  defp on_exit_calls(file) do
    file
    |> File.read!()
    |> Code.string_to_quoted!()
    |> collect(fn
      {:on_exit, meta, args} when is_list(args) -> {meta[:line], args}
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
