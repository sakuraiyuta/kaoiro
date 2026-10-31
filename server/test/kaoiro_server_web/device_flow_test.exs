defmodule KaoiroServerWeb.DeviceFlowTest do
  # End to end over a real listener (issue 801, design 6.2 / 6.3): the
  # application's own DeviceAuth, started bare with no clock or node_list
  # injected, serves one device from issue to a joined WebSocket.
  # async: false — real time, the application's store, process-wide config.
  use ExUnit.Case, async: false

  import KaoiroServer.OAuthAllowlistFixture

  alias KaoiroServer.DeviceAuth
  alias KaoiroServerWeb.Endpoint

  @timeout 5_000
  @form [{"content-type", "application/x-www-form-urlencoded"}]
  @ao %{provider: "nextcloud", uid: "ao"}
  @oauth_env [
    oauth_nextcloud_client_id: "nc-id",
    oauth_nextcloud_client_secret: "nc-secret",
    oauth_nextcloud_base_url: "https://cloud.example"
  ]

  setup do
    Enum.each(@oauth_env, fn {key, value} -> Application.put_env(:kaoiro_server, key, value) end)
    put_allowlist("nextcloud:ao:operator\n")

    on_exit(fn ->
      Enum.each(Keyword.keys(@oauth_env), &Application.delete_env(:kaoiro_server, &1))
      Application.delete_env(:kaoiro_server, :oauth_allowlist_path)
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
    {:ok, base: "http://127.0.0.1:#{port}", port: port}
  end

  test "the application starts DeviceAuth bare" do
    assert KaoiroServer.DeviceAuth in KaoiroServer.Application.children(false)
  end

  test "issue, approve, poll, then use and refresh the token", %{base: base, port: port} do
    assert %{"device" => true} = request(base, :get, "/session/auth-methods").body

    issued_at = System.monotonic_time(:millisecond)
    device = request(base, :post, "/oauth/device", @form, "client_id=kaoiro-client.nvim")
    assert device.status == 200
    %{"device_code" => device_code, "user_code" => user_code} = device.body

    cookie = [{"cookie", session_cookie(@ao)}, {"content-type", "application/json"}]

    lookup =
      request(
        base,
        :post,
        "/session/device/lookup",
        cookie,
        Jason.encode!(%{user_code: user_code})
      )

    assert %{"client_id" => "kaoiro-client.nvim", "role" => "operator"} = lookup.body

    decision =
      request(
        base,
        :post,
        "/session/device/decision",
        cookie,
        Jason.encode!(%{user_code: user_code, decision: "approve"})
      )

    assert decision.body == %{"state" => "approved"}

    # The interval is real here: the first poll is allowed 5 s after issue.
    wait = issued_at + 5_100 - System.monotonic_time(:millisecond)
    if wait > 0, do: Process.sleep(wait)

    token_body =
      URI.encode_query(%{
        "grant_type" => "urn:ietf:params:oauth:grant-type:device_code",
        "device_code" => device_code,
        "client_id" => "kaoiro-client.nvim"
      })

    token = request(base, :post, "/oauth/token", @form, token_body)

    assert %{"access_token" => access_token, "token_type" => "Bearer", "role" => "operator"} =
             token.body

    assert DeviceAuth.count(DeviceAuth) == 0

    bearer = [{"authorization", "Bearer " <> access_token}]
    assert request(base, :get, "/api/personas/fuji", bearer).status == 200
    assert request(base, :get, "/api/personas", bearer).status == 200

    # Refresh round trip: the new token works, and the old one still does
    # within its sliding lifetime (there is no per-token revocation).
    refreshed = request(base, :get, "/session/refresh", bearer)
    assert %{"access_token" => new_token} = refreshed.body

    assert request(base, :get, "/api/personas", [{"authorization", "Bearer " <> new_token}]).status ==
             200

    assert request(base, :get, "/api/personas", bearer).status == 200

    %{"ticket" => ticket} = request(base, :get, "/session/ticket", bearer).body
    assert {:ok, reply} = join_lobby(port, ticket)
    assert reply["status"] == "ok"
  end

  test "a forged ticket is refused at the WebSocket upgrade", %{port: port} do
    assert {:error, 403} = join_lobby(port, "forged")
  end

  defp request(base, method, path, headers \\ [], body \\ "") do
    Req.request!(
      method: method,
      url: base <> path,
      headers: headers,
      body: body,
      retry: false,
      redirect: false,
      decode_body: true
    )
  end

  # A real session cookie for `identity`, minted by one in-process request
  # through the same endpoint, so the HTTP leg below carries a cookie the
  # listener can read.
  defp session_cookie(identity) do
    conn =
      Phoenix.ConnTest.build_conn()
      |> Plug.Test.init_test_session(%{"oauth_identity" => identity})
      |> Phoenix.ConnTest.dispatch(Endpoint, :get, "/session/refresh")

    [set_cookie | _] = Plug.Conn.get_resp_header(conn, "set-cookie")
    set_cookie |> String.split(";") |> hd()
  end

  defp join_lobby(port, ticket) do
    {:ok, socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], @timeout)

    try do
      :ok = :inet.setopts(socket, packet: :http_bin)
      key = Base.encode64(:crypto.strong_rand_bytes(16))

      :ok =
        :gen_tcp.send(socket, [
          "GET /client/websocket?vsn=2.0.0&ticket=#{URI.encode_www_form(ticket)} HTTP/1.1\r\n",
          "Host: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n",
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: #{key}\r\n\r\n"
        ])

      case :gen_tcp.recv(socket, 0, @timeout) do
        {:ok, {:http_response, _version, 101, _reason}} ->
          skip_headers(socket)
          :ok = :inet.setopts(socket, packet: :raw)
          send_frame(socket, Jason.encode!(["1", "1", "agents:lobby", "phx_join", %{}]))
          {:ok, await_reply(socket, "1")}

        {:ok, {:http_response, _version, status, _reason}} ->
          {:error, status}
      end
    after
      :gen_tcp.close(socket)
    end
  end

  defp skip_headers(socket) do
    case :gen_tcp.recv(socket, 0, @timeout) do
      {:ok, :http_eoh} -> :ok
      {:ok, {:http_header, _, _, _, _}} -> skip_headers(socket)
    end
  end

  defp send_frame(socket, payload) do
    mask = :crypto.strong_rand_bytes(4)

    masked =
      for {byte, index} <- Enum.with_index(:binary.bin_to_list(payload)), into: <<>> do
        <<Bitwise.bxor(byte, :binary.at(mask, rem(index, 4)))>>
      end

    length_bytes =
      if byte_size(payload) < 126,
        do: <<0x80 + byte_size(payload)>>,
        else: <<0x80 + 126, byte_size(payload)::16>>

    :ok = :gen_tcp.send(socket, [<<0x81>>, length_bytes, mask, masked])
  end

  # Server frames until the phx_reply for `ref`; pushes before it are skipped.
  defp await_reply(socket, ref) do
    {:ok, <<_fin_opcode, length>>} = :gen_tcp.recv(socket, 2, @timeout)

    length =
      case length do
        126 -> elem(:gen_tcp.recv(socket, 2, @timeout), 1) |> :binary.decode_unsigned()
        127 -> elem(:gen_tcp.recv(socket, 8, @timeout), 1) |> :binary.decode_unsigned()
        short -> short
      end

    {:ok, payload} = :gen_tcp.recv(socket, length, @timeout)

    case Jason.decode!(payload) do
      [_join_ref, ^ref, "agents:lobby", "phx_reply", reply] -> reply
      _push -> await_reply(socket, ref)
    end
  end
end
