defmodule KaoiroServerWeb.DeviceAvailability do
  @moduledoc """
  Whether this server can serve the device authorization grant for a
  request (issue 801). One check for `POST /oauth/device`,
  `POST /oauth/token` and the `device` field of
  `GET /session/auth-methods`, so the login screen never offers what the
  endpoints would refuse.
  """

  alias KaoiroServer.{DeviceAuth, OAuth}
  alias KaoiroServerWeb.SessionCredential

  @type reason :: :insecure_transport | :single_backend | :no_provider | :no_dashboard

  @spec check(Plug.Conn.t()) :: :ok | {:error, reason()}
  def check(conn) do
    cond do
      not SessionCredential.secure_transport?(conn) -> {:error, :insecure_transport}
      not DeviceAuth.available?() -> {:error, :single_backend}
      OAuth.enabled_providers() == [] -> {:error, :no_provider}
      not Application.get_env(:kaoiro_server, :serve_dashboard, true) -> {:error, :no_dashboard}
      true -> :ok
    end
  end
end
