defmodule KaoiroServer.PersistencePathsTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.DetsStorePath
  alias KaoiroServer.PersistencePaths

  # docs/specs/deployment.md, "The contract #310 must satisfy". An element
  # that is not exactly these four keys makes the deploy CLI throw
  # DeployError — it is treated as actively wrong, not as absent — so every
  # update fails until it is fixed.
  @contract_keys [:default_file, :default_path, :env, :store]

  test "manifest entries carry exactly the four contract keys" do
    entries = PersistencePaths.manifest()
    assert entries != []

    for entry <- entries do
      assert Enum.sort(Map.keys(entry)) == @contract_keys

      for {key, value} <- entry do
        assert is_binary(value) and value != "",
               "#{key} must be a non-empty string: #{inspect(entry)}"
      end

      # The CLI embeds `env` in a RegExp over `.env`'s own text and rejects
      # anything that is not a POSIX shell identifier (クロエ round 4 A-SF-1).
      assert entry.env =~ ~r/^[A-Za-z_][A-Za-z0-9_]*$/
      assert Path.type(entry.default_path) == :absolute
    end

    envs = Enum.map(entries, & &1.env)
    assert Enum.uniq(envs) == envs

    stores = Enum.map(entries, & &1.store)
    assert Enum.uniq(stores) == stores
  end

  test "manifest round-trips through JSON (the shape the CLI parses)" do
    decoded = PersistencePaths.manifest() |> Jason.encode!() |> Jason.decode!()

    assert length(decoded) == length(PersistencePaths.stores())

    for entry <- decoded do
      assert Enum.sort(Map.keys(entry)) == ~w(default_file default_path env store)
    end
  end

  # `default_path` is a claim about what the store module itself falls back
  # to, so read that decision out of each module instead of trusting the
  # copy. The set comparison is the issue #217 guard: a store that resolves
  # through DetsStorePath but is missing from the list escapes compose, the
  # sample `.env` and the backup set at once.
  test "every DetsStorePath fallback in the app is declared with the same file" do
    fallbacks = dets_fallbacks_in_app()

    declared =
      PersistencePaths.stores()
      |> Enum.map(&{&1.config_key, &1.default_file})
      |> MapSet.new()

    assert MapSet.size(fallbacks) >= 12, "the artifact scan matched nothing"

    manifest = Map.new(PersistencePaths.manifest(), &{&1.store, &1})

    for store <- PersistencePaths.stores() do
      assert MapSet.member?(fallbacks, {store.config_key, store.default_file}),
             "#{store.store}: no module falls back to " <>
               "DetsStorePath.default_path(#{inspect(store.default_file)}) " <>
               "behind :#{store.config_key}"

      assert manifest[store.store].default_path ==
               DetsStorePath.default_path(store.default_file)
    end

    undeclared = MapSet.difference(fallbacks, declared)

    assert MapSet.equal?(undeclared, MapSet.new()),
           "DETS stores that escape the canonical list (issue #217 class): " <>
             inspect(MapSet.to_list(undeclared))
  end

  # The point of the list is that runtime.exs stops carrying a per-store
  # branch that can drift from it (issue #310).
  test "runtime.exs applies the list instead of one branch per store" do
    source = File.read!(Path.expand("../../config/runtime.exs", __DIR__))

    assert source =~ "for store <- KaoiroServer.PersistencePaths.stores() do"

    for store <- PersistencePaths.stores() do
      refute source =~ store.env,
             "config/runtime.exs still mentions #{store.env} literally"
    end
  end

  # Reads the COMPILED artifact, never the source. A source regex only ever
  # matches the spellings it was written for: the alias form
  # (`DetsStorePath.default_path/1` after `alias`), a filename held in a
  # module attribute, and `Application.get_env/3` all slipped past the
  # previous one (クロエ #310 round 1 M-1, measured 2026-09-07). By the time
  # a module is compiled, aliases are resolved to full atoms and attributes
  # and macros are expanded, so this sees one canonical form regardless of
  # how the store spells it.
  defp dets_fallbacks_in_app do
    modules = Application.spec(:kaoiro_server, :modules) || []

    modules
    |> Enum.reject(&(&1 == PersistencePaths))
    |> Enum.flat_map(&fallbacks_in/1)
    |> MapSet.new()
  end

  defp fallbacks_in(module) do
    # `:code.which/1` answers `:cover_compiled` under `mix test --cover`, so
    # every module falls to the else branch and the caller's own "matched
    # nothing" assertion fails rather than reporting a clean scan.
    with beam when is_list(beam) <- :code.which(module),
         {:ok, {_module, [debug_info: {:debug_info_v1, :elixir_erl, {:elixir_v1, info, _}}]}} <-
           :beam_lib.chunks(beam, [:debug_info]) do
      Enum.flat_map(info.definitions, &fallbacks_in_definition/1)
    else
      _ -> []
    end
  end

  # Paired within one definition: every store resolves its fallback in the
  # same function that reads its config key. An unpaired key (nil) or a
  # computed filename (:non_literal) matches no declared entry and is
  # therefore reported rather than skipped.
  defp fallbacks_in_definition({_signature, _kind, _meta, clauses}) do
    ast = Enum.map(clauses, &Tuple.to_list/1)
    key = List.first(collect(ast, :config_key))

    for file <- collect(ast, :fallback_file), do: {key, file}
  end

  @env_readers [:get_env, :fetch_env, :fetch_env!, :compile_env, :compile_env!]

  defp collect(ast, what) do
    {_ast, found} =
      Macro.prewalk(ast, [], fn
        {{:., _, [KaoiroServer.DetsStorePath, :default_path]}, _, [arg]} = node, acc
        when what == :fallback_file ->
          {node, [if(is_binary(arg), do: arg, else: :non_literal) | acc]}

        {{:., _, [Application, reader]}, _, [:kaoiro_server, key | _]} = node, acc
        when what == :config_key and reader in @env_readers and is_atom(key) ->
          {node, [key | acc]}

        node, acc ->
          {node, acc}
      end)

    Enum.reverse(found)
  end
end
