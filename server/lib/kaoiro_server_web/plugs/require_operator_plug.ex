defmodule KaoiroServerWeb.RequireOperatorPlug do
  @moduledoc """
  Gates an HTTP endpoint to operator/admin roles only (issue #232 MF-1),
  mirroring `AgentsChannel`'s `@operator_capable_roles` gate for the HTTP
  surface — the same two roles admitted for WS operator actions.

  Re-resolves the role from the session cookie's credential on EVERY
  request via `SessionCredential.resolve/1` + `ClientSocket.role_for/1` —
  never a role cached at login — so a revoked token or an allow-list
  demotion takes effect at the very next request instead of waiting for
  cookie expiry (same live-revalidate contract `AgentsChannel.require_operator/1`
  and `SessionController`'s refresh/ticket already hold for the WS and
  cookie-refresh paths respectively).

  Fail-closed on every non-operator outcome: no credential at all (never
  logged in, or one that no longer validates) -> 401; a credential that
  resolves to `:viewer` -> 403. Must run AFTER `:fetch_session` in the
  pipeline.
  """

  import Plug.Conn

  alias KaoiroServerWeb.ClientSocket
  alias KaoiroServerWeb.SessionCredential

  @operator_capable_roles [:operator, :admin]

  def init(opts), do: opts

  def call(conn, _opts) do
    case role(conn) do
      nil -> deny(conn, :unauthorized, "unauthorized")
      role when role in @operator_capable_roles -> conn
      _viewer -> deny(conn, :forbidden, "forbidden")
    end
  end

  @doc "Live-resolves the requester's role from the session cookie, or nil."
  @spec role(Plug.Conn.t()) :: :viewer | :operator | :admin | nil
  def role(conn), do: conn |> SessionCredential.resolve() |> ClientSocket.role_for()

  defp deny(conn, status, error) do
    conn
    |> put_status(status)
    |> Phoenix.Controller.json(%{"error" => error})
    |> halt()
  end
end
