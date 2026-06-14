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
      |> Phoenix.Controller.redirect(to: index_path(conn))
      |> Plug.Conn.halt()
    else
      conn
      |> Plug.Conn.send_resp(404, "dashboard disabled")
      |> Plug.Conn.halt()
    end
  end

  # Preserve the query string across the redirect so `/?token=...` reaches
  # the SPA entry — the dashboard reads `?token` from the URL on load, and
  # dropping it here left every tokened client connection unauthenticated.
  defp index_path(%{query_string: ""}), do: "/index.html"
  defp index_path(%{query_string: qs}), do: "/index.html?" <> qs
end
