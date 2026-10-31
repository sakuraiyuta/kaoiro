defmodule KaoiroServerWeb.ParsersTest do
  # G49: outside the two native POSTs, the wrapper is Plug.Parsers. For
  # every request below, the wrapper and a direct Plug.Parsers.call/2 with
  # the endpoint's options return an equal conn, or raise the same
  # exception module.
  use ExUnit.Case, async: true

  import Plug.Conn
  import Plug.Test

  alias KaoiroServerWeb.Parsers

  @opts [
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()
  ]

  @multipart_body Enum.join(
                    [
                      "--x",
                      ~s(content-disposition: form-data; name="a"),
                      "",
                      "1",
                      "--x--",
                      ""
                    ],
                    "\r\n"
                  )

  @labels [
    "JSON",
    "invalid JSON",
    "form",
    "multipart",
    "no content type",
    "text/plain",
    "a body over 8 MB",
    "GET /oauth/device",
    "HEAD /oauth/token",
    "PUT /oauth/device",
    "POST to a neighbouring path",
    "POST below the path",
    "POST to another prefix"
  ]

  defp delegated_requests do
    [
      {"JSON", fn -> json_conn(:post, "/session/new", ~s({"token":"t"})) end},
      {"invalid JSON", fn -> json_conn(:post, "/session/new", "{") end},
      {"form",
       fn ->
         typed(:post, "/session/device/lookup", "a=1", "application/x-www-form-urlencoded")
       end},
      {"multipart",
       fn -> typed(:post, "/session/new", @multipart_body, "multipart/form-data; boundary=x") end},
      {"no content type", fn -> conn(:post, "/session/new", "a=1") end},
      {"text/plain", fn -> typed(:post, "/session/new", "hello", "text/plain") end},
      {"a body over 8 MB",
       fn ->
         typed(
           :post,
           "/session/new",
           String.duplicate("a", 8_000_001),
           "application/x-www-form-urlencoded"
         )
       end},
      {"GET /oauth/device", fn -> conn(:get, "/oauth/device") end},
      {"HEAD /oauth/token", fn -> conn(:head, "/oauth/token") end},
      {"PUT /oauth/device",
       fn -> typed(:put, "/oauth/device", "client_id=x", "application/x-www-form-urlencoded") end},
      {"POST to a neighbouring path",
       fn ->
         typed(:post, "/oauth/devices", "client_id=x", "application/x-www-form-urlencoded")
       end},
      {"POST below the path",
       fn ->
         typed(:post, "/oauth/device/x", "client_id=x", "application/x-www-form-urlencoded")
       end},
      {"POST to another prefix",
       fn -> typed(:post, "/auth/device", "client_id=x", "application/x-www-form-urlencoded") end}
    ]
  end

  defp typed(method, path, body, type),
    do: method |> conn(path, body) |> put_req_header("content-type", type)

  defp json_conn(method, path, body), do: typed(method, path, body, "application/json")

  # Two conns built from the same request differ only in the test
  # adapter's per-conn ref, which is dropped before comparing.
  defp outcome(fun) do
    %Plug.Conn{adapter: {mod, state}} = conn = fun.()
    %{conn | adapter: {mod, Map.delete(state, :ref)}}
  rescue
    e -> {:raised, e.__struct__}
  end

  for label <- @labels do
    test "#{label} is delegated unchanged" do
      {_label, build} = List.keyfind(delegated_requests(), unquote(label), 0)

      wrapped = outcome(fn -> Parsers.call(build.(), Parsers.init(@opts)) end)
      direct = outcome(fn -> Plug.Parsers.call(build.(), Plug.Parsers.init(@opts)) end)

      assert wrapped == direct
    end
  end

  test "every request in the set has a test" do
    assert Enum.map(delegated_requests(), &elem(&1, 0)) == @labels
  end

  test "the delegated set raises where Plug.Parsers raises, so the comparison is not vacuous" do
    {_label, build} = List.keyfind(delegated_requests(), "invalid JSON", 0)

    assert {:raised, Plug.Parsers.ParseError} =
             outcome(fn -> Parsers.call(build.(), Parsers.init(@opts)) end)
  end

  describe "the native POSTs are not delegated" do
    for path <- ["/oauth/device", "/oauth/token", "/oauth/device/"] do
      test "POST #{path} with invalid JSON is read by NativeOAuthInput" do
        conn = Parsers.call(json_conn(:post, unquote(path), "{"), Parsers.init(@opts))

        assert {:error, :unsupported_media_type} = conn.private[:kaoiro_oauth_input]
        assert %Plug.Conn.Unfetched{} = conn.body_params
      end
    end
  end
end
