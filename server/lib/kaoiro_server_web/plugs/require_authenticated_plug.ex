defmodule KaoiroServerWeb.RequireAuthenticatedPlug do
  @moduledoc "Live cookie authentication for protected persona HTTP delivery."
  import Plug.Conn
  alias KaoiroServerWeb.{ClientSocket, SessionCredential}

  def init(opts), do: opts

  def call(conn, _opts) do
    conn = put_resp_header(conn, "cache-control", "private, no-store")

    case conn |> SessionCredential.resolve() |> ClientSocket.role_for() do
      role when role in [:viewer, :operator, :admin] ->
        assign(conn, :persona_role, role)

      _ ->
        conn
        |> put_status(:unauthorized)
        |> Phoenix.Controller.json(%{"error" => "unauthorized"})
        |> halt()
    end
  end
end
