defmodule KaoiroServerWeb.SessionController do
  @moduledoc """
  The dashboard's auth cookie endpoints (ADR-0013, extended by ADR-0042).

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
  - `auth_methods` (`GET /session/auth-methods`): tells the login screen
    which methods are actually usable, so it never offers a form that
    cannot authenticate. Unauthenticated on purpose — it exposes no more
    than which buttons to draw.

  A session carries exactly one credential: either a shared token
  (`client_token`) or an OAuth identity (`oauth_identity`, written by
  `KaoiroServerWeb.AuthController`). Both are re-validated on every
  request here — the token against `:client_tokens`, the identity against
  the allow-list — so revoking either takes effect at the next refresh
  rather than at cookie expiry.
  """

  use KaoiroServerWeb, :controller

  alias KaoiroServer.Auth
  alias KaoiroServer.OAuth
  alias KaoiroServer.OAuthAllowlist

  # Matches ClientSocket's ticket salt.
  @ws_ticket_salt "client_ws"

  # GET /session/ticket: mints a short-lived ENCRYPTED WS ticket from a
  # valid cookie session (ADR-0013). The SPA fetches it on a reload — Vite
  # cannot carry the cookie on a WS upgrade, so the ticket (not the token)
  # rides the connect params. Encrypt (not sign): the embedded reusable
  # token must stay confidential so an XSS that reads the JS-held ticket
  # cannot Base64-decode the long-lived token out of it (ADR-0013 rejects
  # sign-only storage). The token itself never reaches JS. An OAuth
  # session carries its identity instead, which is not a secret but rides
  # the same encrypted envelope so ClientSocket has one thing to decrypt.
  def ticket(conn, _params) do
    case credential(conn) do
      {:ok, payload} ->
        json(conn, %{ticket: Phoenix.Token.encrypt(conn, @ws_ticket_salt, payload)})

      :error ->
        conn
        |> clear_session()
        |> put_status(:unauthorized)
        |> json(%{error: "unauthorized"})
    end
  end

  # Token read from the request body (not the query string) so it stays out
  # of access logs.
  #
  # A JSON content-type is REQUIRED, which is what keeps this endpoint
  # same-origin-only. SameSite=Lax alone does not: it withholds the
  # victim's cookie from a cross-site POST, but the response's
  # first-party Set-Cookie still lands, so a cross-site auto-submitting
  # form could swap an authenticated operator's session for one carrying
  # an attacker-chosen shared token. An HTML form can only send
  # urlencoded / multipart / text-plain, and a cross-origin `fetch` with
  # a JSON content-type is stopped by a CORS preflight this server never
  # answers — so requiring JSON closes that displacement path without a
  # CSRF token round-trip.
  def create(conn, params) do
    if json_request?(conn) do
      exchange_token(conn, params)
    else
      send_resp(conn, :unsupported_media_type, "")
    end
  end

  defp exchange_token(conn, %{"token" => token}) when is_binary(token) and token != "" do
    case Auth.client_role(token) do
      {:ok, _role} ->
        conn
        # One credential per session, mirroring AuthController: a token
        # login supersedes any OAuth identity the same browser held.
        |> delete_session("oauth_identity")
        |> put_session("client_token", token)
        |> send_resp(:no_content, "")

      {:error, _reason} ->
        send_resp(conn, :unauthorized, "")
    end
  end

  defp exchange_token(conn, _params), do: send_resp(conn, :bad_request, "")

  defp json_request?(conn) do
    case get_req_header(conn, "content-type") do
      [value | _rest] -> String.starts_with?(value, "application/json")
      [] -> false
    end
  end

  def refresh(conn, _params) do
    case credential(conn) do
      {:ok, payload} ->
        # Re-put the same credential to mark the session written, so
        # Plug.Session re-emits the cookie with a fresh max_age (slides
        # the window).
        conn
        |> put_credential(payload)
        |> send_resp(:no_content, "")

      :error ->
        # Invalid/revoked: empty the session so the stale credential stops
        # authenticating (the cookie is re-emitted empty), and force-drop
        # any live socket still bound to it so revocation takes effect
        # immediately, not at the next reconnect (issue #47). For an OAuth
        # session that is what makes an allow-list line removal land on a
        # connected operator.
        disconnect_sockets(conn)

        conn
        |> clear_session()
        |> send_resp(:unauthorized, "")
    end
  end

  # DELETE /session: explicit logout. Empties the cookie and force-drops
  # the user's live socket(s) so an operator session ends at once rather
  # than lingering until the token expires or the tab reconnects (#47).
  def delete(conn, _params) do
    disconnect_sockets(conn)

    conn
    |> clear_session()
    |> send_resp(:no_content, "")
  end

  # GET /session/auth-methods: which login methods this deployment can
  # actually serve (ADR-0042). `token` is false when :client_tokens holds
  # no usable entry (the fail-closed state of issue #28), `oauth` lists
  # only providers whose credentials are complete.
  def auth_methods(conn, _params) do
    json(conn, %{token: Auth.token_auth_enabled?(), oauth: OAuth.enabled_providers()})
  end

  # Re-validates whatever the session holds and returns the value that
  # should ride the WS ticket / be re-written to the cookie. The OAuth
  # identity is checked first: `create` and the callback each clear the
  # other key, so at most one of them is ever set.
  defp credential(conn) do
    identity = get_session(conn, "oauth_identity")
    token = get_session(conn, "client_token")

    cond do
      allowed_identity?(identity) -> {:ok, identity}
      token && match?({:ok, _role}, Auth.client_role(token)) -> {:ok, token}
      true -> :error
    end
  end

  defp allowed_identity?(%{provider: provider, uid: uid}),
    do: OAuthAllowlist.role_for(provider, uid) != nil

  defp allowed_identity?(_identity), do: false

  defp put_credential(conn, %{provider: _provider, uid: _uid} = identity),
    do: put_session(conn, "oauth_identity", identity)

  defp put_credential(conn, token), do: put_session(conn, "client_token", token)

  # Broadcasts the Phoenix "disconnect" control event to the socket id of
  # whichever credential the session holds, so ClientSocket drops every
  # connection bound to it (issue #47). An empty session addresses
  # nothing.
  defp disconnect_sockets(conn) do
    [
      Auth.socket_id(get_session(conn, "client_token")),
      identity_socket_id(get_session(conn, "oauth_identity"))
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.each(&KaoiroServerWeb.Endpoint.broadcast(&1, "disconnect", %{}))
  end

  defp identity_socket_id(%{provider: provider, uid: uid}),
    do: Auth.oauth_socket_id(provider, uid)

  defp identity_socket_id(_identity), do: nil
end
