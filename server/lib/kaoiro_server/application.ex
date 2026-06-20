defmodule KaoiroServer.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    # Warn about unset token lists (client = locked / wrapper = dev mode)
    # so the state is visible in logs (specs/threat-model.md, issue #28).
    :ok = KaoiroServer.Auth.warn_token_config()

    # Warm the sprite manifest cache before the endpoint serves requests.
    :ok = KaoiroServer.PersonaAssets.rebuild()

    children = [
      KaoiroServerWeb.Telemetry,
      {DNSCluster, query: Application.get_env(:kaoiro_server, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: KaoiroServer.PubSub},
      KaoiroServer.AgentStates,
      # Restart-surviving session_id pointers (ADR-0014 F1, issue #49).
      KaoiroServer.SessionPointers,
      # Start to serve requests, typically the last entry
      KaoiroServerWeb.Endpoint
    ]

    # See https://hexdocs.pm/elixir/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: KaoiroServer.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    KaoiroServerWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
