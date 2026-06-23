defmodule KaoiroServerWeb.SessionController do
  @moduledoc """
  The dashboard's auth cookie endpoints (ADR-0013).

  - `create` (`POST /session/new?token=…`): exchanges a token for the
    httpOnly session cookie. This is the client-driven path used by the
    dev Vite server (which serves the SPA itself and so never hits the
    prod `RootRedirect` exchange); the SPA calls it via the Vite proxy so
    a reload re-authenticates from the cookie.
  - `refresh` (`GET /session/refresh`): the open SPA calls it periodically
    to re-emit the cookie with a fresh max_age, so a tab that stays open
    never lapses while a closed tab expires max_age after its last
    refresh. Both re-validate the token, so a revoked token stops
    authenticating (and the stale session is dropped) immediately; on a
    revoked token it also force-disconnects the live socket (issue #47).
  - `delete` (`DELETE /session`): explicit logout — empties the cookie and
    force-disconnects the user's live socket(s) (issue #47).
  """

  use KaoiroServerWeb, :controller

  alias KaoiroServer.Auth

  # Matches ClientSocket's ticket salt.
  @ws_ticket_salt "client_ws"

  # GET /session/ticket: mints a short-lived signed WS ticket from a valid
  # cookie session (ADR-0013). The SPA fetches it on a reload — Vite cannot
  # carry the cookie on a WS upgrade, so the ticket (not the token) rides
  # the connect params. The token itself never reaches JS.
  def ticket(conn, _params) do
    token = get_session(conn, "client_token")

    case token && Auth.client_role(token) do
      {:ok, _role} ->
        json(conn, %{ticket: Phoenix.Token.sign(conn, @ws_ticket_salt, token)})

      _ ->
        conn
        |> clear_session()
        |> put_status(:unauthorized)
        |> json(%{error: "unauthorized"})
    end
  end

  # Token read from the request body (not the query string) so it stays out
  # of access logs.
  def create(conn, %{"token" => token}) when is_binary(token) and token != "" do
    case Auth.client_role(token) do
      {:ok, _role} ->
        conn
        |> put_session("client_token", token)
        |> send_resp(:no_content, "")

      {:error, _reason} ->
        send_resp(conn, :unauthorized, "")
    end
  end

  def create(conn, _params), do: send_resp(conn, :bad_request, "")

  def refresh(conn, _params) do
    token = get_session(conn, "client_token")

    case token && Auth.client_role(token) do
      {:ok, _role} ->
        # Re-put the same token to mark the session written, so Plug.Session
        # re-emits the cookie with a fresh max_age (slides the window).
        conn
        |> put_session("client_token", token)
        |> send_resp(:no_content, "")

      _ ->
        # Invalid/revoked: empty the session so the stale token stops
        # authenticating (the cookie is re-emitted empty), and force-drop
        # any live socket still bound to the revoked token so revocation
        # takes effect immediately, not at the next reconnect (issue #47).
        disconnect_socket(token)

        conn
        |> clear_session()
        |> send_resp(:unauthorized, "")
    end
  end

  # DELETE /session: explicit logout. Empties the cookie and force-drops
  # the user's live socket(s) so an operator session ends at once rather
  # than lingering until the token expires or the tab reconnects (#47).
  def delete(conn, _params) do
    disconnect_socket(get_session(conn, "client_token"))

    conn
    |> clear_session()
    |> send_resp(:no_content, "")
  end

  # Broadcasts the Phoenix "disconnect" control event to the token's socket
  # id so ClientSocket drops every connection bound to it (issue #47). A
  # nil token (no session) addresses nothing.
  defp disconnect_socket(token) do
    case Auth.socket_id(token) do
      nil -> :ok
      socket_id -> KaoiroServerWeb.Endpoint.broadcast(socket_id, "disconnect", %{})
    end
  end
end
