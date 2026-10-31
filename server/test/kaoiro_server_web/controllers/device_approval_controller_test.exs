defmodule KaoiroServerWeb.DeviceApprovalControllerTest do
  # POST /session/device/lookup and /session/device/decision (issue 801).
  # async: false — swaps the application's DeviceAuth for one on a test
  # clock and mutates the allow-list and :client_tokens.
  use KaoiroServerWeb.ConnCase, async: false

  import KaoiroServer.DeviceAuthFixture
  import KaoiroServer.OAuthAllowlistFixture

  alias KaoiroServer.{DeviceAccessToken, DeviceAuth}

  @ao %{provider: "nextcloud", uid: "ao"}

  setup do
    put_allowlist("nextcloud:ao:operator\nnextcloud:mio:viewer\n")

    on_exit(fn ->
      Application.delete_env(:kaoiro_server, :oauth_allowlist_path)
      Application.delete_env(:kaoiro_server, :client_tokens)
    end)

    {:ok, clock: use_test_clock!()}
  end

  defp issue! do
    {:ok, issued} = DeviceAuth.issue("kaoiro-client.nvim", DeviceAuth)
    issued
  end

  defp oauth(identity \\ @ao),
    do: init_test_session(build_conn(), %{"oauth_identity" => identity})

  defp call(conn, action, body, type \\ "application/json") do
    conn
    |> put_req_header("content-type", type)
    |> post("/session/device/" <> action, body)
  end

  defp lookup_body(user_code), do: Jason.encode!(%{user_code: user_code})

  defp decision_body(user_code, decision),
    do: Jason.encode!(%{user_code: user_code, decision: decision})

  describe "lookup" do
    test "answers the pending device for the approver (the §4.2 JSON)", %{clock: clock} do
      %{user_code: user_code} = issue!()
      {:ok, %{issued_at: issued_at}} = DeviceAuth.lookup(user_code, @ao, DeviceAuth)
      advance(clock, 100_400)

      body = oauth() |> call("lookup", lookup_body(user_code)) |> json_response(200)

      assert body == %{
               "user_code" => user_code,
               "client_id" => "kaoiro-client.nvim",
               "issued_at" => issued_at |> DateTime.from_unix!() |> DateTime.to_iso8601(),
               "expires_in" => 499,
               "identity" => %{"provider" => "nextcloud", "uid" => "ao"},
               "role" => "operator"
             }

      assert body["issued_at"] =~ ~r/\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\z/
    end

    test "matches a typed code after normalization" do
      %{user_code: user_code} = issue!()
      typed = user_code |> String.downcase() |> String.replace("-", " ")

      assert %{"user_code" => ^user_code} =
               oauth() |> call("lookup", lookup_body(typed)) |> json_response(200)
    end

    test "an unknown code is 404, an expired one 410", %{clock: clock} do
      %{user_code: user_code} = issue!()

      assert oauth() |> call("lookup", lookup_body("BBB-BBB-BBB")) |> json_response(404) == %{
               "error" => "unknown_code"
             }

      advance(clock, 600_000)

      assert oauth() |> call("lookup", lookup_body(user_code)) |> json_response(410) == %{
               "error" => "expired"
             }
    end

    test "the failure limit is 429 with retry_after" do
      for _ <- 1..5,
          do: oauth() |> call("lookup", lookup_body("BBB-BBB-BBB")) |> json_response(404)

      assert oauth() |> call("lookup", lookup_body("BBB-BBB-BBB")) |> json_response(429) ==
               %{"error" => "rate_limited", "retry_after" => 900}
    end

    test "a missing user_code is 400 invalid_request" do
      assert oauth() |> call("lookup", "{}") |> json_response(400) == %{
               "error" => "invalid_request"
             }

      assert oauth() |> call("lookup", ~s({"user_code":1})) |> json_response(400) == %{
               "error" => "invalid_request"
             }
    end
  end

  describe "decision" do
    test "approve and deny" do
      %{user_code: approve} = issue!()
      %{user_code: deny} = issue!()

      assert oauth() |> call("decision", decision_body(approve, "approve")) |> json_response(200) ==
               %{"state" => "approved"}

      assert oauth() |> call("decision", decision_body(deny, "deny")) |> json_response(200) == %{
               "state" => "denied"
             }
    end

    # G17
    test "a decided code is 409 and keeps its state", %{clock: clock} do
      %{user_code: user_code, device_code: device_code} = issue!()
      oauth() |> call("decision", decision_body(user_code, "approve")) |> json_response(200)

      assert oauth() |> call("decision", decision_body(user_code, "deny")) |> json_response(409) ==
               %{"error" => "already_decided"}

      advance(clock, 5_000)
      assert {:ok, @ao} = DeviceAuth.consume(device_code, "kaoiro-client.nvim", DeviceAuth)
    end

    test "an expired code is 410", %{clock: clock} do
      %{user_code: user_code} = issue!()
      advance(clock, 600_000)

      assert oauth()
             |> call("decision", decision_body(user_code, "approve"))
             |> json_response(410) ==
               %{"error" => "expired"}
    end

    test "an unknown decision is 400 invalid_request" do
      %{user_code: user_code} = issue!()

      for body <- [decision_body(user_code, "maybe"), lookup_body(user_code)] do
        assert oauth() |> call("decision", body) |> json_response(400) == %{
                 "error" => "invalid_request"
               }
      end
    end
  end

  for action <- ["lookup", "decision"] do
    describe "#{action} authorization" do
      @action action

      # G11 / G12
      test "requires a JSON body" do
        %{user_code: user_code} = issue!()

        for {type, body} <- [
              {"application/x-www-form-urlencoded", "user_code=#{user_code}&decision=approve"},
              {"text/plain", "x"}
            ] do
          resp = oauth() |> call(@action, body, type)
          assert resp.status == 415, type
          assert resp.resp_body == ""
        end
      end

      # G13 / G14
      test "requires an OAuth session on the allow-list" do
        Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
        body = decision_body("BBB-BBB-BBB", "approve")

        assert build_conn() |> call(@action, body) |> json_response(401) == %{
                 "error" => "unauthorized"
               }

        assert build_conn()
               |> init_test_session(%{"client_token" => "tok-op"})
               |> call(@action, body)
               |> json_response(403) == %{"error" => "oauth_session_required"}

        assert oauth(%{provider: "nextcloud", uid: "nobody"})
               |> call(@action, body)
               |> json_response(401) ==
                 %{"error" => "unauthorized"}
      end

      test "authentication comes before the content type" do
        resp = build_conn() |> call(@action, "x", "text/plain")
        assert json_response(resp, 401) == %{"error" => "unauthorized"}
      end

      # G47
      test "refuses a bearer, with or without the cookie" do
        now = System.system_time(:second)
        bearer = "Bearer " <> DeviceAccessToken.encrypt(@ao, now, now)
        body = decision_body("BBB-BBB-BBB", "approve")

        for conn <- [build_conn(), oauth()] do
          resp = conn |> put_req_header("authorization", bearer) |> call(@action, body)
          assert json_response(resp, 400) == %{"error" => "cookie_session_required"}
        end
      end
    end
  end
end
