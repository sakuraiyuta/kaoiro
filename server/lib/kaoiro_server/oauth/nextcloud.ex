defmodule KaoiroServer.OAuth.Nextcloud do
  @moduledoc """
  Assent strategy for a self-hosted Nextcloud instance (ADR-0042).

  Assent ships no Nextcloud strategy, so this is the smallest
  `Assent.Strategy.OAuth2.Base` wrapper around the endpoints the
  Nextcloud `oauth2` app exposes:

  - authorize `GET {base_url}/apps/oauth2/authorize`
  - token `POST {base_url}/apps/oauth2/api/v1/token`
  - identity `GET {base_url}/ocs/v2.php/cloud/user?format=json`

  Two Nextcloud specifics drive the shape below:

  - every OCS call needs an `OCS-APIRequest: true` header, so
    `fetch_user/2` passes it explicitly rather than using the inherited
    default.
  - the OCS envelope nests the payload under `ocs.data`, so `normalize/2`
    unwraps it before mapping to OIDC standard claims.

  PKCE is not configured: the Nextcloud token endpoint ignores
  `code_verifier` entirely, so only the OAuth2 `state` parameter guards
  the callback. Client authentication uses `client_secret_post`, which
  the token endpoint accepts alongside HTTP Basic.
  """

  use Assent.Strategy.OAuth2.Base

  alias Assent.Strategy.OAuth2

  @impl true
  def default_config(_config) do
    [
      authorize_url: "/apps/oauth2/authorize",
      token_url: "/apps/oauth2/api/v1/token",
      user_url: "/ocs/v2.php/cloud/user",
      auth_method: :client_secret_post
    ]
  end

  @impl true
  def fetch_user(config, token) do
    OAuth2.fetch_user(config, token, [format: "json"], [{"ocs-apirequest", "true"}])
  end

  @impl true
  def normalize(_config, user) do
    case user do
      %{"ocs" => %{"data" => %{"id" => id} = data}} when is_binary(id) and id != "" ->
        {:ok,
         %{
           "sub" => id,
           "name" => data["display-name"] || data["displayname"],
           "email" => data["email"]
         }}

      _other ->
        {:error, "no user id in the Nextcloud OCS response"}
    end
  end
end
