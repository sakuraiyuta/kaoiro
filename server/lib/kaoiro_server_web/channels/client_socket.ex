defmodule KaoiroServerWeb.ClientSocket do
  @moduledoc """
  Socket for client connections (public protocol, ADR-0009: Channels only,
  vsn=2.0.0). User access control is an OAuth stub for later phases
  (ADR-0005); the tracer accepts any client.
  """

  use Phoenix.Socket

  channel "agents:*", KaoiroServerWeb.AgentsChannel

  @impl true
  def connect(_params, socket, _connect_info), do: {:ok, socket}

  @impl true
  def id(_socket), do: nil
end
