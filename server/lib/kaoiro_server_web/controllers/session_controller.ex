defmodule KaoiroServerWeb.SessionController do
  @moduledoc """
  Slides the dashboard's auth cookie (ADR-0013). The open SPA calls
  `GET /session/refresh` periodically; each call re-emits the session
  cookie with a fresh max_age, so a tab that stays open never lapses
  while a closed tab expires max_age after its last refresh. The session
  token is re-validated each time, so a revoked token stops sliding (and
  the stale session is dropped) immediately.
  """

  use KaoiroServerWeb, :controller

  alias KaoiroServer.Auth

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
        # authenticating (the cookie is re-emitted empty).
        conn
        |> clear_session()
        |> send_resp(:unauthorized, "")
    end
  end
end
