defmodule KaoiroServerWeb.SessionCredential do
  @moduledoc """
  Resolves the dashboard session cookie's credential with LIVE
  revalidation (ADR-0013/0042) — shared by `SessionController` (cookie
  refresh/ticket) and `RequireOperatorPlug` / `RequireAuthenticatedPlug` (HTTP gates) so "what counts as a still-valid credential" lives in exactly one
  place. No caller keeps its own copy of this check: a revoked
  token or an identity dropped from the OAuth allow-list must stop
  authenticating everywhere at the same request, not just at whichever
  endpoint happens to re-check it.

  Returns the SAME tagged-tuple shape `KaoiroServerWeb.ClientSocket`
  already uses (`{:token, token}` / `{:oauth, identity}`), so a caller
  that needs a role can hand the result straight to `ClientSocket.role_for/1`
  instead of re-deriving one.

  `resolve/1` reads the cookie only. `resolve_request/1` adds the device
  access token (`Authorization: Bearer`, issue 801) for the endpoints that
  accept it, and reports which source answered so a bearer failure never
  reaches the cookie's failure handling.
  """

  import Plug.Conn

  alias KaoiroServer.Auth
  alias KaoiroServer.DeviceAccessToken
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

  @doc """
  Resolves the credential a request presents (issue 801). An
  `Authorization` header is evaluated alone and never falls back to the
  cookie: a request carrying the header comes from a native client, and a
  bad bearer must not be answered with whatever cookie rides along. With
  no header this is `resolve/1`. A failed bearer carries no part of its
  payload, so callers cannot derive a disconnect target or a new token
  from unverified input.
  """
  @spec resolve_request(Plug.Conn.t()) ::
          {:cookie, {:token, String.t()} | {:oauth, map()} | nil}
          | {:bearer,
             {:ok, %{identity: map(), issued_at: integer()}}
             | {:error, bearer_error()}}
  def resolve_request(conn) do
    case get_req_header(conn, "authorization") do
      [] -> {:cookie, resolve(conn)}
      [value] -> {:bearer, resolve_bearer(conn, value)}
      _several -> {:bearer, {:error, :malformed}}
    end
  end

  @type bearer_error ::
          :malformed
          | :unsupported_scheme
          | :insecure_transport
          | :invalid
          | :expired
          | :too_old
          | :not_allowed

  @doc """
  Whether `conn` arrived over https, after `Plug.SSL` has applied
  `x-forwarded-proto`. The `:device_auth_allow_insecure_transport`
  exception is set only in dev.exs and test.exs; runtime.exs never reads
  it, so a release cannot turn it on.
  """
  @spec secure_transport?(Plug.Conn.t()) :: boolean()
  def secure_transport?(conn) do
    conn.scheme == :https or
      Application.get_env(:kaoiro_server, :device_auth_allow_insecure_transport, false) == true
  end

  @doc "The RFC 6750 §3 challenge for a bearer failure."
  @spec www_authenticate(bearer_error() | :insufficient_scope) :: String.t()
  def www_authenticate(:unsupported_scheme), do: ~s(Bearer realm="kaoiro")
  def www_authenticate(:insufficient_scope), do: challenge("insufficient_scope")

  def www_authenticate(reason) when reason in [:malformed, :insecure_transport],
    do: challenge("invalid_request")

  def www_authenticate(_reason), do: challenge("invalid_token")

  @doc """
  Answers a failed bearer: 400 `invalid_request` for a malformed request,
  otherwise 401 with `unauthorized_body` (a map is sent as JSON, a string
  as is), each with its `WWW-Authenticate` challenge. It touches neither
  the session nor any socket. The caller halts.
  """
  @spec reject_bearer(Plug.Conn.t(), bearer_error(), map() | String.t()) :: Plug.Conn.t()
  def reject_bearer(conn, reason, unauthorized_body) do
    conn = put_resp_header(conn, "www-authenticate", www_authenticate(reason))

    if reason in [:malformed, :insecure_transport] do
      conn
      |> put_status(:bad_request)
      |> Phoenix.Controller.json(%{"error" => "invalid_request"})
    else
      send_body(put_status(conn, :unauthorized), unauthorized_body)
    end
  end

  defp send_body(conn, body) when is_map(body), do: Phoenix.Controller.json(conn, body)
  defp send_body(conn, body), do: send_resp(conn, conn.status, body)

  defp challenge(error), do: ~s(Bearer realm="kaoiro", error="#{error}")

  # RFC 6750 §2.1: credentials = "Bearer" 1*SP b64token, scheme matched
  # case-insensitively.
  @b64token ~r/\A[A-Za-z0-9\-._~+\/]+=*\z/

  defp resolve_bearer(conn, value) do
    with {:ok, token} <- bearer_token(value),
         true <- secure_transport?(conn) || {:error, :insecure_transport},
         {:ok, %{identity: %{provider: provider, uid: uid}}} = ok <-
           DeviceAccessToken.decrypt(token, System.system_time(:second)) do
      if OAuthAllowlist.role_for(provider, uid) != nil, do: ok, else: {:error, :not_allowed}
    end
  end

  defp bearer_token(value) do
    case String.split(value, " ", parts: 2) do
      [scheme, rest] ->
        token = String.trim_leading(rest, " ")

        cond do
          String.downcase(scheme) != "bearer" -> {:error, :unsupported_scheme}
          Regex.match?(@b64token, token) -> {:ok, token}
          true -> {:error, :malformed}
        end

      [scheme] ->
        if String.downcase(scheme) == "bearer",
          do: {:error, :malformed},
          else: {:error, :unsupported_scheme}
    end
  end

  defp valid_identity?(%{provider: provider, uid: uid}),
    do: OAuthAllowlist.role_for(provider, uid) != nil

  defp valid_identity?(_identity), do: false

  defp valid_token?(token) when is_binary(token) and token != "",
    do: match?({:ok, _role}, Auth.client_role(token))

  defp valid_token?(_token), do: false
end
