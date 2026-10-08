defmodule KaoiroServer.StoreSingletonGuardTest do
  # The ChannelCase reset clears the process-global stores between channel
  # tests (issue 554). That is safe only while every test module that calls a
  # store's default-named singleton is a sync ChannelCase module: ExUnit runs
  # async modules before sync ones, so no async module can see a reset, and
  # the sync channel modules reset after themselves. This guard pins that
  # invariant to the source.
  use ExUnit.Case, async: true

  @stores %{
    "ConversationStates" => KaoiroServer.ConversationStates,
    "AgentActivity" => KaoiroServer.AgentActivity,
    "DeliveryStates" => KaoiroServer.DeliveryStates,
    "SessionLifecycleEvents" => KaoiroServer.SessionLifecycleEvents
  }

  # Pure functions whose arity matches a store function that takes a server.
  # They never touch a store, so they are not singleton calls.
  @pure [
    {KaoiroServer.SessionLifecycleEvents, :valid_event?},
    {KaoiroServer.DeliveryStates, :wire_projection}
  ]

  test "only sync ChannelCase modules call the default-named store singletons" do
    offenders =
      for file <- test_files(),
          calls = default_singleton_calls(file),
          calls != [],
          not channel_case_sync?(file),
          do: {Path.relative_to(file, server_root()), calls}

    assert offenders == []
  end

  test "the scan finds the known channel-case calls, so an empty result is not vacuous" do
    assert Enum.any?(
             test_files(),
             &(default_singleton_calls(&1) != [] and channel_case_sync?(&1))
           )
  end

  defp server_root, do: Path.expand("../..", __DIR__)

  defp test_files do
    Path.wildcard(Path.join(server_root(), "test/**/*_test.exs"))
  end

  defp channel_case_sync?(file) do
    text = File.read!(file)

    String.contains?(text, "use KaoiroServerWeb.ChannelCase") and
      String.contains?(text, "async: false")
  end

  # A call Mod.fun(args) with L arguments is a singleton call when fun is also
  # exported at arity L + 1 (the optional trailing server argument), so the
  # caller left it out. A piped call counts the piped value as one argument.
  defp default_singleton_calls(file) do
    {:ok, ast} = file |> File.read!() |> Code.string_to_quoted()

    {_ast, found} =
      Macro.prewalk(ast, [], fn
        {:|>, meta, [lhs, {{:., _, [{:__aliases__, _, parts}, fun]}, _, args}]}, acc
        when is_list(args) ->
          acc = note(parts, fun, length(args) + 1, acc)
          {{:|>, meta, [lhs, :piped]}, acc}

        {{:., _, [{:__aliases__, _, parts}, fun]}, _, args} = node, acc when is_list(args) ->
          {node, note(parts, fun, length(args), acc)}

        node, acc ->
          {node, acc}
      end)

    Enum.reverse(found)
  end

  defp note(parts, fun, nargs, acc) do
    name = parts |> List.last() |> to_string()

    case Map.fetch(@stores, name) do
      {:ok, mod} ->
        Code.ensure_loaded!(mod)

        if function_exported?(mod, fun, nargs) and function_exported?(mod, fun, nargs + 1) and
             {mod, fun} not in @pure do
          [{name, fun, nargs} | acc]
        else
          acc
        end

      :error ->
        acc
    end
  end
end
