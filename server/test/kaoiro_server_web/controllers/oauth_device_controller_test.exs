defmodule KaoiroServerWeb.OAuthDeviceControllerTest do
  # POST /oauth/device and POST /oauth/token through the endpoint (issue
  # 801). async: false — swaps the application's DeviceAuth for one on a
  # test clock and mutates provider, allow-list and transport config.
  use KaoiroServerWeb.ConnCase, async: false

  import KaoiroServer.DeviceAuthFixture
  import KaoiroServer.OAuthAllowlistFixture

  alias KaoiroServer.{DeviceAccessToken, DeviceAuth}
  alias KaoiroServerWeb.OAuthDeviceController

  @form "application/x-www-form-urlencoded"
  @client "kaoiro-client.nvim"
  @grant "urn:ietf:params:oauth:grant-type:device_code"
  @ao %{provider: "nextcloud", uid: "ao"}
  @oauth_env [
    oauth_nextcloud_client_id: "nc-id",
    oauth_nextcloud_client_secret: "nc-secret",
    oauth_nextcloud_base_url: "https://cloud.example"
  ]
  @config_dir Path.expand("../../../config", __DIR__)

  setup do
    Enum.each(@oauth_env, fn {key, value} -> Application.put_env(:kaoiro_server, key, value) end)
    put_allowlist("nextcloud:ao:operator\nnextcloud:mio:viewer\n")

    on_exit(fn ->
      Enum.each(Keyword.keys(@oauth_env), &Application.delete_env(:kaoiro_server, &1))
      Application.delete_env(:kaoiro_server, :oauth_allowlist_path)
      Application.delete_env(:kaoiro_server, :dns_cluster_query)
      Application.put_env(:kaoiro_server, :device_auth_allow_insecure_transport, true)
      Application.put_env(:kaoiro_server, :serve_dashboard, true)
    end)

    :ok
  end

  defp with_clock(_context), do: {:ok, clock: use_test_clock!()}

  defp insecure_only,
    do: Application.put_env(:kaoiro_server, :device_auth_allow_insecure_transport, false)

  defp form(conn, path, body),
    do: conn |> put_req_header("content-type", @form) |> post(path, body)

  defp issue!,
    do: build_conn() |> form("/oauth/device", "client_id=" <> @client) |> json_response(200)

  defp poll(device_code, client_id \\ @client) do
    form(
      build_conn(),
      "/oauth/token",
      URI.encode_query(%{
        "grant_type" => @grant,
        "device_code" => device_code,
        "client_id" => client_id
      })
    )
  end

  defp approve!(user_code, identity \\ @ao),
    do: {:ok, :approved} = DeviceAuth.decide(user_code, identity, :approve, DeviceAuth)

  defp no_store?(conn) do
    get_resp_header(conn, "cache-control") == ["no-store"] and
      get_resp_header(conn, "pragma") == ["no-cache"]
  end

  defp device_field(conn) do
    build_conn() |> get(conn) |> json_response(200) |> Map.fetch!("device")
  end

  describe "the happy path (6.2)" do
    setup :with_clock

    test "POST /oauth/device answers the six RFC 8628 §3.2 fields", %{conn: conn} do
      resp = form(conn, "/oauth/device", "client_id=" <> @client)
      body = json_response(resp, 200)
      uri = KaoiroServerWeb.Endpoint.url() <> "/device"

      assert Map.keys(body) |> Enum.sort() ==
               ~w(device_code expires_in interval user_code verification_uri verification_uri_complete)

      assert %{"expires_in" => 600, "interval" => 5, "verification_uri" => ^uri} = body

      assert body["user_code"] =~
               ~r/\A[BCDFGHJKLMNPQRSTVWXZ]{3}-[BCDFGHJKLMNPQRSTVWXZ]{3}-[BCDFGHJKLMNPQRSTVWXZ]{3}\z/

      assert body["verification_uri_complete"] == uri <> "#code=" <> body["user_code"]
      assert no_store?(resp)
    end

    test "polling: pending, then the token once approved", %{clock: clock} do
      %{"device_code" => code, "user_code" => user_code} = issue!()

      advance(clock, 5_000)
      assert json_response(poll(code), 400) == %{"error" => "authorization_pending"}

      approve!(user_code)
      advance(clock, 5_000)
      resp = poll(code)
      body = json_response(resp, 200)

      assert Map.keys(body) |> Enum.sort() == ~w(access_token expires_in identity role token_type)

      assert %{
               "token_type" => "Bearer",
               "expires_in" => 259_200,
               "role" => "operator",
               "identity" => %{"provider" => "nextcloud", "uid" => "ao"}
             } = body

      assert {:ok, %{identity: @ao}} =
               DeviceAccessToken.decrypt(body["access_token"], System.system_time(:second))

      assert no_store?(resp)
      advance(clock, 5_000)
      assert json_response(poll(code), 400) == %{"error" => "invalid_grant"}
    end

    test "slow_down is answered in the error shape" do
      %{"device_code" => code} = issue!()
      assert json_response(poll(code), 400) == %{"error" => "slow_down"}
    end

    test "a denied code is access_denied", %{clock: clock} do
      %{"device_code" => code, "user_code" => user_code} = issue!()
      {:ok, :denied} = DeviceAuth.decide(user_code, @ao, :deny, DeviceAuth)
      advance(clock, 5_000)

      assert json_response(poll(code), 400) == %{"error" => "access_denied"}
    end

    test "an expired code is expired_token", %{clock: clock} do
      %{"device_code" => code} = issue!()
      advance(clock, 600_000)

      assert json_response(poll(code), 400) == %{"error" => "expired_token"}
    end

    # G8 over HTTP
    test "another client_id is invalid_grant", %{clock: clock} do
      %{"device_code" => code} = issue!()
      advance(clock, 5_000)

      assert json_response(poll(code, "other"), 400) == %{"error" => "invalid_grant"}
    end

    # G7
    test "an identity dropped after approval is access_denied", %{clock: clock} do
      %{"device_code" => code, "user_code" => user_code} = issue!()
      approve!(user_code)
      put_allowlist("nextcloud:mio:viewer\n")
      advance(clock, 5_000)

      assert json_response(poll(code), 400) == %{"error" => "access_denied"}
      advance(clock, 5_000)
      assert json_response(poll(code), 400) == %{"error" => "invalid_grant"}
    end

    test "a viewer's device gets the viewer role", %{clock: clock} do
      %{"device_code" => code, "user_code" => user_code} = issue!()
      approve!(user_code, %{provider: "nextcloud", uid: "mio"})
      advance(clock, 5_000)

      assert %{"role" => "viewer"} = json_response(poll(code), 200)
    end
  end

  describe "parameters" do
    setup :with_clock

    # G9
    test "token request: grant type and required parameters", %{conn: conn} do
      %{"device_code" => code} = issue!()

      for {body, error} <- [
            {%{
               "grant_type" => "authorization_code",
               "device_code" => code,
               "client_id" => @client
             }, "unsupported_grant_type"},
            {%{"device_code" => code, "client_id" => @client}, "invalid_request"},
            {%{"grant_type" => @grant, "client_id" => @client}, "invalid_request"},
            {%{"grant_type" => @grant, "device_code" => "", "client_id" => @client},
             "invalid_request"},
            {%{"grant_type" => @grant, "device_code" => code}, "invalid_request"}
          ] do
        resp = form(conn, "/oauth/token", URI.encode_query(body))
        assert json_response(resp, 400) == %{"error" => error}, inspect(body)
      end
    end

    # G32
    test "client_id must be 1 to 64 visible ASCII characters", %{conn: conn} do
      for client_id <- ["", String.duplicate("a", 65), "a\tb", "a\nb", "café"] do
        resp = form(conn, "/oauth/device", URI.encode_query(%{"client_id" => client_id}))
        assert json_response(resp, 400) == %{"error" => "invalid_request"}, inspect(client_id)
      end

      resp = form(conn, "/oauth/device", "client_id=" <> String.duplicate("a", 64))
      assert json_response(resp, 200)
    end

    test "client_id is required", %{conn: conn} do
      assert json_response(form(conn, "/oauth/device", "scope="), 400) == %{
               "error" => "invalid_request"
             }
    end

    # G33
    test "scope: absent or empty is granted, anything else is invalid_scope", %{conn: conn} do
      for body <- ["client_id=x", "client_id=x&scope="] do
        resp = json_response(form(conn, "/oauth/device", body), 200)
        refute Map.has_key?(resp, "scope")
      end

      assert json_response(form(conn, "/oauth/device", "client_id=x&scope=openid"), 400) ==
               %{"error" => "invalid_scope"}
    end

    # G50
    test "unknown parameters are ignored", %{conn: conn} do
      assert json_response(form(conn, "/oauth/device", "client_id=x&foo=bar"), 200)
    end
  end

  # G10 / G55: every input stage's failure, in the RFC shape, never the
  # Phoenix ErrorJSON shape.
  describe "input failures through the endpoint" do
    setup :with_clock

    test "content types other than the form are 415 with no body", %{conn: conn} do
      for {type, body} <- [
            {"application/json", ~s({"client_id":"x"})},
            {"application/json", "{"},
            {"text/plain", "client_id=x"},
            {nil, "client_id=x"}
          ],
          path <- ["/oauth/device", "/oauth/token"] do
        # ConnTest needs a content type for a binary body, so the case
        # without one sends no body.
        resp =
          if type,
            do: conn |> put_req_header("content-type", type) |> post(path, body),
            else: post(conn, path)

        assert resp.status == 415, "#{path} #{inspect(type)} #{body}"
        assert resp.resp_body == ""
        assert no_store?(resp)
      end
    end

    test "each stage answers its own status and error", %{conn: conn} do
      big = "client_id=" <> String.duplicate("a", 65_536)

      for {path_suffix, body, status} <- [
            {"?client_id=x", "client_id=x", 400},
            {"", big, 413},
            {"", "client_id=%ZZ", 400},
            {"", "client_id=a&client_id=b", 400}
          ],
          path <- ["/oauth/device", "/oauth/token"] do
        resp = form(conn, path <> path_suffix, body)

        assert json_response(resp, status) == %{"error" => "invalid_request"}, "#{path} #{status}"
        assert no_store?(resp)
      end
    end

    test "plain http without the exception is 503 at stage 1", %{conn: conn} do
      insecure_only()

      for path <- ["/oauth/device", "/oauth/token"] do
        resp = form(conn, path, "client_id=x")
        assert json_response(resp, 503) == %{"error" => "temporarily_unavailable"}
        assert no_store?(resp)
      end
    end

    test "an unreadable body is 400 invalid_request" do
      resp =
        build_conn()
        |> put_private(:kaoiro_oauth_input, {:error, :body_unreadable})
        |> OAuthDeviceController.device(%{})

      assert json_response(resp, 400) == %{"error" => "invalid_request"}
    end

    test "a request that skipped the input stage fails closed" do
      assert_raise KeyError, fn -> OAuthDeviceController.device(build_conn(), %{}) end
    end
  end

  # G53: the wrapper's branch and its delegation are pinned separately.
  describe "branch and delegation" do
    setup :with_clock

    test "(a) invalid JSON to /oauth/device is the native 415, not a ParseError", %{conn: conn} do
      resp =
        conn |> put_req_header("content-type", "application/json") |> post("/oauth/device", "{")

      assert resp.status == 415
      assert %Plug.Conn.Unfetched{} = resp.body_params
      assert {:error, :unsupported_media_type} = resp.private[:kaoiro_oauth_input]
    end

    test "(b) invalid JSON to /session/new is still Plug.Parsers' 400", %{conn: conn} do
      assert_error_sent 400, fn ->
        conn |> put_req_header("content-type", "application/json") |> post("/session/new", "{")
      end
    end

    test "(c) JSON to the approval API is parsed as before", %{conn: conn} do
      resp =
        conn
        |> init_test_session(%{"oauth_identity" => @ao})
        |> put_req_header("content-type", "application/json")
        |> post("/session/device/lookup", ~s({"user_code":"BBB-BBB-BBB"}))

      assert resp.status == 404
      assert resp.body_params == %{"user_code" => "BBB-BBB-BBB"}
      refute Map.has_key?(resp.private, :kaoiro_oauth_input)
    end

    test "(d) GET /oauth/device is the router's 404", %{conn: conn} do
      resp = get(conn, "/oauth/device")

      assert resp.status == 404
      refute Map.has_key?(resp.private, :kaoiro_oauth_input)
    end
  end

  # 6.6: 8 inputs x 2 transports, the exception off. The scheme comes from
  # the fixture, so this pins the order of the checks, not Plug.SSL (G56).
  describe "the entry matrix" do
    setup :with_clock

    setup do
      insecure_only()
    end

    @inputs [
      {"form", "/", @form, "client_id=x", {200, 415, 415}},
      {"duplicate", "/", @form, "client_id=a&client_id=b", {400, 415, 415}},
      {"bad escape", "/", @form, "client_id=%ZZ", {400, 415, 415}},
      {"JSON", "/", "application/json", ~s({"client_id":"x"}), {415, 400, 400}},
      {"invalid JSON", "/", "application/json", "{", {415, :parse_error, :parse_error}},
      {"text/plain", "/", "text/plain", "client_id=x", {415, 415, 415}},
      {"empty form", "/", @form, "", {400, 415, 415}},
      {"query", "?client_id=x", @form, "client_id=x", {400, 415, 415}}
    ]

    for {label, query, type, body, {https, session_new, lookup}} <- @inputs do
      test "#{label}" do
        request = fn scheme, path ->
          build_conn()
          |> init_test_session(%{"oauth_identity" => @ao})
          |> put_req_header("content-type", unquote(type))
          |> post("#{scheme}://www.example.com#{path}#{unquote(query)}", unquote(body))
        end

        assert request.("http", "/oauth/device").status == 503
        assert request.("https", "/oauth/device").status == unquote(https)

        for {path, expected} <- [
              {"/session/new", unquote(session_new)},
              {"/session/device/lookup", unquote(lookup)}
            ] do
          if expected == :parse_error do
            assert_error_sent 400, fn -> request.("https", path) end
          else
            assert request.("https", path).status == expected, path
          end
        end
      end
    end
  end

  # G22
  describe "no-store" do
    setup :with_clock

    test "on the native endpoints, the verification URI, ticket and refresh", %{conn: conn} do
      put_allowlist("nextcloud:ao:operator\n")
      session = init_test_session(conn, %{"oauth_identity" => @ao})

      for resp <- [
            form(conn, "/oauth/device", "client_id=x"),
            form(conn, "/oauth/token", "client_id=x"),
            get(conn, "/device"),
            get(session, "/session/ticket"),
            get(session, "/session/refresh"),
            session
            |> put_req_header("content-type", "application/json")
            |> post("/session/device/lookup", "{}"),
            session
            |> put_req_header("content-type", "application/json")
            |> post("/session/device/decision", "{}")
          ] do
        assert no_store?(resp), resp.request_path
      end
    end

    test "GET /device redirects to the dashboard's device view", %{conn: conn} do
      resp = get(conn, "/device")
      assert redirected_to(resp, 302) == "/index.html?device=1"
    end
  end

  # G29
  test "CORS preflights are not answered", %{conn: conn} do
    for path <- ["/oauth/token", "/session/device/decision"] do
      resp =
        conn
        |> put_req_header("origin", "https://evil.example")
        |> put_req_header("access-control-request-method", "POST")
        |> options(path)

      assert resp.status == 404, path
      assert get_resp_header(resp, "access-control-allow-origin") == [], path
    end
  end

  describe "availability" do
    # G30
    test "transport: http is unavailable without the exception, https is not" do
      _clock = use_test_clock!()
      insecure_only()

      assert json_response(form(build_conn(), "/oauth/device", "client_id=x"), 503)
      refute device_field("/session/auth-methods")

      assert json_response(
               form(build_conn(), "https://www.example.com/oauth/device", "client_id=x"),
               200
             )

      assert device_field("https://www.example.com/session/auth-methods")
    end

    test "transport: stage 1 comes before the content type" do
      _clock = use_test_clock!()
      insecure_only()

      resp =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/oauth/device", "{")

      assert json_response(resp, 503) == %{"error" => "temporarily_unavailable"}
    end

    test "the exception is set by dev.exs and test.exs only, and runtime.exs never reads it" do
      for file <- ~w(config.exs prod.exs runtime.exs) do
        text = File.read!(Path.join(@config_dir, file))
        refute text =~ "device_auth_allow_insecure_transport", file
        refute text =~ ~r/INSECURE/i, file
      end

      for file <- ~w(dev.exs test.exs) do
        assert File.read!(Path.join(@config_dir, file)) =~
                 "config :kaoiro_server, :device_auth_allow_insecure_transport, true"
      end
    end

    # G26
    test "a cluster query disables the flow, with the reason" do
      Application.put_env(:kaoiro_server, :dns_cluster_query, "kaoiro.internal")
      _clock = ExUnit.CaptureLog.with_log(fn -> use_test_clock!() end)

      for path <- ["/oauth/device", "/oauth/token"] do
        assert json_response(form(build_conn(), path, ""), 503) == %{
                 "error" => "temporarily_unavailable",
                 "reason" => "device flow requires a single backend"
               }
      end

      refute device_field("/session/auth-methods")
    end

    test "no cluster query: the positive control" do
      _clock = use_test_clock!()
      assert device_field("/session/auth-methods")
      assert json_response(form(build_conn(), "/oauth/device", "client_id=x"), 200)
    end

    # G27
    test "a connected node makes the flow unavailable" do
      _clock = use_test_clock!(node_list: fn -> [:other@host] end)

      assert json_response(form(build_conn(), "/oauth/device", "client_id=x"), 503)["reason"] ==
               "device flow requires a single backend"

      refute device_field("/session/auth-methods")
    end

    # G28
    test "no OAuth provider, or no dashboard, makes the flow unavailable" do
      _clock = use_test_clock!()

      Enum.each(Keyword.keys(@oauth_env), &Application.delete_env(:kaoiro_server, &1))
      assert json_response(form(build_conn(), "/oauth/device", "client_id=x"), 503)
      refute device_field("/session/auth-methods")

      Enum.each(@oauth_env, fn {key, value} -> Application.put_env(:kaoiro_server, key, value) end)

      Application.put_env(:kaoiro_server, :serve_dashboard, false)
      assert json_response(form(build_conn(), "/oauth/device", "client_id=x"), 503)
      assert json_response(form(build_conn(), "/oauth/token", "client_id=x"), 503)
      refute device_field("/session/auth-methods")
    end

    # D13
    test "unavailability comes before parameter checks" do
      _clock = use_test_clock!(node_list: fn -> [:other@host] end)
      assert json_response(form(build_conn(), "/oauth/device", "scope=openid"), 503)
    end

    # G20 over HTTP
    test "the issue rate limit is 503 with Retry-After" do
      _clock = use_test_clock!()
      for _ <- 1..10, do: json_response(form(build_conn(), "/oauth/device", "client_id=x"), 200)

      resp = form(build_conn(), "/oauth/device", "client_id=x")
      assert json_response(resp, 503) == %{"error" => "temporarily_unavailable"}
      assert get_resp_header(resp, "retry-after") == ["60"]
    end
  end
end
