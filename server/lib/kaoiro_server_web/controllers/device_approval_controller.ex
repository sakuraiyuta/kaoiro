defmodule KaoiroServerWeb.DeviceApprovalController do
  @moduledoc """
  The browser's side of the device authorization grant (issue 801): the
  verification URI and the approval API the dashboard calls.

  The approval API accepts only an OAuth session cookie, never a bearer
  or a shared-token session: approving binds the approver's identity to
  the device, so the approver must be a person the allow-list names. It
  requires a JSON body, which keeps it same-origin for the same reason as
  `POST /session/new` (an HTML form cannot send JSON, and a cross-origin
  JSON request needs a CORS preflight this server never answers).
  """

  use KaoiroServerWeb, :controller

  alias KaoiroServer.{DeviceAuth, OAuthAllowlist}
  alias KaoiroServerWeb.SessionCredential

  # GET /device: the verification URI. The browser carries the
  # `#code=...` fragment of the complete URI over to the redirect target.
  def entry(conn, _params), do: redirect(conn, to: "/index.html?device=1")

  def lookup(conn, params) do
    with {:ok, identity} <- approver(conn),
         {:ok, user_code} <- user_code(params) do
      case DeviceAuth.lookup(user_code, identity) do
        {:ok, info} ->
          json(conn, %{
            user_code: info.user_code,
            client_id: info.client_id,
            issued_at: info.issued_at |> DateTime.from_unix!() |> DateTime.to_iso8601(),
            expires_in: info.expires_in,
            identity: identity,
            role: OAuthAllowlist.role_for(identity.provider, identity.uid)
          })

        {:error, reason} ->
          code_error(conn, reason)
      end
    else
      {:error, status, body} -> send_error(conn, status, body)
    end
  end

  def decision(conn, params) do
    with {:ok, identity} <- approver(conn),
         {:ok, user_code} <- user_code(params),
         {:ok, decision} <- decision_param(params) do
      case DeviceAuth.decide(user_code, identity, decision) do
        {:ok, state} -> json(conn, %{state: state})
        {:error, :already_decided} -> send_error(conn, :conflict, %{error: "already_decided"})
        {:error, reason} -> code_error(conn, reason)
      end
    else
      {:error, status, body} -> send_error(conn, status, body)
    end
  end

  # Header first, so a bearer is never silently ignored; then the session,
  # so an unauthenticated caller learns nothing from the body's shape; then
  # the content type.
  defp approver(conn) do
    if get_req_header(conn, "authorization") != [] do
      {:error, :bad_request, %{error: "cookie_session_required"}}
    else
      case SessionCredential.resolve(conn) do
        {:oauth, identity} -> json_body(conn, identity)
        {:token, _token} -> {:error, :forbidden, %{error: "oauth_session_required"}}
        nil -> {:error, :unauthorized, %{error: "unauthorized"}}
      end
    end
  end

  defp json_body(conn, identity) do
    case get_req_header(conn, "content-type") do
      [type | _] ->
        if String.starts_with?(type, "application/json"),
          do: {:ok, identity},
          else: {:error, :unsupported_media_type, ""}

      [] ->
        {:error, :unsupported_media_type, ""}
    end
  end

  defp user_code(%{"user_code" => code}) when is_binary(code), do: {:ok, code}
  defp user_code(_params), do: {:error, :bad_request, %{error: "invalid_request"}}

  defp decision_param(%{"decision" => "approve"}), do: {:ok, :approve}
  defp decision_param(%{"decision" => "deny"}), do: {:ok, :deny}
  defp decision_param(_params), do: {:error, :bad_request, %{error: "invalid_request"}}

  defp code_error(conn, :unknown_code), do: send_error(conn, :not_found, %{error: "unknown_code"})
  defp code_error(conn, :expired), do: send_error(conn, :gone, %{error: "expired"})

  defp code_error(conn, {:rate_limited, retry_after}),
    do: send_error(conn, :too_many_requests, %{error: "rate_limited", retry_after: retry_after})

  defp send_error(conn, status, ""), do: send_resp(conn, status, "")
  defp send_error(conn, status, body), do: conn |> put_status(status) |> json(body)
end
