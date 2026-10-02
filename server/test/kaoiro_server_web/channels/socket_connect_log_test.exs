defmodule KaoiroServerWeb.SocketConnectLogTest do
  # Raises the global Logger level, so it cannot run beside other modules.
  use KaoiroServerWeb.ChannelCase, async: false

  import ExUnit.CaptureLog

  alias KaoiroServerWeb.{ClientSocket, RunnerSocket, WrapperSocket}

  setup do
    level = Logger.level()
    Logger.configure(level: :info)
    on_exit(fn -> Logger.configure(level: level) end)
    :ok
  end

  defp connect_log(socket, params) do
    capture_log(fn -> connect(socket, params) end)
  end

  test "a client ticket is filtered from the connect log" do
    log = connect_log(ClientSocket, %{"ticket" => "probe-ticket-value", "probe" => "kept"})

    assert log =~ ~s("ticket" => "[FILTERED]")
    refute log =~ "probe-ticket-value"
  end

  test "wrapper and runner tokens are filtered from the connect log" do
    for socket <- [WrapperSocket, RunnerSocket] do
      log = connect_log(socket, %{"token" => "probe-token-value", "probe" => "kept"})

      assert log =~ ~s("token" => "[FILTERED]")
      refute log =~ "probe-token-value"
    end
  end

  test "every credential-shaped param is filtered and diagnostics are kept" do
    keys =
      ~w(password passwd server_token ticket client_secret authorization cookie apikey api_key credential)

    params = Map.new(keys, &{&1, "probe-#{&1}-value"}) |> Map.put("probe", "kept")
    log = connect_log(WrapperSocket, params)

    for key <- keys do
      assert log =~ ~s("#{key}" => "[FILTERED]")
      refute log =~ "probe-#{key}-value"
    end

    assert log =~ ~s("probe" => "kept")
  end
end
