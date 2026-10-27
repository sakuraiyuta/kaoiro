defmodule KaoiroServerWeb.EndpointTransportTest do
  use ExUnit.Case, async: false

  alias KaoiroServerWeb.Endpoint

  @config_dir Path.expand("../../config", __DIR__)
  @timeout 3_000

  setup do
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

  test "production runtime overrides preserve the HTTP/2 restriction" do
    overrides = %{
      "SECRET_KEY_BASE" => String.duplicate("a", 64),
      "PHX_HOST" => "example.invalid",
      "KAOIRO_BIND_IP" => "127.0.0.1",
      "PORT" => "4123"
    }

    saved = Map.new(overrides, fn {key, _value} -> {key, System.get_env(key)} end)
    System.put_env(overrides)

    try do
      base = Config.Reader.read!(Path.join(@config_dir, "config.exs"), env: :prod)
      runtime = Config.Reader.read!(Path.join(@config_dir, "runtime.exs"), env: :prod)
      config = Config.Reader.merge(base, runtime)
      http = config[:kaoiro_server][Endpoint][:http]

      assert http[:http_2_options][:enabled] == false
      assert http[:port] == 4123
      assert http[:ip] == {127, 0, 0, 1}
    after
      for {key, value} <- saved do
        if value, do: System.put_env(key, value), else: System.delete_env(key)
      end
    end
  end

  test "rejects HTTP/1.1 requests with userinfo in the absolute-form URI", %{port: port} do
    with_socket(port, fn socket ->
      :ok = :inet.setopts(socket, packet: :http_bin)

      :ok =
        :gen_tcp.send(socket, [
          "GET http://user@evil.example/api/health HTTP/1.1\r\n",
          "Host: localhost\r\n\r\n"
        ])

      assert {:ok, {:http_response, _version, 400, _reason}} =
               :gen_tcp.recv(socket, 0, @timeout)
    end)
  end

  test "accepts an absolute-form request whose authority matches the Host header", %{
    port: port
  } do
    with_socket(port, fn socket ->
      :ok = :inet.setopts(socket, packet: :http_bin)

      :ok =
        :gen_tcp.send(socket, [
          "GET http://localhost/api/health HTTP/1.1\r\n",
          "Host: localhost\r\n\r\n"
        ])

      assert {:ok, {:http_response, _version, 200, _reason}} =
               :gen_tcp.recv(socket, 0, @timeout)
    end)
  end

  test "the same listener serves HTTP/1.1 health and closes h2c without sending bytes", %{
    port: port
  } do
    response =
      Req.get!("http://127.0.0.1:#{port}/api/health",
        connect_options: [protocols: [:http1]],
        receive_timeout: @timeout,
        retry: false
      )

    assert response.status == 200
    assert response.body["status"] == "ok"

    with_socket(port, fn socket ->
      :ok =
        :gen_tcp.send(socket, [
          "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
          <<0::24, 4, 0, 0::32>>
        ])

      assert {:error, :closed} = :gen_tcp.recv(socket, 0, @timeout)
    end)
  end

  for {label, extension} <- [{"bare LF", ";a=b\nc=d"}, {"valid", ";a=b"}] do
    @extension extension
    @invalid label == "bare LF"
    @tag :bandit_chunk_extension
    test "#{label} chunk extension is checked before routing", %{port: port} do
      with_socket(port, fn socket ->
        :ok = :inet.setopts(socket, packet: :http_bin)

        :ok =
          :gen_tcp.send(socket, [
            "POST /api/health HTTP/1.1\r\nHost: localhost\r\n",
            "Content-Type: application/x-www-form-urlencoded\r\n",
            "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            "3",
            @extension,
            "\r\na=b\r\n0\r\n\r\n"
          ])

        assert {:ok, {:http_response, _version, status, _reason}} =
                 :gen_tcp.recv(socket, 0, @timeout)

        if @invalid do
          assert status == 400
        else
          # Plug.Parsers reads the body before the missing POST route produces 404.
          refute status == 400
        end
      end)
    end
  end

  describe "HTTP/1.1 WebSockets" do
    setup do
      saved = Application.fetch_env(:kaoiro_server, :client_tokens)
      token = Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)
      Application.put_env(:kaoiro_server, :client_tokens, "#{token}:viewer")

      on_exit(fn ->
        case saved do
          {:ok, value} -> Application.put_env(:kaoiro_server, :client_tokens, value)
          :error -> Application.delete_env(:kaoiro_server, :client_tokens)
        end
      end)

      {:ok, token: token}
    end

    for path <- ["/wrapper", "/runner", "/client"],
        {extensions, suffix} <- [
          {nil, ""},
          {"permessage-deflate; client_max_window_bits", " with a valid extension offer"}
        ] do
      @path path
      @extensions extensions
      test "#{path} upgrades and replies to a Phoenix heartbeat#{suffix}", %{
        port: port,
        token: token
      } do
        with_socket(port, fn socket ->
          key = send_upgrade(socket, @path, token, @extensions)

          assert {:ok, {:http_response, {1, 1}, 101, _reason}} =
                   :gen_tcp.recv(socket, 0, @timeout)

          headers = recv_headers(socket)

          expected =
            Base.encode64(:crypto.hash(:sha, key <> "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))

          assert headers["sec-websocket-accept"] == expected
          refute Map.has_key?(headers, "sec-websocket-extensions")
          :ok = :inet.setopts(socket, packet: :raw)

          payload = Jason.encode!([nil, "1", "phoenix", "heartbeat", %{}])
          mask = :crypto.strong_rand_bytes(4)

          masked =
            for {byte, index} <- Enum.with_index(:binary.bin_to_list(payload)), into: <<>> do
              <<Bitwise.bxor(byte, :binary.at(mask, rem(index, 4)))>>
            end

          :ok = :gen_tcp.send(socket, [<<0x81, 0x80 + byte_size(payload)>>, mask, masked])
          assert {:ok, <<0x81, length>>} = :gen_tcp.recv(socket, 2, @timeout)
          assert length < 126
          assert {:ok, reply} = :gen_tcp.recv(socket, length, @timeout)

          assert Jason.decode!(reply) == [
                   nil,
                   "1",
                   "phoenix",
                   "phx_reply",
                   %{"status" => "ok", "response" => %{}}
                 ]
        end)
      end
    end

    for path <- ["/wrapper", "/runner", "/client"] do
      @path path
      test "#{path} rejects a malformed extension offer", %{port: port, token: token} do
        with_socket(port, fn socket ->
          send_upgrade(socket, @path, token, "permessage-deflate; =x")

          assert {:ok, {:http_response, _version, 400, _reason}} =
                   :gen_tcp.recv(socket, 0, @timeout)
        end)
      end
    end
  end

  defp send_upgrade(socket, path, token, extensions) do
    :ok = :inet.setopts(socket, packet: :http_bin)
    key = Base.encode64(:crypto.strong_rand_bytes(16))
    target = "#{path}/websocket?vsn=2.0.0&token=#{token}"
    extension_header = if extensions, do: "Sec-WebSocket-Extensions: #{extensions}\r\n", else: ""

    :ok =
      :gen_tcp.send(socket, [
        "GET #{target} HTTP/1.1\r\nHost: localhost\r\n",
        "Connection: Upgrade\r\nUpgrade: websocket\r\n",
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: #{key}\r\n",
        extension_header,
        "\r\n"
      ])

    key
  end

  defp with_socket(port, fun) do
    {:ok, socket} =
      :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], @timeout)

    try do
      fun.(socket)
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
