defmodule KaoiroServer.RuntimeProdConfigTest do
  # Mutates the process environment, and evaluates config/runtime.exs the way
  # a release's Config.Provider does.
  use ExUnit.Case, async: false

  @runtime_config Path.expand("../../config/runtime.exs", __DIR__)
  @managed ~w(SECRET_KEY_BASE PHX_HOST RELEASE_COMMAND)

  setup do
    saved = Map.new(@managed, &{&1, System.get_env(&1)})
    Enum.each(@managed, &System.delete_env/1)

    on_exit(fn ->
      for {name, value} <- saved do
        if value, do: System.put_env(name, value), else: System.delete_env(name)
      end
    end)

    :ok
  end

  test "serving still refuses to boot without the required variables" do
    assert_raise RuntimeError, ~r/environment variable .* is missing/, &read_prod_config/0

    # The release launcher assigns RELEASE_COMMAND from its own argv, so this
    # is what the serving path (bin/server -> `kaoiro_server start`) sees.
    System.put_env("RELEASE_COMMAND", "start")

    assert_raise RuntimeError, ~r/environment variable .* is missing/, &read_prod_config/0
  end

  # The deploy CLI probes a built image with `eval` and NO env
  # (docs/specs/deployment.md 4.3). Before issue #310 that aborted here, and
  # the CLI recorded every image as "persistence-path manifest absent".
  test "eval reads the config without them so the deploy CLI can probe an image" do
    System.put_env("RELEASE_COMMAND", "eval")

    endpoint = read_prod_config()[:kaoiro_server][KaoiroServerWeb.Endpoint]

    assert String.length(endpoint[:secret_key_base]) == 64
    assert endpoint[:url][:host] == "release-eval.invalid"
  end

  defp read_prod_config do
    Config.Reader.read!(@runtime_config, env: :prod, target: :host)
  end
end
