defmodule KaoiroServerWeb.RequireAuthenticatedPlug do
  @moduledoc """
  Live authentication for protected persona HTTP delivery: the cookie, or
  a device access token in `Authorization: Bearer` (issue 801).
  """
  import Plug.Conn
  alias KaoiroServerWeb.{ClientSocket, SessionCredential}

  @unauthorized %{"error" => "unauthorized"}

  def init(opts), do: opts

  def call(conn, _opts) do
    conn = put_resp_header(conn, "cache-control", "private, no-store")

    case SessionCredential.resolve_request(conn) do
      {:cookie, credential} ->
        case ClientSocket.role_for(credential) do
          role when role in [:viewer, :operator, :admin] ->
            assign(conn, :persona_role, role)

          _ ->
            conn |> put_status(:unauthorized) |> Phoenix.Controller.json(@unauthorized) |> halt()
        end

      {:bearer, {:ok, %{identity: identity}}} ->
        case ClientSocket.role_for({:oauth, identity}) do
          role when role in [:viewer, :operator, :admin] -> assign(conn, :persona_role, role)
          _ -> reject(conn, :not_allowed)
        end

      {:bearer, {:error, reason}} ->
        reject(conn, reason)
    end
  end

  defp reject(conn, reason),
    do: conn |> SessionCredential.reject_bearer(reason, @unauthorized) |> halt()
end
