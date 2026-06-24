defmodule KaoiroServerWeb.RunnerSocket do
  @moduledoc """
  Socket for runner connections (one resident runner per host, ADR-0023).
  The control channel `runner:<host_id>` is a separate system from the
  data path `wrapper:<agent_id>` (ADR-0023). The connect params carry the
  runner's token; it is checked against the per-host_id token list at
  channel join, where the host_id is known. TLS terminates at the reverse
  proxy.
  """

  use Phoenix.Socket

  channel "runner:*", KaoiroServerWeb.RunnerChannel

  @impl true
  def connect(params, socket, _connect_info) do
    {:ok, assign(socket, :runner_token, params["token"])}
  end

  @impl true
  def id(_socket), do: nil
end
