defmodule KaoiroServerWeb.ClientSocket do
  @moduledoc """
  Socket for client connections (public protocol, ADR-0009: Channels only,
  vsn=2.0.0). Access control is the token + role stub (ADR-0011, the
  ADR-0005 whitelist made concrete): the connect params carry a user
  token resolved to viewer/operator; with no token list configured the
  connection is accepted as operator (dev mode).
  """

  use Phoenix.Socket

  alias KaoiroServer.Auth

  channel "agents:*", KaoiroServerWeb.AgentsChannel

  @impl true
  def connect(params, socket, _connect_info) do
    case Auth.client_role(params["token"]) do
      {:ok, role} -> {:ok, assign(socket, :role, role)}
      {:error, _reason} -> :error
    end
  end

  @impl true
  def id(_socket), do: nil
end
