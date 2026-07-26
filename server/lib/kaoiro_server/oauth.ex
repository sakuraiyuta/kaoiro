defmodule KaoiroServer.OAuth do
  @moduledoc """
  OAuth provider wiring for the dashboard login (ADR-0042).

  Wraps `assent` so the rest of the server only ever sees a normalized
  identity — `%{provider: binary(), uid: binary()}` — and never the
  provider's access token. The token map assent returns from
  `callback/3` is dropped here on purpose: Nextcloud's OAuth2 has no
  scopes, so its token grants full account access and must not reach the
  session, a DETS store, or a log line.

  A provider is *enabled* only when its whole credential set is present
  (`KAOIRO_OAUTH_<PROVIDER>_CLIENT_ID` + `_CLIENT_SECRET`, plus
  `KAOIRO_OAUTH_NEXTCLOUD_BASE_URL` for Nextcloud). Anything else is
  treated as "not configured" — `authorize_url/1` and `callback/3` then
  fail closed with `{:error, :unknown_provider}` rather than sending a
  half-built request to the provider.

  The redirect URI is derived from the endpoint's `:url` config
  (`{scheme}://{host}[:{port}]/auth/{provider}/callback`) so it always
  matches the origin the browser actually reached, including the
  plain-HTTP deployment mode. Note that Google requires an https
  redirect URI for anything but localhost, so Google login cannot be
  used with `KAOIRO_PLAIN_HTTP=true`; GitHub and Nextcloud accept http.

  The `uid` is the value the allow-list is written against
  (`KaoiroServer.OAuthAllowlist`): the lower-cased e-mail for Google,
  the login for GitHub, the user id for Nextcloud.
  """

  require Logger

  @providers ["google", "github", "nextcloud"]

  @doc "Every provider name this server knows about, enabled or not."
  @spec provider_names :: [binary()]
  def provider_names, do: @providers

  @doc "Provider names whose credentials are fully configured."
  @spec enabled_providers :: [binary()]
  def enabled_providers, do: Enum.filter(@providers, &enabled?/1)

  @doc """
  Whether `provider` is a known provider with complete credentials.

  Reads env only — deliberately NOT via `config/1`, which derives the
  redirect URI from the endpoint. `warn_config/0` runs from
  `KaoiroServer.Application.start/2` BEFORE the supervision tree brings
  the endpoint up, and `KaoiroServerWeb.Endpoint.url/0` raises until
  then, so a boot-time enablement check must not reach it.
  """
  @spec enabled?(binary()) :: boolean()
  def enabled?(provider) do
    provider in @providers and Enum.all?(settings(provider), &present?/1)
  end

  @doc """
  Builds the provider's authorization URL. The returned `:session_params`
  (the OAuth2 `state`) must be stored server-side and handed back to
  `callback/3` — that is what makes the callback CSRF-resistant.
  """
  @spec authorize_url(binary()) ::
          {:ok, %{url: binary(), session_params: map()}} | {:error, term()}
  def authorize_url(provider) do
    case config(provider) do
      nil -> {:error, :unknown_provider}
      config -> strategy(provider).authorize_url(config)
    end
  end

  @doc """
  Completes the callback phase and returns the normalized identity.

  `session_params` is the map `authorize_url/1` produced for this same
  request; assent verifies the `state` against it. The provider access
  token is discarded here and never returned to the caller.
  """
  @spec callback(binary(), map(), map()) ::
          {:ok, %{provider: binary(), uid: binary()}} | {:error, term()}
  def callback(provider, params, session_params) do
    case config(provider) do
      nil ->
        {:error, :unknown_provider}

      config ->
        config
        |> Keyword.put(:session_params, session_params)
        |> strategy(provider).callback(params)
        |> case do
          {:ok, %{user: user}} -> identity(provider, user)
          {:error, error} -> {:error, error}
        end
    end
  end

  @doc """
  Logs the OAuth configuration states that can only be mistakes, so a
  half-wired deployment is visible in the boot log instead of failing
  silently at the first login attempt. Called from
  `KaoiroServer.Auth.warn_token_config/0`.

  A server with no OAuth configuration at all is a supported setup
  (shared tokens only) and is deliberately not warned about.
  """
  @spec warn_config :: :ok
  def warn_config do
    Enum.each(@providers, &warn_partial_config/1)

    enabled = enabled_providers()

    cond do
      enabled != [] and not KaoiroServer.OAuthAllowlist.configured?() ->
        Logger.warning(
          "KAOIRO_OAUTH_ALLOWLIST_PATH unset while OAuth providers are " <>
            "configured (#{Enum.join(enabled, ", ")}): every OAuth login " <>
            "is rejected (fail-closed). Point it at the allow-list file."
        )

      enabled == [] and KaoiroServer.OAuthAllowlist.configured?() ->
        Logger.warning(
          "KAOIRO_OAUTH_ALLOWLIST_PATH is set but no OAuth provider is " <>
            "configured: the allow-list has no effect. Set " <>
            "KAOIRO_OAUTH_<PROVIDER>_CLIENT_ID/_CLIENT_SECRET."
        )

      true ->
        :ok
    end

    :ok
  end

  # A provider with some — but not all — of its settings present is
  # silently skipped by enabled?/1, which looks exactly like "OAuth is
  # off" from the dashboard. Say so at boot instead.
  defp warn_partial_config(provider) do
    settings = settings(provider)

    if Enum.any?(settings, &present?/1) and not Enum.all?(settings, &present?/1) do
      Logger.warning(
        "KAOIRO_OAUTH_#{String.upcase(provider)}_* is incomplete: the " <>
          "#{provider} login is disabled until every value is set."
      )
    end
  end

  defp settings("google"),
    do: [env(:oauth_google_client_id), env(:oauth_google_client_secret)]

  defp settings("github"),
    do: [env(:oauth_github_client_id), env(:oauth_github_client_secret)]

  defp settings("nextcloud") do
    [
      env(:oauth_nextcloud_client_id),
      env(:oauth_nextcloud_client_secret),
      env(:oauth_nextcloud_base_url)
    ]
  end

  # Only ever called from the request path (authorize_url/1, callback/3),
  # so touching the endpoint here is safe.
  defp config(provider) do
    if enabled?(provider) do
      base(provider, Enum.map(settings(provider), &String.trim/1))
    end
  end

  defp base("nextcloud", [client_id, client_secret, base_url]) do
    [
      client_id: client_id,
      client_secret: client_secret,
      base_url: String.trim_trailing(base_url, "/"),
      redirect_uri: redirect_uri("nextcloud")
    ]
  end

  defp base(provider, [client_id, client_secret]) do
    [
      client_id: client_id,
      client_secret: client_secret,
      redirect_uri: redirect_uri(provider)
    ]
  end

  defp redirect_uri(provider) do
    KaoiroServerWeb.Endpoint.url() <> "/auth/" <> provider <> "/callback"
  end

  defp strategy("google"), do: Assent.Strategy.Google
  defp strategy("github"), do: Assent.Strategy.Github
  defp strategy("nextcloud"), do: KaoiroServer.OAuth.Nextcloud

  defp env(key), do: Application.get_env(:kaoiro_server, key)

  defp present?(value), do: is_binary(value) and String.trim(value) != ""

  @doc """
  Maps a provider's normalized claims to the identity the allow-list is
  written against, or `{:error, :no_identity}` when the claim that
  carries it is missing.

  Public because it is the security-relevant half of `callback/3` — in
  particular Google's `email_verified` gate — and unit-testing it
  directly is far cheaper than driving an OIDC discovery + JWKS flow.
  """
  @spec identity(binary(), map()) ::
          {:ok, %{provider: binary(), uid: binary()}} | {:error, :no_identity}
  # Google's e-mail is only trusted when the provider says it is
  # verified: the allow-list is written against e-mail addresses, so an
  # unverified one would let anyone claim an allow-listed address.
  def identity("google", user) do
    case {user["email"], user["email_verified"]} do
      {email, true} when is_binary(email) and email != "" ->
        {:ok, %{provider: "google", uid: String.downcase(email)}}

      _other ->
        {:error, :no_identity}
    end
  end

  def identity("github", user), do: uid_from(user, "github", "preferred_username")
  def identity("nextcloud", user), do: uid_from(user, "nextcloud", "sub")

  defp uid_from(user, provider, claim) do
    case user[claim] do
      uid when is_binary(uid) and uid != "" -> {:ok, %{provider: provider, uid: uid}}
      _other -> {:error, :no_identity}
    end
  end
end
