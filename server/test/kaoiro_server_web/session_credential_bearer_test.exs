defmodule KaoiroServerWeb.SessionCredentialBearerTest do
  # Device access tokens (issue 801) on the endpoints that accept them:
  # persona HTTP (RequireAuthenticatedPlug / RequireOperatorPlug),
  # GET /session/ticket and GET /session/refresh.
  #
  # async: false — mutates the allow-list path, :client_tokens and the
  # insecure-transport exception, and subscribes to socket topics.
  use KaoiroServerWeb.ConnCase, async: false

  import KaoiroServer.OAuthAllowlistFixture

  alias KaoiroServer.{Auth, DeviceAccessToken}
  alias KaoiroServerWeb.ClientSocket

  @day 86_400
  # ao is an operator and mio a viewer on the allow-list below.
  @ao %{provider: "nextcloud", uid: "ao"}
  @mio %{provider: "nextcloud", uid: "mio"}
  @allowlist "nextcloud:ao:operator\nnextcloud:mio:viewer\n"
  @prod_exs Path.join([__DIR__, "..", "..", "config", "prod.exs"])

  setup do
    Application.delete_env(:kaoiro_server, :client_tokens)
    put_allowlist(@allowlist)

    on_exit(fn ->
      Application.delete_env(:kaoiro_server, :oauth_allowlist_path)
      Application.put_env(:kaoiro_server, :device_auth_allow_insecure_transport, true)
    end)

    :ok
  end

  defp now, do: System.system_time(:second)

  defp token_for(identity, iat_ago \\ 0) do
    now = now()
    DeviceAccessToken.encrypt(identity, now - iat_ago, now)
  end

  defp expired_token_for(identity) do
    signed = now() - 3 * @day - 1

    Phoenix.Token.encrypt(
      KaoiroServerWeb.Endpoint,
      "device_access",
      Map.put(identity, :iat, signed),
      signed_at: signed
    )
  end

  defp bearer(conn, token), do: put_req_header(conn, "authorization", "Bearer " <> token)

  defp challenge(conn), do: get_resp_header(conn, "www-authenticate")

  defp set_cookie(conn), do: get_resp_header(conn, "set-cookie")

  # A conn carrying a REAL session cookie for `identity`, so a response
  # that touches the session shows up as a Set-Cookie header.
  # init_test_session alone marks the session written on every request.
  defp cookie_conn(identity) do
    conn =
      build_conn()
      |> init_test_session(%{"oauth_identity" => identity})
      |> get("/session/refresh")

    assert conn.status == 204
    assert set_cookie(conn) != []
    recycle(conn)
  end

  defp subscribe(%{provider: provider, uid: uid}) do
    topic = Auth.oauth_socket_id(provider, uid)
    KaoiroServerWeb.Endpoint.subscribe(topic)
    topic
  end

  defp decrypt_ticket(conn) do
    %{"ticket" => ticket} = json_response(conn, 200)

    {:ok, payload} =
      Phoenix.Token.decrypt(KaoiroServerWeb.Endpoint, "client_ws", ticket, max_age: 30)

    payload
  end

  describe "valid bearer" do
    test "authenticates persona HTTP, ticket and refresh", %{conn: conn} do
      token = token_for(@ao)

      assert conn |> bearer(token) |> get("/api/personas") |> json_response(200)
      assert conn |> bearer(token) |> get("/api/personas/fuji") |> json_response(200)
      assert decrypt_ticket(conn |> bearer(token) |> get("/session/ticket")) == @ao

      assert %{"access_token" => _} =
               conn |> bearer(token) |> get("/session/refresh") |> json_response(200)
    end

    # G36
    test "the scheme matches case-insensitively", %{conn: conn} do
      token = token_for(@ao)

      for scheme <- ["bearer", "BEARER", "BeArEr"] do
        conn =
          conn |> put_req_header("authorization", "#{scheme} #{token}") |> get("/api/personas")

        assert conn.status == 200, scheme
      end
    end
  end

  # G24: a bearer that fails is never rescued by the cookie.
  describe "no fall back to the cookie" do
    test "an invalid bearer with a valid cookie is 401 on every bearer endpoint" do
      for path <- ["/api/personas", "/session/ticket", "/session/refresh"] do
        conn = cookie_conn(@ao) |> bearer("not-a-token") |> get(path)

        assert conn.status == 401, path
        assert challenge(conn) == [~s(Bearer realm="kaoiro", error="invalid_token")], path
      end
    end

    # G38
    test "a non-Bearer scheme with a valid cookie is 401 without an error attribute" do
      conn = cookie_conn(@ao) |> put_req_header("authorization", "Basic YWxhZGRpbjpzZXNhbWU=")

      for path <- ["/api/personas/fuji", "/session/ticket"] do
        conn = get(conn, path)

        assert conn.status == 401, path
        assert challenge(conn) == [~s(Bearer realm="kaoiro")], path
      end
    end
  end

  # G35: RFC 6750 §2.2 / §2.3 are not supported.
  describe "only the header carries a bearer" do
    test "access_token in the query string is ignored", %{conn: conn} do
      token = token_for(@ao)

      for path <- ["/api/personas", "/session/ticket", "/session/refresh"] do
        conn = get(conn, path <> "?access_token=" <> token)

        assert conn.status == 401, path
        assert challenge(conn) == [], path
      end
    end

    test "access_token in a form body is ignored", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/x-www-form-urlencoded")
        |> get("/session/ticket", "access_token=" <> token_for(@ao))

      assert conn.status == 401
      assert challenge(conn) == []
    end
  end

  # G37
  describe "malformed Authorization" do
    for {label, headers} <- [
          {"an empty Bearer", [{"authorization", "Bearer"}]},
          {"a Bearer with only spaces", [{"authorization", "Bearer   "}]},
          {"a token outside b64token", [{"authorization", "Bearer ★"}]},
          {"two Authorization headers",
           [{"authorization", "Bearer a"}, {"authorization", "Bearer b"}]}
        ] do
      test "#{label} is 400 invalid_request on every bearer endpoint", %{conn: conn} do
        conn = %{conn | req_headers: conn.req_headers ++ unquote(Macro.escape(headers))}

        for path <- ["/api/personas", "/api/personas/fuji", "/session/ticket", "/session/refresh"] do
          resp = get(conn, path)

          assert resp.status == 400, path
          assert json_response(resp, 400) == %{"error" => "invalid_request"}, path

          assert challenge(resp) == [~s(Bearer realm="kaoiro", error="invalid_request")],
                 path
        end
      end
    end
  end

  # G39 / G41 over HTTP.
  describe "lifetimes" do
    test "an expired bearer is 401 invalid_token", %{conn: conn} do
      conn = conn |> bearer(expired_token_for(@ao)) |> get("/api/personas")

      assert conn.status == 401
      assert challenge(conn) == [~s(Bearer realm="kaoiro", error="invalid_token")]
    end

    test "iat past thirty days is refused by refresh and persona HTTP", %{conn: conn} do
      token = token_for(@ao, 30 * @day + 1)

      for path <- ["/session/refresh", "/api/personas"] do
        resp = conn |> bearer(token) |> get(path)

        assert resp.status == 401, path
        assert challenge(resp) == [~s(Bearer realm="kaoiro", error="invalid_token")], path
      end
    end

    test "iat exactly thirty days ago gets no new token", %{conn: conn} do
      resp = conn |> bearer(token_for(@ao, 30 * @day)) |> get("/session/refresh")

      assert resp.status == 401
    end

    test "iat beyond the clock skew is refused", %{conn: conn} do
      now = now()
      token = DeviceAccessToken.encrypt(@ao, now + 61, now)

      assert (conn |> bearer(token) |> get("/session/refresh")).status == 401
    end

    test "refresh keeps iat and caps expires_in by the absolute lifetime", %{conn: conn} do
      iat = now() - 29 * @day
      old = DeviceAccessToken.encrypt(@ao, iat, now())

      body = conn |> bearer(old) |> get("/session/refresh") |> json_response(200)

      assert %{"access_token" => new, "token_type" => "Bearer", "expires_in" => left} = body
      assert_in_delta left, @day, 5
      assert {:ok, %{identity: @ao, issued_at: ^iat}} = DeviceAccessToken.decrypt(new, now())
    end

    test "refresh one day after the first issue has the full sliding lifetime", %{conn: conn} do
      body = conn |> bearer(token_for(@ao, @day)) |> get("/session/refresh") |> json_response(200)

      assert_in_delta body["expires_in"], 3 * @day, 5
    end
  end

  # G25
  describe "refresh with a bearer" do
    test "returns a token signed now, writes no cookie", %{conn: conn} do
      signed = now() - 2 * @day
      iat = signed - @day

      old =
        Phoenix.Token.encrypt(
          KaoiroServerWeb.Endpoint,
          "device_access",
          Map.put(@ao, :iat, iat),
          signed_at: signed
        )

      resp = conn |> bearer(old) |> get("/session/refresh")
      %{"access_token" => new} = json_response(resp, 200)

      assert set_cookie(resp) == []

      # Only a token signed within the last ten seconds passes max_age 10,
      # so the new one was re-signed and the old one was not.
      assert {:ok, %{iat: ^iat}} =
               Phoenix.Token.decrypt(KaoiroServerWeb.Endpoint, "device_access", new, max_age: 10)

      assert {:error, :expired} =
               Phoenix.Token.decrypt(KaoiroServerWeb.Endpoint, "device_access", old, max_age: 10)
    end
  end

  # G40
  describe "salts are not shared" do
    test "a WS ticket is not a bearer", %{conn: conn} do
      ticket = Phoenix.Token.encrypt(KaoiroServerWeb.Endpoint, "client_ws", @ao)
      resp = conn |> bearer(ticket) |> get("/api/personas")

      assert resp.status == 401
      assert challenge(resp) == [~s(Bearer realm="kaoiro", error="invalid_token")]
    end

    test "a bearer is not a WS ticket" do
      assert :error =
               ClientSocket.connect(
                 %{"ticket" => token_for(@ao)},
                 %Phoenix.Socket{endpoint: KaoiroServerWeb.Endpoint},
                 %{}
               )
    end
  end

  # G43
  describe "allow-list and role" do
    # Ticket and refresh check no role, so the resolver's allow-list check
    # is what stops them.
    test "an identity dropped from the allow-list is 401 invalid_token", %{conn: conn} do
      token = token_for(@ao)
      put_allowlist("nextcloud:mio:viewer\n")

      for path <- ["/api/personas", "/session/ticket", "/session/refresh"] do
        resp = conn |> bearer(token) |> get(path)

        assert resp.status == 401, path
        assert challenge(resp) == [~s(Bearer realm="kaoiro", error="invalid_token")], path
      end
    end

    test "a viewer is 403 insufficient_scope on an operator endpoint", %{conn: conn} do
      resp = conn |> bearer(token_for(@mio)) |> get("/api/personas/fuji")

      assert json_response(resp, 403) == %{"error" => "forbidden"}
      assert challenge(resp) == [~s(Bearer realm="kaoiro", error="insufficient_scope")]
    end

    test "promotion and demotion apply to the same token at the next request", %{conn: conn} do
      token = token_for(@mio)
      assert (conn |> bearer(token) |> get("/api/personas/fuji")).status == 403

      put_allowlist("nextcloud:mio:operator\n")
      assert (conn |> bearer(token) |> get("/api/personas/fuji")).status == 200

      put_allowlist("nextcloud:mio:viewer\n")
      assert (conn |> bearer(token) |> get("/api/personas/fuji")).status == 403
    end

    test "a cookie failure keeps its old response without a challenge", %{conn: conn} do
      resp = get(conn, "/api/personas/fuji")

      assert json_response(resp, 401) == %{"error" => "unauthorized"}
      assert challenge(resp) == []
    end
  end

  # G44
  describe "a failed bearer leaves the cookie and sockets alone" do
    for {label, token_fun} <- [
          {"invalid", quote(do: fn -> "not-a-token" end)},
          {"expired", quote(do: fn -> expired_token_for(@ao) end)}
        ] do
      test "an #{label} bearer A over a valid cookie B" do
        token = unquote(token_fun).()
        cookie = cookie_conn(@mio)
        b_topic = subscribe(@mio)
        a_topic = subscribe(@ao)

        for path <- ["/session/refresh", "/session/ticket"] do
          resp = cookie |> bearer(token) |> get(path)

          assert resp.status == 401, path
          assert set_cookie(resp) == [], path
        end

        refute_receive %Phoenix.Socket.Broadcast{topic: ^b_topic, event: "disconnect"}, 100
        refute_receive %Phoenix.Socket.Broadcast{topic: ^a_topic, event: "disconnect"}, 10

        after_bearer = get(cookie, "/session/refresh")
        assert after_bearer.status == 204
        assert set_cookie(after_bearer) != []
      end
    end
  end

  # G45
  describe "a valid bearer leaves the cookie alone" do
    test "refresh answers for bearer A, not cookie B" do
      cookie = cookie_conn(@ao)
      b_topic = subscribe(@ao)

      resp = cookie |> bearer(token_for(@mio)) |> get("/session/refresh")
      %{"access_token" => new} = json_response(resp, 200)

      assert set_cookie(resp) == []
      assert {:ok, %{identity: @mio}} = DeviceAccessToken.decrypt(new, now())
      refute_receive %Phoenix.Socket.Broadcast{topic: ^b_topic, event: "disconnect"}, 100
    end

    test "persona HTTP uses bearer A's role over cookie B's" do
      resp = cookie_conn(@ao) |> bearer(token_for(@mio)) |> get("/api/personas/fuji")

      assert resp.status == 403
    end
  end

  # G46
  describe "the bearer's identity is the one used" do
    test "bearer alone, with the same identity's cookie, and with another's" do
      token = token_for(@mio)

      for conn <- [build_conn(), cookie_conn(@mio), cookie_conn(@ao)] do
        assert decrypt_ticket(conn |> bearer(token) |> get("/session/ticket")) == @mio
      end
    end
  end

  # G48
  describe "DELETE /session ignores the bearer" do
    test "a bearer alone is a 204 that disconnects nothing", %{conn: conn} do
      a_topic = subscribe(@ao)

      assert (conn |> bearer(token_for(@ao)) |> delete("/session")).status == 204
      refute_receive %Phoenix.Socket.Broadcast{topic: ^a_topic, event: "disconnect"}, 100
    end

    test "a cookie with a bearer logs the cookie out" do
      a_topic = subscribe(@ao)
      b_topic = subscribe(@mio)

      resp = cookie_conn(@mio) |> bearer(token_for(@ao)) |> delete("/session")

      assert resp.status == 204
      assert_receive %Phoenix.Socket.Broadcast{topic: ^b_topic, event: "disconnect"}
      refute_receive %Phoenix.Socket.Broadcast{topic: ^a_topic, event: "disconnect"}, 100
    end
  end

  # G51
  describe "bearer over plain http" do
    setup do
      Application.put_env(:kaoiro_server, :device_auth_allow_insecure_transport, false)
    end

    test "is 400 invalid_request without the exception", %{conn: conn} do
      resp = conn |> bearer(token_for(@ao)) |> get("/api/personas")

      assert json_response(resp, 400) == %{"error" => "invalid_request"}
      assert challenge(resp) == [~s(Bearer realm="kaoiro", error="invalid_request")]
    end

    test "is accepted over https", %{conn: conn} do
      resp = conn |> bearer(token_for(@ao)) |> get("https://www.example.com/api/personas")

      assert resp.status == 200
    end

    test "leaves the cookie path alone" do
      assert (cookie_conn(@ao) |> get("/api/personas")).status == 200
    end
  end

  # G52: the transport rule relies on prod's Plug.SSL rewriting the scheme
  # from x-forwarded-proto and passing the excluded hosts through. The
  # rewrite itself is measured on the production image (G56).
  test "prod's force_ssl rewrites on x-forwarded-proto and excludes local hosts" do
    config = Config.Reader.read!(@prod_exs, env: :prod)
    force_ssl = config[:kaoiro_server][KaoiroServerWeb.Endpoint][:force_ssl]

    assert force_ssl[:rewrite_on] == [:x_forwarded_proto]
    assert force_ssl[:exclude] == [hosts: ["localhost", "127.0.0.1"]]
  end
end
