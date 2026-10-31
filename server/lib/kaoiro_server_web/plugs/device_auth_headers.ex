defmodule KaoiroServerWeb.DeviceAuthHeaders do
  @moduledoc """
  Marks a response as not to be stored (RFC 6749 §5.1): the device
  authorization endpoints, the approval API and the ticket / refresh
  endpoints all answer with codes or tokens (issue 801).
  """

  @behaviour Plug

  import Plug.Conn

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    conn
    |> put_resp_header("cache-control", "no-store")
    |> put_resp_header("pragma", "no-cache")
  end
end
