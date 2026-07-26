defmodule KaoiroServerWeb.AuthController do
  @moduledoc """
  The dashboard's OAuth login endpoints (ADR-0042).

  - `request` (`GET /auth/:provider`): starts the flow — redirects to the
    provider and stashes the OAuth2 `state` in the session cookie, bound
    to the provider it was minted for.
  - `callback` (`GET /auth/:provider/callback`): verifies that state,
    resolves the identity, checks it against
    `KaoiroServer.OAuthAllowlist`, and on success stores only
    `%{provider:, uid:}` in the session before redirecting to the
    dashboard. The role is deliberately NOT stored: it is re-resolved
    from the allow-list on every connect / refresh (ADR-0042), the same
    way the token path re-resolves `Auth.client_role/1`.

  An unknown or unconfigured provider 404s. Every other failure ends as
  a redirect to `/index.html?auth_error=…` with one of
  `provider_error` | `not_allowed` | `invalid_state`, which is the
  contract the dashboard's login screen renders.
  """

  use KaoiroServerWeb, :controller

  require Logger

  alias KaoiroServer.OAuth
  alias KaoiroServer.OAuthAllowlist

  @state_key "oauth_session_params"
  @identity_key "oauth_identity"

  def request(conn, %{"provider" => provider}) do
    if OAuth.enabled?(provider) do
      start_flow(conn, provider)
    else
      unknown_provider(conn)
    end
  end

  def callback(conn, %{"provider" => provider} = params) do
    # The state is single-use: drop it before doing anything else so a
    # replayed callback cannot reuse it, whatever the outcome below.
    stored = get_session(conn, @state_key)
    conn = delete_session(conn, @state_key)

    if OAuth.enabled?(provider) do
      finish_flow(conn, provider, params, stored)
    else
      unknown_provider(conn)
    end
  end

  defp start_flow(conn, provider) do
    case OAuth.authorize_url(provider) do
      {:ok, %{url: url, session_params: session_params}} ->
        conn
        # The provider is stored alongside the state so a state minted
        # for one provider cannot be spent on another provider's
        # callback.
        |> put_session(@state_key, %{provider: provider, params: session_params})
        |> redirect(external: url)

      {:error, error} ->
        log_failure(provider, "authorize_url", error)
        auth_error(conn, "provider_error")
    end
  end

  defp finish_flow(conn, provider, params, %{provider: provider, params: session_params}) do
    case OAuth.callback(provider, params, session_params) do
      {:ok, identity} ->
        grant(conn, identity)

      {:error, %Assent.CallbackCSRFError{} = error} ->
        log_failure(provider, "callback", error)
        auth_error(conn, "invalid_state")

      {:error, %Assent.MissingParamError{key: "state"} = error} ->
        log_failure(provider, "callback", error)
        auth_error(conn, "invalid_state")

      {:error, error} ->
        log_failure(provider, "callback", error)
        auth_error(conn, "provider_error")
    end
  end

  # No stored state at all, or one minted for a different provider: the
  # request did not start here, so there is nothing to verify against.
  defp finish_flow(conn, provider, _params, _stored) do
    Logger.warning("OAuth callback for #{provider} carried no matching state")
    auth_error(conn, "invalid_state")
  end

  defp grant(conn, %{provider: provider, uid: uid} = identity) do
    case OAuthAllowlist.role_for(provider, uid) do
      nil ->
        # The uid is logged on purpose: it is the exact string the
        # operator has to add to the allow-list to let this person in,
        # and it is an identity the provider just vouched for, not a
        # secret.
        Logger.warning("OAuth login rejected, not on the allow-list: #{provider}:#{uid}")

        auth_error(conn, "not_allowed")

      _role ->
        conn
        # One credential per session: an OAuth login supersedes any
        # shared token the same browser had exchanged earlier.
        |> delete_session("client_token")
        |> put_session(@identity_key, identity)
        |> redirect(to: "/index.html")
    end
  end

  defp auth_error(conn, reason), do: redirect(conn, to: "/index.html?auth_error=#{reason}")

  defp unknown_provider(conn), do: send_resp(conn, :not_found, "unknown provider")

  # Only the error's type is logged, never the struct or its message:
  # assent's response-carrying errors render the request headers, which
  # hold the `Authorization: Bearer …` provider access token.
  defp log_failure(provider, phase, %{__struct__: type}) do
    Logger.warning("OAuth #{phase} failed for #{provider}: #{inspect(type)}")
  end

  defp log_failure(provider, phase, error) do
    Logger.warning("OAuth #{phase} failed for #{provider}: #{inspect(error)}")
  end
end
