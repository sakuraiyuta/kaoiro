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

    # Warm the persona pack manifest cache before the endpoint serves
    # requests (ADR-0029). The watcher below reacts to live changes.
    :ok = KaoiroServer.PersonaAssets.rebuild()

    children = [
      KaoiroServerWeb.Telemetry,
      {DNSCluster, query: Application.get_env(:kaoiro_server, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: KaoiroServer.PubSub},
      KaoiroServer.AgentStates,
      # Live host set + spawnable personas per host (ADR-0023, issue #67).
      KaoiroServer.HostRegistry,
      # Restart-surviving session_id pointers (ADR-0014 F1, issue #49).
      KaoiroServer.SessionPointers,
      # Restart-surviving per-agent permission_mode picks (#58).
      KaoiroServer.PermissionModes,
      # Structured inter-agent history cannot be rebuilt from SDK JSONL;
      # persist it across server/container restarts (#105).
      KaoiroServer.InterAgentHistory,
      # Per-agent clear watermarks so operator `clear_history` hides past
      # durable inter-agent messages from the cleared agent's transcript
      # on subsequent reloads (issue #109). Peer panes are unaffected.
      KaoiroServer.ClearWatermarks,
      # Session-transition start records are intentionally independent from
      # visibility: only clear_history adopts one into ClearWatermarks (#109).
      KaoiroServer.SessionStarts,
      # Single serialized allocator for the server-side ingress ordering
      # domain (ふじ R5 must-fix, 2026-07-23). Both `InterAgentHistory`
      # (per-envelope order stamp) and the operator `clear_history`
      # watermark record allocate through it. Restart-durable + wall-
      # clock-rollback safe. MUST start after InterAgentHistory and
      # ClearWatermarks so its `seed_from` can read their current
      # tuple state to bound `last_us` below live-consumer records.
      {KaoiroServer.IngressOrder,
       seed_from: [
         &KaoiroServer.InterAgentHistory.all_with_order/0,
         &KaoiroServer.ClearWatermarks.all_orders/0,
         &KaoiroServer.SessionStarts.all_orders/0
       ]},
      # Per-agent_id token denylist (issue #72): additive revoke channel
      # for ADR-0024's server-minted wrapper tokens. Checked in
      # `Auth.authorize_wrapper/2`; seeded by `delete_agent` and by
      # operator revoke.
      KaoiroServer.TokenDenylist,
      # Session-reset pending lock (ADR-0036 F6/F7, phase-17 17-4).
      # In-memory only; a reset in flight when the server dies is a wash.
      KaoiroServer.SessionResets,
      # Restart-surviving identity ledger — agent_id → persona (ADR-0030).
      # Lets operator-driven restore work after a server restart when
      # AgentStates is empty.
      KaoiroServer.AgentDirectory,
      # Per-conversation hard limits for inter-agent messaging
      # (protocol-inter-agent spec, phase-8 Stage B).
      KaoiroServer.ConversationStates,
      # Watch persona ingest dir for zip changes and rebuild the manifest
      # cache without restart (ADR-0029 F6).
      KaoiroServer.PersonaWatcher,
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
