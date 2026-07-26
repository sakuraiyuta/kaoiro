defmodule KaoiroServer.ApplicationTest do
  # verify_plain_http_config!/0 compares the compile-baked
  # :plain_http_build flag (set only by config/prod.exs) with the runtime
  # KAOIRO_PLAIN_HTTP env var. Mutates global app env + System env that
  # no other test reads, but keep async: false to avoid interleaving.
  use ExUnit.Case, async: false

  setup do
    on_exit(fn ->
      Application.delete_env(:kaoiro_server, :plain_http_build)
      System.delete_env("KAOIRO_PLAIN_HTTP")
    end)
  end

  test "dev/test (flag 未設定) では env の値に関わらず :ok" do
    Application.delete_env(:kaoiro_server, :plain_http_build)
    System.put_env("KAOIRO_PLAIN_HTTP", "true")

    assert KaoiroServer.Application.verify_plain_http_config!() == :ok
  end

  test "build と runtime が一致すれば :ok" do
    Application.put_env(:kaoiro_server, :plain_http_build, true)
    System.put_env("KAOIRO_PLAIN_HTTP", "true")
    assert KaoiroServer.Application.verify_plain_http_config!() == :ok

    Application.put_env(:kaoiro_server, :plain_http_build, false)
    System.delete_env("KAOIRO_PLAIN_HTTP")
    assert KaoiroServer.Application.verify_plain_http_config!() == :ok
  end

  test "TLS build を KAOIRO_PLAIN_HTTP=true で起動すると raise" do
    Application.put_env(:kaoiro_server, :plain_http_build, false)
    System.put_env("KAOIRO_PLAIN_HTTP", "true")

    assert_raise RuntimeError, ~r/KAOIRO_PLAIN_HTTP mismatch/, fn ->
      KaoiroServer.Application.verify_plain_http_config!()
    end
  end

  test "plain-HTTP build を env なしで起動すると raise" do
    Application.put_env(:kaoiro_server, :plain_http_build, true)
    System.delete_env("KAOIRO_PLAIN_HTTP")

    assert_raise RuntimeError, ~r/KAOIRO_PLAIN_HTTP mismatch/, fn ->
      KaoiroServer.Application.verify_plain_http_config!()
    end
  end
end
