defmodule KaoiroServerWeb.RootRedirect do
  @moduledoc """
  Redirects `/` to the dashboard entry, or 404s when the dashboard's
  static serving is turned off (`:serve_dashboard`, ADR-0007).
  """

  @behaviour Plug

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    if Application.get_env(:kaoiro_server, :serve_dashboard, true) do
      conn
      |> Phoenix.Controller.redirect(to: "/index.html")
      |> Plug.Conn.halt()
    else
      conn
      |> Plug.Conn.send_resp(404, "dashboard disabled")
      |> Plug.Conn.halt()
    end
  end
end
