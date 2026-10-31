defmodule KaoiroServerWeb.Parsers do
  @moduledoc """
  Stands in for `plug Plug.Parsers` in the endpoint (issue 801). A POST
  to the native device authorization endpoints goes to
  `KaoiroServerWeb.NativeOAuthInput`, which owns their input; every other
  request is handed to `Plug.Parsers.call/2` unchanged, so it returns the
  same conn, or raises the same exception, as the stock plug would.

  The two paths are matched on `path_info`, the segments the router
  matches on, so a spelling the router routes to the device controller
  (a trailing slash) cannot reach it through `Plug.Parsers` instead.
  """

  @behaviour Plug

  alias KaoiroServerWeb.NativeOAuthInput

  @impl true
  def init(opts), do: Plug.Parsers.init(opts)

  @impl true
  def call(%Plug.Conn{method: "POST", path_info: ["oauth", endpoint]} = conn, _opts)
      when endpoint in ["device", "token"],
      do: NativeOAuthInput.call(conn)

  def call(conn, opts), do: Plug.Parsers.call(conn, opts)
end
