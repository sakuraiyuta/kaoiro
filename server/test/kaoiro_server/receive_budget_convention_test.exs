defmodule KaoiroServer.ReceiveBudgetConventionTest do
  @moduledoc """
  Forbids an integer literal as the timeout of an assert-direction receive
  assertion (issue #331).

  Such a literal does not scale with `:assert_receive_timeout`, which
  `test_helper.exs` raises to 500 under `CI` (issue #282). A literal chosen
  against the local default therefore loses its headroom in CI — the one
  environment whose contention made someone write it. Issue #320 flake C
  was that, at 500 ms.

  The refute direction is deliberately NOT checked: `:refute_receive_timeout`
  was never raised, so those literals did not change meaning. They fail
  toward a false PASS under load, which is a different defect and wants its
  own decision.
  """
  use ExUnit.Case, async: true

  # Timeout argument position, 0-based, per macro. Taken from the macro
  # heads: `assert_receive(pattern, timeout, failure_message)`,
  # `assert_push(event, payload, timeout)`,
  # `assert_broadcast(event, payload, timeout)`,
  # `assert_reply(ref, status, payload, timeout)`.
  @timeout_arg %{assert_receive: 1, assert_push: 2, assert_broadcast: 2, assert_reply: 3}

  @roots ["test"]

  test "no assert-direction receive assertion carries a literal timeout" do
    files = source_files()

    # Anti-vacuity: a scan that silently found nothing to read would
    # otherwise report a clean tree.
    assert length(files) >= 50

    violations = Enum.flat_map(files, &violations_in_file/1)

    assert violations == [],
           "literal receive budgets found; use KaoiroServer.TestTimeouts instead:\n" <>
             Enum.map_join(violations, "\n", fn {file, line, name, value} ->
               "  #{file}:#{line} #{name} ... , #{value}"
             end)
  end

  test "a literal at an existing site's shape is reported" do
    source = """
    test "x" do
      assert_receive {:DOWN, ^monitor_ref, :process, ^channel_pid, :shutdown}, 500
    end
    """

    assert [{_, 2, :assert_receive, 500}] = violations_in_source(source, "inline")
  end

  test "a literal at a newly added site's shape is reported" do
    source = """
    test "x" do
      ref = push(socket, "delete_agent", %{})
      assert_reply ref, :ok, %{}, 1000
    end
    """

    assert [{_, 3, :assert_reply, 1000}] = violations_in_source(source, "inline")
  end

  test "the qualified call form is reported too" do
    source = """
    test "x" do
      ExUnit.Assertions.assert_receive {:done, ^ref}, 250
    end
    """

    assert [{_, 2, :assert_receive, 250}] = violations_in_source(source, "inline")
  end

  test "a derived budget is not reported" do
    source = """
    test "x" do
      assert_receive {:DOWN, ^ref, :process, ^pid, _}, TestTimeouts.out_of_band()
      assert_reply ref, :ok, %{}, @purge_reply_timeout
      assert_receive {:done, ^ref}
    end
    """

    assert violations_in_source(source, "inline") == []
  end

  test "an integer that is not the timeout argument is not reported" do
    source = """
    test "x" do
      assert_push "snapshot", %{"count" => 3}
      assert_broadcast "agent_deleted", %{"agent_id" => ^id}
      assert_receive {:tally, 7}
    end
    """

    assert violations_in_source(source, "inline") == []
  end

  test "the refute direction is out of scope" do
    source = """
    test "x" do
      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 50
      refute_push "envelope", _, 50
    end
    """

    assert violations_in_source(source, "inline") == []
  end

  test "source carrying no assertion at all is reported clean" do
    source = """
    # A budget of 500 ms is mentioned here in prose, and 1000 appears in a
    # comment, but nothing asserts anything.
    defmodule Doc do
      @moduledoc "500"
      def n, do: 1000
    end
    """

    assert violations_in_source(source, "inline") == []
  end

  defp source_files do
    Enum.flat_map(@roots, fn root ->
      Path.wildcard(Path.join(root, "**/*.{ex,exs}"))
    end)
  end

  defp violations_in_file(file) do
    file |> File.read!() |> violations_in_source(file)
  end

  defp violations_in_source(source, file) do
    source
    |> Code.string_to_quoted!()
    |> collect(file)
  end

  defp collect(ast, file) do
    {_ast, found} =
      Macro.prewalk(ast, [], fn node, acc ->
        case literal_budget(node) do
          nil -> {node, acc}
          {line, name, value} -> {node, [{file, line, name, value} | acc]}
        end
      end)

    Enum.reverse(found)
  end

  # Matches on the assertion's NAME, not on how it was qualified: a
  # `ExUnit.Assertions.assert_receive` call is the same defect as a bare one.
  defp literal_budget({{:., _, [_module, name]}, meta, args}), do: budget(name, meta, args)
  defp literal_budget({name, meta, args}) when is_atom(name), do: budget(name, meta, args)
  defp literal_budget(_), do: nil

  defp budget(name, meta, args) when is_list(args) do
    with index when is_integer(index) <- Map.get(@timeout_arg, name),
         value when is_integer(value) <- Enum.at(args, index) do
      {Keyword.get(meta, :line), name, value}
    else
      _ -> nil
    end
  end

  defp budget(_name, _meta, _args), do: nil
end
