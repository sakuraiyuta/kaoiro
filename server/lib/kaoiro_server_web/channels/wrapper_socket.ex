defmodule KaoiroServerWeb.WrapperSocket do
  @moduledoc """
  Socket for wrapper connections (one per local wrapper, ADR-0002).
  The connect params carry the wrapper's token; it is checked against
  the per-agent_id token list at channel join, where the agent_id is
  known (ADR-0011). TLS terminates at the reverse proxy.
  """

  use Phoenix.Socket

  channel "wrapper:*", KaoiroServerWeb.WrapperChannel

  @impl true
  def connect(params, socket, _connect_info) do
    {:ok, assign(socket, :wrapper_token, params["token"])}
  end

  @impl true
  def id(_socket), do: nil
end
