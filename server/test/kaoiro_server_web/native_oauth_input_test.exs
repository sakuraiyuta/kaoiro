defmodule KaoiroServerWeb.NativeOAuthInputTest do
  # async: false — toggles the insecure-transport exception.
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test

  alias KaoiroServerWeb.NativeOAuthInput

  @form "application/x-www-form-urlencoded"

  defmodule UnreadableBody do
    @moduledoc false
    def read_req_body(_state, _opts), do: {:error, :timeout}
  end

  setup do
    on_exit(fn ->
      Application.put_env(:kaoiro_server, :device_auth_allow_insecure_transport, true)
    end)
  end

  defp request(body, opts \\ []) do
    url = Keyword.get(opts, :url, "/oauth/device")

    conn(:post, url, body)
    |> then(fn conn ->
      case Keyword.get(opts, :content_type, @form) do
        nil -> conn
        types when is_list(types) -> %{conn | req_headers: Enum.map(types, &{"content-type", &1})}
        type -> put_req_header(conn, "content-type", type)
      end
    end)
  end

  defp result(conn), do: NativeOAuthInput.call(conn).private[:kaoiro_oauth_input]

  defp insecure_only,
    do: Application.put_env(:kaoiro_server, :device_auth_allow_insecure_transport, false)

  describe "stage 1: transport" do
    test "plain http without the exception is refused" do
      insecure_only()
      assert {:error, :insecure_transport} = result(request("client_id=x"))
    end

    test "https passes without the exception" do
      insecure_only()

      assert {:ok, %{pairs: [{"client_id", "x"}]}} =
               result(request("client_id=x", url: "https://kaoiro.example/oauth/device"))
    end

    test "comes before the content type" do
      insecure_only()

      assert {:error, :insecure_transport} =
               result(request("{", content_type: "application/json"))
    end
  end

  describe "stage 2: content type" do
    for type <- [
          nil,
          "application/json",
          "text/plain",
          "multipart/form-data; boundary=x",
          "application/x-www-form-urlencodedx"
        ] do
      test "#{inspect(type)} is unsupported" do
        assert {:error, :unsupported_media_type} =
                 result(request("client_id=x", content_type: unquote(type)))
      end
    end

    test "two content-type headers are unsupported" do
      assert {:error, :unsupported_media_type} =
               result(request("client_id=x", content_type: [@form, @form]))
    end

    test "parameters and letter case are accepted" do
      for type <- [@form <> "; charset=utf-8", "Application/X-WWW-Form-URLEncoded"] do
        assert {:ok, _} = result(request("client_id=x", content_type: type)), type
      end
    end

    test "comes before the query string" do
      assert {:error, :unsupported_media_type} =
               result(
                 request("{", url: "/oauth/device?client_id=x", content_type: "application/json")
               )
    end
  end

  describe "stage 3: query string" do
    test "a non-empty query string is refused" do
      assert {:error, :query_not_empty} =
               result(request("client_id=x", url: "/oauth/device?client_id=x"))
    end

    test "comes before the body is read" do
      big = "client_id=" <> String.duplicate("a", 65_536)
      assert {:error, :query_not_empty} = result(request(big, url: "/oauth/device?a=b"))
    end
  end

  describe "stage 4: body" do
    test "a typical form is read" do
      body =
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=abc&client_id=kaoiro-client.nvim"

      assert {:ok, %{pairs: pairs}} = result(request(body))
      assert {"grant_type", "urn:ietf:params:oauth:grant-type:device_code"} in pairs
    end

    test "a 64 KiB body is too large" do
      assert {:error, :body_too_large} =
               result(request("client_id=" <> String.duplicate("a", 65_536)))
    end

    test "an unreadable body is reported, not raised" do
      conn = %{request("client_id=x") | adapter: {UnreadableBody, nil}}
      assert {:error, :body_unreadable} = result(conn)
    end
  end

  describe "stage 5: form decoding" do
    for body <- [
          "client_id=%ZZ",
          "client_id=abc%",
          "client_id=%4",
          "%ZZ=x",
          "client_id=%FF",
          "client_id=%C3%28"
        ] do
      test "#{body} is malformed" do
        assert {:error, :malformed_form} = result(request(unquote(body)))
      end
    end

    test "escapes and plus signs decode" do
      assert {:ok, %{pairs: [{"client_id", "A b"}]}} = result(request("client_id=%41+b"))
    end

    test "comes before the duplicate check" do
      assert {:error, :malformed_form} = result(request("client_id=%ZZ&client_id=b"))
    end
  end

  describe "stage 6: duplicate keys" do
    for body <- ["client_id=a&client_id=b", "grant_type=a&client_id=x&grant_type=a"] do
      test "#{body} is refused" do
        assert {:error, :duplicate_parameter} = result(request(unquote(body)))
      end
    end
  end

  describe "success" do
    test "an empty body is an empty list" do
      assert {:ok, %{pairs: []}} = result(request(""))
    end

    test "body_params stays unfetched" do
      conn = NativeOAuthInput.call(request("client_id=x"))
      assert %Plug.Conn.Unfetched{} = conn.body_params
      assert %Plug.Conn.Unfetched{} = conn.params
    end
  end
end
