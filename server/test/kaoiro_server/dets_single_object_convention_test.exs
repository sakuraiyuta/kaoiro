defmodule KaoiroServer.DetsSingleObjectConventionTest do
  @moduledoc """
  Forbids writing more than one DETS object per call (issue #436).

  DETS documents no atomicity for a list passed to `insert/2`, so a decision
  spread over a list can be half-written by a crash. Every `:dets.insert` /
  `:dets.insert_new` in `lib/` must therefore pass one record: a tuple
  literal, or a call to a helper named in `@record_helpers` whose every
  clause is checked here to end in a tuple literal.

  Anything this scan cannot decide — a variable, any other call, a piped
  call — is reported, not assumed safe.
  """
  use ExUnit.Case, async: true

  # Name and arity of each private helper that builds one record.
  @record_helpers [entry_record: 2, loss_record: 1]

  @inserts [:insert, :insert_new]

  @roots ["lib"]

  test "every DETS insert in lib writes a single record" do
    files = Enum.flat_map(@roots, &Path.wildcard(Path.join(&1, "**/*.ex")))
    scans = Enum.map(files, &scan(File.read!(&1), &1))

    # Anti-vacuity: a scan that found no insert at all would report clean.
    assert scans |> Enum.map(& &1.sites) |> Enum.sum() >= 20

    violations = Enum.flat_map(scans, & &1.violations)

    assert violations == [],
           "multi-object or undecidable DETS inserts found:\n" <>
             Enum.map_join(violations, "\n", fn {file, line, reason} ->
               "  #{file}:#{line} #{reason}"
             end)
  end

  test "a tuple literal of any size is accepted" do
    source = """
    def put(table, id, value) do
      :ok = :dets.insert(table, {id, value})
      :ok = :dets.insert(table, {id, value, 1, 2})
      :ok = :dets.insert_new(table, {{:counter, id}, 0})
    end
    """

    assert %{sites: 3, violations: []} = scan(source, "inline")
  end

  test "a list literal is reported" do
    source = """
    def put(table, a, b) do
      :dets.insert(table, [{a, 1}, {b, 2}])
    end
    """

    assert %{violations: [{"inline", 2, reason}]} = scan(source, "inline")
    assert reason =~ "not a single record"
  end

  test "a cons at the existing site's former shape is reported" do
    source = """
    defp persist(state, id, entry) do
      :ok = :dets.insert(state.table, [entry_record(id, entry) | records])
    end
    """

    assert %{violations: [{"inline", 2, _}]} = scan(source, "inline")
  end

  test "a variable is reported because its shape is undecidable" do
    source = """
    def put(table, records) do
      :dets.insert(table, records)
    end
    """

    assert %{violations: [{"inline", 2, _}]} = scan(source, "inline")
  end

  test "insert_new is covered too" do
    source = """
    def put(table, a, b) do
      :dets.insert_new(table, [{a, 1}, {b, 2}])
    end
    """

    assert %{violations: [{"inline", 2, _}]} = scan(source, "inline")
  end

  test "a helper that is not listed is reported even though it is a call" do
    source = """
    def put(table, id) do
      :dets.insert(table, records_for(id))
    end

    defp records_for(id) do
      [{id, 1}, {{:loss, id}, 2}]
    end
    """

    assert %{violations: [{"inline", 2, _}]} = scan(source, "inline")
  end

  test "a listed helper is accepted when every clause ends in a tuple literal" do
    source = """
    def put(table, id, entry) do
      :dets.insert(table, entry_record(id, entry))
    end

    defp entry_record(id, %{legacy: true} = entry) do
      {id, entry.generation}
    end

    defp entry_record(id, entry) do
      extra = Map.take(entry, [:a])
      {id, entry.generation, entry.issued, extra}
    end
    """

    assert %{sites: 1, violations: []} = scan(source, "inline")
  end

  test "a listed helper with a clause that returns a list is reported" do
    source = """
    def put(table, id, entry) do
      :dets.insert(table, entry_record(id, entry))
    end

    defp entry_record(id, %{legacy: true} = entry) do
      {id, entry.generation}
    end

    defp entry_record(id, entry) do
      [{id, entry.generation}, {{:loss, id}, entry}]
    end
    """

    assert %{violations: [{"inline", 9, reason}]} = scan(source, "inline")
    assert reason =~ "entry_record/2"
  end

  test "a listed helper that the file does not define is reported" do
    source = """
    def put(table, intent) do
      :dets.insert(table, loss_record(intent))
    end
    """

    assert %{violations: [{"inline", 2, reason}]} = scan(source, "inline")
    assert reason =~ "loss_record/1"
  end

  test "a piped insert is reported because the record is not in view" do
    source = """
    def put(table, id) do
      table |> :dets.insert({id, 1})
    end
    """

    assert %{violations: [{"inline", 2, _}]} = scan(source, "inline")
  end

  test "source with no DETS insert is clean and counts no site" do
    source = """
    # :dets.insert(table, [a, b]) appears only in this comment.
    def get(table, id), do: :dets.lookup(table, id)
    """

    assert %{sites: 0, violations: []} = scan(source, "inline")
  end

  defp scan(source, file) do
    ast = Code.string_to_quoted!(source)

    {_ast, sites} =
      Macro.prewalk(ast, [], fn node, acc ->
        case insert_site(node) do
          nil -> {node, acc}
          site -> {node, [site | acc]}
        end
      end)

    clauses = helper_clauses(ast)

    violations =
      sites
      |> Enum.reverse()
      |> Enum.flat_map(fn {line, args} -> site_violations(line, args, clauses) end)
      |> Enum.uniq()
      |> Enum.map(fn {line, reason} -> {file, line, reason} end)

    %{sites: length(sites), violations: violations}
  end

  defp insert_site({{:., _, [:dets, function]}, meta, args})
       when function in @inserts and is_list(args),
       do: {Keyword.get(meta, :line), args}

  defp insert_site(_node), do: nil

  defp site_violations(line, [_table, record], clauses) do
    cond do
      tuple_literal?(record) ->
        []

      helper = listed_helper(record) ->
        helper_violations(line, helper, Map.get(clauses, helper, []))

      true ->
        [{line, "the inserted term is not a single record: #{Macro.to_string(record)}"}]
    end
  end

  defp site_violations(line, _args, _clauses),
    do: [{line, "DETS insert is not called as insert(table, record)"}]

  defp helper_violations(line, {name, arity}, []),
    do: [{line, "#{name}/#{arity} is listed as a record helper but not defined in this file"}]

  defp helper_violations(_line, {name, arity}, clauses) do
    for {clause_line, result} <- clauses, not tuple_literal?(result) do
      {clause_line, "record helper #{name}/#{arity} has a clause that does not end in a tuple"}
    end
  end

  defp listed_helper({name, _meta, args}) when is_atom(name) and is_list(args) do
    helper = {name, length(args)}
    if helper in @record_helpers, do: helper
  end

  defp listed_helper(_node), do: nil

  # A two-element tuple is its own AST; larger ones are `{:{}, meta, elems}`.
  defp tuple_literal?({:{}, _meta, elements}) when is_list(elements), do: true
  defp tuple_literal?({_left, _right}), do: true
  defp tuple_literal?(_node), do: false

  # %{{name, arity} => [{line, last_expression}]} for every listed helper
  # clause the source defines.
  defp helper_clauses(ast) do
    {_ast, clauses} =
      Macro.prewalk(ast, %{}, fn node, acc ->
        case helper_clause(node) do
          nil -> {node, acc}
          {helper, clause} -> {node, Map.update(acc, helper, [clause], &(&1 ++ [clause]))}
        end
      end)

    clauses
  end

  defp helper_clause({definition, meta, [head, body]})
       when definition in [:def, :defp] and is_list(body) do
    with {name, _, args} when is_atom(name) and is_list(args) <- unguarded(head),
         helper = {name, length(args)},
         true <- helper in @record_helpers,
         {:ok, expression} <- Keyword.fetch(body, :do) do
      {helper, {Keyword.get(meta, :line), last_expression(expression)}}
    else
      _ -> nil
    end
  end

  defp helper_clause(_node), do: nil

  defp unguarded({:when, _meta, [head, _guard]}), do: head
  defp unguarded(head), do: head

  defp last_expression({:__block__, _meta, expressions}), do: List.last(expressions)
  defp last_expression(expression), do: expression
end
