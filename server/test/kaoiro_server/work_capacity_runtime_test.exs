defmodule KaoiroServer.WorkCapacityRuntimeTest do
  use ExUnit.Case, async: false

  @vars ~w(KAOIRO_WORK_NOMINATED_PER_PRINCIPAL KAOIRO_WORK_ACTIVE_PER_ASSIGNEE)
  @runtime Path.expand("../../config/runtime.exs", __DIR__)
  setup do
    old = Map.new(@vars, &{&1, System.get_env(&1)})
    Enum.each(@vars, &System.delete_env/1)

    on_exit(fn ->
      Enum.each(old, fn
        {key, nil} -> System.delete_env(key)
        {key, value} -> System.put_env(key, value)
      end)
    end)
  end

  test "runtime config accepts only unsigned bounded decimal integers, merging only supplied caps" do
    base = Config.Reader.read!(Path.expand("../../config/config.exs", __DIR__), env: :test)
    unset = Config.Reader.read!(@runtime, env: :test)
    merged = Config.Reader.merge(base, unset)
    defaults = merged[:kaoiro_server][:work_store]
    assert defaults[:work_nominated_per_principal] == 16
    assert defaults[:work_active_per_assignee] == 16
    assert defaults[:work_max_records] == 4096

    for {variable, key} <-
          Enum.zip(@vars, [:work_nominated_per_principal, :work_active_per_assignee]) do
      for value <- [0, 1, 2_147_483_647] do
        System.put_env(variable, Integer.to_string(value))
        config = Config.Reader.merge(base, Config.Reader.read!(@runtime, env: :test))
        assert config[:kaoiro_server][:work_store][key] == value

        assert Keyword.delete(config[:kaoiro_server][:work_store], key) ==
                 Keyword.delete(defaults, key)

        assert config[:kaoiro_server][:work_capacity_configured] == [Atom.to_string(key)]
      end

      for bad <- ["", "-1", "1.5", "true", "+1", " 1", "1 ", "1x", "2147483648", "1\n"] do
        System.put_env(variable, bad)

        assert_raise RuntimeError, "#{variable} must be an integer from 0 to 2147483647", fn ->
          Config.Reader.read!(@runtime, env: :test)
        end
      end

      System.delete_env(variable)
    end
  end
end
