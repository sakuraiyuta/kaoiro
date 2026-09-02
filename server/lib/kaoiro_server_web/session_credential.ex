defmodule KaoiroServerWeb.SessionCredential do
  @moduledoc """
  Resolves the dashboard session cookie's credential with LIVE
  revalidation (ADR-0013/0042) — shared by `SessionController` (cookie
  refresh/ticket) and `RequireOperatorPlug` (issue #232, HTTP operator
  gate) so "what counts as a still-valid credential" lives in exactly one
  place. Neither caller keeps its own copy of this check: a revoked
  token or an identity dropped from the OAuth allow-list must stop
  authenticating everywhere at the same request, not just at whichever
  endpoint happens to re-check it.

  Returns the SAME tagged-tuple shape `KaoiroServerWeb.ClientSocket`
  already uses (`{:token, token}` / `{:oauth, identity}`), so a caller
  that needs a role can hand the result straight to `ClientSocket.role_for/1`
  instead of re-deriving one.
  """

  import Plug.Conn

  alias KaoiroServer.Auth
  alias KaoiroServer.OAuthAllowlist

  @doc """
  Resolves `conn`'s session to a credential, or `nil` when it holds
  nothing usable — no credential at all, a token no configured entry
  matches (revoked/unknown), or an OAuth identity no longer on the
  allow-list. The OAuth identity is checked first: `SessionController`'s
  write paths always clear the other key, so at most one is ever set,
  but checking both means a corrupt session with both keys still
  resolves deterministically.
  """
  @spec resolve(Plug.Conn.t()) :: {:token, String.t()} | {:oauth, map()} | nil
  def resolve(conn) do
    identity = get_session(conn, "oauth_identity")
    token = get_session(conn, "client_token")

    cond do
      valid_identity?(identity) -> {:oauth, identity}
      valid_token?(token) -> {:token, token}
      true -> nil
    end
  end

  defp valid_identity?(%{provider: provider, uid: uid}),
    do: OAuthAllowlist.role_for(provider, uid) != nil

  defp valid_identity?(_identity), do: false

  defp valid_token?(token) when is_binary(token) and token != "",
    do: match?({:ok, _role}, Auth.client_role(token))

  defp valid_token?(_token), do: false
end
