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
  test "every DetsStorePath fallback in lib is declared with the same file" do
    fallbacks = dets_fallbacks_in_lib()

    declared =
      PersistencePaths.stores()
      |> Enum.map(&{&1.config_key, &1.default_file})
      |> MapSet.new()

    assert MapSet.size(fallbacks) >= 12, "the source scan matched nothing"

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

  defp dets_fallbacks_in_lib do
    pattern =
      ~r/Application\.get_env\(:kaoiro_server, :([a-z_]+)\)\s*\|\|\s*KaoiroServer\.DetsStorePath\.default_path\("([^"]+)"\)/

    Path.expand("../../lib/kaoiro_server", __DIR__)
    |> Path.join("**/*.ex")
    |> Path.wildcard()
    |> Enum.flat_map(fn file ->
      pattern
      |> Regex.scan(File.read!(file))
      |> Enum.map(fn [_, key, filename] -> {String.to_atom(key), filename} end)
    end)
    |> MapSet.new()
  end
end
