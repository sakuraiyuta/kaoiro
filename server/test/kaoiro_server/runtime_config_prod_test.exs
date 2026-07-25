defmodule KaoiroServer.RuntimeConfigProdTest do
  # Evaluates config/runtime.exs directly via Config.Reader against a
  # :prod env, so it exercises the same fail-fast raises a real release
  # boot hits (issue #139) without building one. Mutates process-wide
  # System env vars (PHX_HOST / SECRET_KEY_BASE / KAOIRO_BIND_IP) that no
  # other test reads, but keep this file async: false to avoid any
  # cross-test interleaving of that global state.
  use ExUnit.Case, async: false

  @runtime_exs Path.join([__DIR__, "..", "..", "config", "runtime.exs"])
  @valid_secret String.duplicate("a", 64)

  setup do
    on_exit(fn ->
      System.delete_env("PHX_HOST")
      System.delete_env("SECRET_KEY_BASE")
      System.delete_env("KAOIRO_BIND_IP")
    end)
  end

  describe "PHX_HOST (issue #139)" do
    test "未設定なら fail-fast する" do
      System.put_env("SECRET_KEY_BASE", @valid_secret)
      System.delete_env("PHX_HOST")

      assert_raise RuntimeError, ~r/PHX_HOST is missing/, fn ->
        Config.Reader.read!(@runtime_exs, env: :prod)
      end
    end

    test "設定済みなら endpoint url host に反映される" do
      System.put_env("SECRET_KEY_BASE", @valid_secret)
      System.put_env("PHX_HOST", "example.org")

      config = Config.Reader.read!(@runtime_exs, env: :prod)
      endpoint_config = config[:kaoiro_server][KaoiroServerWeb.Endpoint]

      assert endpoint_config[:url][:host] == "example.org"
    end
  end

  describe "KAOIRO_BIND_IP (issue #139)" do
    setup do
      System.put_env("SECRET_KEY_BASE", @valid_secret)
      System.put_env("PHX_HOST", "example.org")
      :ok
    end

    test "未設定なら prod 既定 (全インターフェース) のまま" do
      System.delete_env("KAOIRO_BIND_IP")

      config = Config.Reader.read!(@runtime_exs, env: :prod)
      endpoint_config = config[:kaoiro_server][KaoiroServerWeb.Endpoint]

      assert endpoint_config[:http][:ip] == {0, 0, 0, 0, 0, 0, 0, 0}
    end

    test "IPv4 を設定すると http.ip が上書きされる" do
      System.put_env("KAOIRO_BIND_IP", "192.168.1.10")

      config = Config.Reader.read!(@runtime_exs, env: :prod)
      endpoint_config = config[:kaoiro_server][KaoiroServerWeb.Endpoint]

      assert endpoint_config[:http][:ip] == {192, 168, 1, 10}
    end

    test "IPv6 を設定すると http.ip が上書きされる" do
      System.put_env("KAOIRO_BIND_IP", "::1")

      config = Config.Reader.read!(@runtime_exs, env: :prod)
      endpoint_config = config[:kaoiro_server][KaoiroServerWeb.Endpoint]

      assert endpoint_config[:http][:ip] == {0, 0, 0, 0, 0, 0, 0, 1}
    end

    test "不正な値は fail-fast する" do
      System.put_env("KAOIRO_BIND_IP", "not-an-ip")

      assert_raise RuntimeError, ~r/invalid KAOIRO_BIND_IP/, fn ->
        Config.Reader.read!(@runtime_exs, env: :prod)
      end
    end

    test ":dev では効かない (issue #139 review must-fix: dev.exs の loopback + " <>
           "既知の secret_key_base を KAOIRO_BIND_IP で誤って公開しないため)" do
      System.put_env("KAOIRO_BIND_IP", "0.0.0.0")

      # Only the :prod block reads KAOIRO_BIND_IP; runtime.exs's env-
      # agnostic top-level config sets `http: [port: ...]` only, so for
      # :dev the resulting http keyword list must carry no :ip key at
      # all — that leaves config/dev.exs's compile-time `ip: {127, 0, 0,
      # 1}}` (loopback) as the sole source of truth for dev's bind IP.
      config = Config.Reader.read!(@runtime_exs, env: :dev)
      endpoint_config = config[:kaoiro_server][KaoiroServerWeb.Endpoint]

      refute Keyword.has_key?(endpoint_config[:http] || [], :ip)
    end
  end
end
