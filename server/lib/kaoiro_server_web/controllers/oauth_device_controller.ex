defmodule KaoiroServerWeb.OAuthDeviceController do
  @moduledoc """
  The native client's side of the OAuth 2.0 device authorization grant
  (RFC 8628, issue 801): `POST /oauth/device` issues the codes and
  `POST /oauth/token` is polled for the access token.

  The input is read by `KaoiroServerWeb.NativeOAuthInput` before the
  router, which leaves its verdict in `conn.private`; every failure
  response, including that verdict's, is built here in the RFC 6749 §5.2
  shape. Neither endpoint reads or writes the session.

  The contract is docs/reference/protocol/device-authorization.md.
  """

  use KaoiroServerWeb, :controller

  require Logger

  alias KaoiroServer.{DeviceAccessToken, DeviceAuth, OAuthAllowlist}
  alias KaoiroServerWeb.{DeviceAvailability, NativeOAuthInput}

  @grant_type "urn:ietf:params:oauth:grant-type:device_code"

  # RFC 6749 Appendix A: client-id = *VSCHAR. Self-declared, never trusted;
  # the length cap keeps it displayable.
  @client_id ~r/\A[\x20-\x7E]{1,64}\z/

  def device(conn, _params) do
    with {:ok, params} <- input(conn),
         :ok <- available(conn),
         {:ok, client_id} <- client_id(params),
         :ok <- scope(params) do
      issue(conn, client_id)
    else
      {:error, status, body} -> send_error(conn, status, body)
    end
  end

  def token(conn, _params) do
    with {:ok, params} <- input(conn),
         :ok <- available(conn),
         :ok <- grant_type(params),
         {:ok, device_code} <- device_code(params),
         {:ok, client_id} <- client_id(params) do
      poll(conn, device_code, client_id)
    else
      {:error, status, body} -> send_error(conn, status, body)
    end
  end

  # A missing verdict means the request bypassed KaoiroServerWeb.Parsers,
  # which cannot happen through the endpoint; the match fails closed.
  defp input(%Plug.Conn{private: %{} = private}) do
    case Map.fetch!(private, NativeOAuthInput.private_key()) do
      {:ok, %{pairs: pairs}} -> {:ok, Map.new(pairs)}
      {:error, :insecure_transport} -> unavailable()
      {:error, :unsupported_media_type} -> {:error, :unsupported_media_type, ""}
      {:error, :body_too_large} -> {:error, :request_entity_too_large, error("invalid_request")}
      {:error, _malformed} -> invalid_request()
    end
  end

  defp available(conn) do
    case DeviceAvailability.check(conn) do
      :ok -> :ok
      {:error, :insecure_transport} -> unavailable()
      {:error, :single_backend} -> unavailable("device flow requires a single backend")
      {:error, _not_configured} -> unavailable()
    end
  end

  defp client_id(%{"client_id" => client_id}) do
    if Regex.match?(@client_id, client_id), do: {:ok, client_id}, else: invalid_request()
  end

  defp client_id(_params), do: invalid_request()

  # No scopes are defined: an absent or empty scope is the only one granted.
  defp scope(%{"scope" => scope}) when scope != "",
    do: {:error, :bad_request, error("invalid_scope")}

  defp scope(_params), do: :ok

  defp grant_type(%{"grant_type" => @grant_type}), do: :ok

  defp grant_type(%{"grant_type" => _other}),
    do: {:error, :bad_request, error("unsupported_grant_type")}

  defp grant_type(_params), do: invalid_request()

  defp device_code(%{"device_code" => code}) when code != "", do: {:ok, code}
  defp device_code(_params), do: invalid_request()

  defp issue(conn, client_id) do
    case DeviceAuth.issue(client_id) do
      {:ok, issued} ->
        verification_uri = KaoiroServerWeb.Endpoint.url() <> "/device"

        json(conn, %{
          device_code: issued.device_code,
          user_code: issued.user_code,
          verification_uri: verification_uri,
          verification_uri_complete: verification_uri <> "#code=" <> issued.user_code,
          expires_in: issued.expires_in,
          interval: issued.interval
        })

      {:error, {:unavailable, :clustered}} ->
        {:error, status, body} = unavailable("device flow requires a single backend")
        send_error(conn, status, body)

      {:error, {:unavailable, :capacity}} ->
        {:error, status, body} = unavailable()
        send_error(conn, status, body)

      {:error, {:rate_limited, retry_after}} ->
        {:error, status, body} = unavailable()

        conn
        |> put_resp_header("retry-after", Integer.to_string(retry_after))
        |> send_error(status, body)
    end
  end

  defp poll(conn, device_code, client_id) do
    with {:ok, %{provider: provider, uid: uid} = identity} <-
           DeviceAuth.consume(device_code, client_id),
         role when role != nil <- OAuthAllowlist.role_for(provider, uid) do
      log_success(identity, client_id)
      now = System.system_time(:second)

      json(conn, %{
        access_token: DeviceAccessToken.encrypt(identity, now, now),
        token_type: "Bearer",
        expires_in: DeviceAccessToken.expires_in(now, now),
        role: role,
        identity: %{provider: provider, uid: uid}
      })
    else
      # Approved, then dropped from the allow-list before this poll; the
      # entry is already gone.
      nil -> send_error(conn, :bad_request, error("access_denied"))
      {:error, code} -> send_error(conn, :bad_request, error(Atom.to_string(code)))
    end
  end

  # Users is consulted for the log line only, as in AuthController.grant/2:
  # an outage must not block the grant.
  defp log_success(%{provider: provider, uid: uid}, client_id) do
    user_id =
      case KaoiroServer.Users.get_or_create({:oauth, provider, uid}, "user", uid) do
        {:ok, user} -> user.id
        {:error, :unavailable} -> "unavailable"
      end

    Logger.info(
      "device authorization granted: user_id=#{user_id} provider=#{provider} " <>
        "client_id=#{inspect(client_id)}"
    )
  end

  defp unavailable, do: {:error, :service_unavailable, error("temporarily_unavailable")}

  defp unavailable(reason),
    do:
      {:error, :service_unavailable, Map.put(error("temporarily_unavailable"), "reason", reason)}

  defp invalid_request, do: {:error, :bad_request, error("invalid_request")}

  defp error(code), do: %{"error" => code}

  defp send_error(conn, status, ""), do: send_resp(conn, status, "")
  defp send_error(conn, status, body), do: conn |> put_status(status) |> json(body)
end
