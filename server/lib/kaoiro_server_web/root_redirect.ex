defmodule KaoiroServerWeb.RootRedirect do
  @moduledoc """
  Handles `/`: exchanges a `?token=…` for the httpOnly session cookie
  (ADR-0013) and redirects to the dashboard entry, or 404s when the
  dashboard's static serving is turned off (`:serve_dashboard`, ADR-0007).
  """

  @behaviour Plug

  alias KaoiroServer.Auth

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    if Application.get_env(:kaoiro_server, :serve_dashboard, true) do
      conn
      |> maybe_store_token()
      |> Phoenix.Controller.redirect(to: "/index.html")
      |> Plug.Conn.halt()
    else
      conn
      |> Plug.Conn.send_resp(404, "dashboard disabled")
      |> Plug.Conn.halt()
    end
  end

  # Exchange `?token=…` for the encrypted session cookie (ADR-0013):
  # validate the token, stash it in the session, and redirect to a clean
  # `/index.html` so the token never reaches the SPA or the address bar.
  # An invalid token is ignored — the SPA then connects unauthenticated
  # and is rejected fail-closed (issue #28). Dev serves the SPA off the
  # Vite dev server, which never hits this plug, so the legacy `?token=`
  # query path stays available there (D5).
  defp maybe_store_token(conn) do
    conn = Plug.Conn.fetch_query_params(conn)

    # An established OAuth identity is never displaced here (ADR-0042).
    # This is a plain top-level navigation, so any site can trigger it and
    # SameSite=Lax still sends the victim's cookie — honouring the token
    # would let anyone holding a shared token swap an authenticated
    # operator's session out from under them. Switching credentials goes
    # through an explicit logout instead. The sibling POST /session/new
    # path is closed differently, by requiring a JSON content-type: there
    # Lax withholds the victim's cookie, so this session-shaped guard
    # would see an empty session and could not fire at all.
    if Plug.Conn.get_session(conn, "oauth_identity") do
      conn
    else
      store_token(conn, conn.query_params["token"])
    end
  end

  defp store_token(conn, token) when is_binary(token) and token != "" do
    case Auth.client_role(token) do
      {:ok, _role} -> Plug.Conn.put_session(conn, "client_token", token)
      {:error, _reason} -> conn
    end
  end

  defp store_token(conn, _token), do: conn
end
