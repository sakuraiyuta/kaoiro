defmodule KaoiroServer.OAuthAllowlistWatcherBudgetGuardTest do
  # Reads the watcher test's source (issue 554). Every event wait names its
  # budget, and absence checks go through the barrier, not a timed refute.
  # Only the timer-path tests listed below keep a timed refute on purpose.
  use ExUnit.Case, async: true

  @source Path.expand("oauth_allowlist_watcher_test.exs", __DIR__)

  @timer_path_tests [
    "event が一切無くても periodic reconcile だけで bounded time 内に disconnect する"
  ]

  test "event waits name a budget and absence checks are not timed refutes" do
    assert [] == violations()
  end

  defp violations do
    ast = @source |> File.read!() |> Code.string_to_quoted!()

    for {name, body} <- tests(ast),
        {call, line, arity} <- receive_calls(body),
        bad?(name, call, arity),
        do: {name, call, line}
  end

  defp tests(ast) do
    {_ast, acc} =
      Macro.prewalk(ast, [], fn
        {:test, _, [name, [do: body]]} = node, acc when is_binary(name) ->
          {node, [{name, body} | acc]}

        node, acc ->
          {node, acc}
      end)

    acc
  end

  defp receive_calls(body) do
    {_ast, acc} =
      Macro.prewalk(body, [], fn
        {call, meta, args} = node, acc
        when call in [:assert_receive, :refute_receive] and is_list(args) ->
          {node, [{call, Keyword.get(meta, :line), length(args)} | acc]}

        node, acc ->
          {node, acc}
      end)

    acc
  end

  defp bad?(_name, :assert_receive, 1), do: true
  defp bad?(name, :refute_receive, _arity), do: name not in @timer_path_tests
  defp bad?(_name, _call, _arity), do: false
end
