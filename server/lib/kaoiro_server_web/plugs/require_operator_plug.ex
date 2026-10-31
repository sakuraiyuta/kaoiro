defmodule KaoiroServerWeb.RequireOperatorPlug do
  @moduledoc """
  Gates an HTTP endpoint to operator/admin roles only (issue #232 MF-1),
  mirroring `AgentsChannel`'s `@operator_capable_roles` gate for the HTTP
  surface — the same two roles admitted for WS operator actions.

  Re-resolves the role from the request's credential (the session cookie,
  or a device access token in `Authorization: Bearer`, issue 801) on EVERY
  request via `SessionCredential.resolve_request/1` + `ClientSocket.role_for/1` —
  never a role cached at login — so a revoked token or an allow-list
  demotion takes effect at the very next request instead of waiting for
  cookie expiry (same live-revalidate contract `AgentsChannel.require_operator/1`
  and `SessionController`'s refresh/ticket already hold for the WS and
  cookie-refresh paths respectively).

  Fail-closed on every non-operator outcome: no credential at all (never
  logged in, or one that no longer validates) -> 401; a credential that
  resolves to `:viewer` -> 403. A bearer failure is answered with its
  RFC 6750 challenge instead (`SessionCredential.reject_bearer/3`), and a
  bearer viewer's 403 carries `error="insufficient_scope"`. Must run AFTER
  `:fetch_session` in the pipeline.
  """

  import Plug.Conn

  alias KaoiroServerWeb.ClientSocket
  alias KaoiroServerWeb.SessionCredential

  @operator_capable_roles [:operator, :admin]

  def init(opts), do: opts

  def call(conn, _opts) do
    case SessionCredential.resolve_request(conn) do
      {:cookie, credential} ->
        case ClientSocket.role_for(credential) do
          nil -> deny(conn, :unauthorized, "unauthorized")
          role when role in @operator_capable_roles -> conn
          _viewer -> deny(conn, :forbidden, "forbidden")
        end

      {:bearer, {:ok, %{identity: identity}}} ->
        case ClientSocket.role_for({:oauth, identity}) do
          nil ->
            reject_bearer(conn, :not_allowed)

          role when role in @operator_capable_roles ->
            conn

          _viewer ->
            conn
            |> put_resp_header(
              "www-authenticate",
              SessionCredential.www_authenticate(:insufficient_scope)
            )
            |> deny(:forbidden, "forbidden")
        end

      {:bearer, {:error, reason}} ->
        reject_bearer(conn, reason)
    end
  end

  defp reject_bearer(conn, reason) do
    conn
    |> SessionCredential.reject_bearer(reason, %{"error" => "unauthorized"})
    |> halt()
  end

  defp deny(conn, status, error) do
    conn
    |> put_status(status)
    |> Phoenix.Controller.json(%{"error" => error})
    |> halt()
  end
end
