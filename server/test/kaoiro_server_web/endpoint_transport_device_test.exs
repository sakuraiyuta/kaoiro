defmodule KaoiroServerWeb.EndpointTransportDeviceTest do
  # The device authorization endpoints over a real Bandit listener and raw
  # HTTP/1.1 (issue 801, design 6.3): the input stage's answers survive
  # the real adapter, including a chunked body. The test endpoint is
  # compiled without Plug.SSL, so a forwarded https header must NOT make a
  # plain http request acceptable here; the rewrite itself is measured on
  # the production image (G56).
  use ExUnit.Case, async: false

  alias KaoiroServerWeb.Endpoint

  @timeout 3_000
  @oauth_env [
    oauth_nextcloud_client_id: "nc-id",
    oauth_nextcloud_client_secret: "nc-secret",
    oauth_nextcloud_base_url: "https://cloud.example"
  ]

  setup do
    Enum.each(@oauth_env, fn {key, value} -> Application.put_env(:kaoiro_server, key, value) end)

    on_exit(fn ->
      Enum.each(Keyword.keys(@oauth_env), &Application.delete_env(:kaoiro_server, &1))
      Application.put_env(:kaoiro_server, :device_auth_allow_insecure_transport, true)
    end)

    # A fresh, still bare, application store: no codes or rate windows
    # left over from earlier tests.
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, KaoiroServer.DeviceAuth)
    {:ok, _pid} = Supervisor.restart_child(KaoiroServer.Supervisor, KaoiroServer.DeviceAuth)

    http = Keyword.merge(Endpoint.config(:http), ip: {127, 0, 0, 1}, port: 0)

    [spec] =
      Bandit.PhoenixAdapter.child_specs(Endpoint,
        otp_app: Endpoint.config(:otp_app),
        code_reloader: Endpoint.config(:code_reloader),
        http: http
      )

    listener = start_supervised!(spec)
    {:ok, {_ip, port}} = ThousandIsland.listener_info(listener)
    {:ok, port: port}
  end

  test "invalid JSON to /oauth/device is 415 with no body, not a ParseError", %{port: port} do
    {status, headers, body} =
      exchange(port, "/oauth/device", [{"content-type", "application/json"}], "{")

    assert status == 415
    assert body == ""
    assert headers["cache-control"] == "no-store"
  end

  test "a 64 KiB body with Content-Length is 413", %{port: port} do
    body = "client_id=" <> String.duplicate("a", 65_536)

    {status, _headers, response} =
      exchange(
        port,
        "/oauth/device",
        [{"content-type", "application/x-www-form-urlencoded"}],
        body
      )

    assert status == 413
    assert Jason.decode!(response) == %{"error" => "invalid_request"}
  end

  test "a 64 KiB chunked body is 413", %{port: port} do
    chunk = "client_id=" <> String.duplicate("a", 65_536)

    {status, _headers, response} =
      exchange(
        port,
        "/oauth/device",
        [{"content-type", "application/x-www-form-urlencoded"}, {"transfer-encoding", "chunked"}],
        {:chunked, [Integer.to_string(byte_size(chunk), 16), "\r\n", chunk, "\r\n0\r\n\r\n"]}
      )

    assert status == 413
    assert Jason.decode!(response) == %{"error" => "invalid_request"}
  end

  test "a typical form is 200 over the real adapter", %{port: port} do
    {status, _headers, response} =
      exchange(
        port,
        "/oauth/device",
        [{"content-type", "application/x-www-form-urlencoded"}],
        "client_id=x"
      )

    assert status == 200
    assert %{"device_code" => _} = Jason.decode!(response)
  end

  describe "without the insecure-transport exception" do
    setup do
      Application.put_env(:kaoiro_server, :device_auth_allow_insecure_transport, false)
    end

    for {label, extra} <- [
          {"plain http", []},
          {"plain http claiming x-forwarded-proto https", [{"x-forwarded-proto", "https"}]}
        ] do
      test "#{label} is 503", %{port: port} do
        {status, _headers, response} =
          exchange(
            port,
            "/oauth/device",
            [{"content-type", "application/x-www-form-urlencoded"} | unquote(extra)],
            "client_id=x"
          )

        assert status == 503
        assert Jason.decode!(response) == %{"error" => "temporarily_unavailable"}
      end
    end
  end

  # Sends one POST and reads the whole response. A body the server stops
  # reading may fail to send; the response is what is asserted.
  defp exchange(port, path, headers, body) do
    {:ok, socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], @timeout)

    try do
      {length_header, payload} =
        case body do
          {:chunked, chunks} -> {[], chunks}
          binary -> {["content-length: #{byte_size(binary)}\r\n"], binary}
        end

      head = [
        "POST #{path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n",
        Enum.map(headers, fn {name, value} -> "#{name}: #{value}\r\n" end),
        length_header,
        "\r\n"
      ]

      :ok = :gen_tcp.send(socket, head)
      _ = :gen_tcp.send(socket, payload)

      :ok = :inet.setopts(socket, packet: :http_bin)
      {:ok, {:http_response, _version, status, _reason}} = :gen_tcp.recv(socket, 0, @timeout)
      headers = recv_headers(socket)
      :ok = :inet.setopts(socket, packet: :raw)

      body =
        case Integer.parse(Map.get(headers, "content-length", "0")) do
          {0, ""} -> ""
          {length, ""} -> elem(:gen_tcp.recv(socket, length, @timeout), 1)
        end

      {status, headers, body}
    after
      :gen_tcp.close(socket)
    end
  end

  defp recv_headers(socket, headers \\ %{}) do
    case :gen_tcp.recv(socket, 0, @timeout) do
      {:ok, :http_eoh} ->
        headers

      {:ok, {:http_header, _index, name, _reserved, value}} ->
        recv_headers(socket, Map.put(headers, String.downcase(to_string(name)), value))
    end
  end
end
