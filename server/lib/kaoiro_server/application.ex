defmodule KaoiroServer.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    # A release built with/without KAOIRO_PLAIN_HTTP must run the same
    # way (config/prod.exs) — fail fast instead of serving broken
    # redirects or a Secure-less cookie behind TLS.
    :ok = verify_plain_http_config!()

    # Warn about unset token lists (client = locked / wrapper = dev mode)
    # so the state is visible in logs (specs/threat-model.md, issue #28).
    :ok = KaoiroServer.Auth.warn_token_config()

    children = [
      KaoiroServerWeb.Telemetry,
      {DNSCluster, query: Application.get_env(:kaoiro_server, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: KaoiroServer.PubSub},
      KaoiroServer.AgentStates,
      # In-memory peer-directory activity projection (#160). Kept separate
      # from AgentStates, whose sole ownership is latest envelopes/history.
      KaoiroServer.AgentActivity,
      # Live-only wrapper artifact identities. A reconnect reports its own
      # package again; disconnect cleanup is owner-fenced.
      KaoiroServer.WrapperBuildInfos,
      # Flat table of active subagent/workflow tasks, keyed by task_id
      # (issue #180, ADR-0019/0047/0048 F1). Kept separate from AgentStates
      # for the same reason as AgentActivity above — a `task` envelope is
      # a distinct child entity's lifecycle, not the parent's state_change.
      KaoiroServer.TaskStates,
      # Live host set + spawnable personas per host (ADR-0023, issue #67).
      KaoiroServer.HostRegistry,
      # Restart-surviving session_id pointers (ADR-0014 F1, issue #49).
      KaoiroServer.SessionPointers,
      # Restart-surviving per-agent permission_mode picks (#58).
      KaoiroServer.PermissionModes,
      # Per-agent clear watermarks so operator `clear_history` hides past
      # inter-agent messages from the cleared agent's transcript on
      # subsequent reloads (issue #109). Peer panes are unaffected.
      KaoiroServer.ClearWatermarks,
      # Session-transition start records are intentionally independent from
      # visibility: only clear_history adopts one into ClearWatermarks (#109).
      KaoiroServer.SessionStarts,
      # Restart-surviving per-agent session_lifecycle timeline (ADR-0055,
      # phase-33 Stage B) — recording only, no peer notification.
      KaoiroServer.SessionLifecycleEvents,
      # Recipient-local dispatch-confirmation watermarks (#247).  This is
      # observational state only: no payloads and no retransmission queue.
      KaoiroServer.DeliveryStates,
      # Single serialized allocator for the server-side ingress ordering
      # domain (ふじ R5 must-fix, 2026-07-23). The live IA ingress stamp
      # (`WrapperChannel`), the `SessionStarts` transition record and the
      # operator `clear_history` watermark all allocate through it.
      # Restart-durable + wall-clock-rollback safe. MUST start after
      # ClearWatermarks and SessionStarts so its `seed_from` can read
      # their current tuple state to bound `last_us` below live-consumer
      # records.
      {KaoiroServer.IngressOrder,
       seed_from: [
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
      {KaoiroServer.SessionResets, on_failure: &KaoiroServerWeb.PeerConnectivity.fail/3},
      # Restart-surviving identity ledger — agent_id → persona (ADR-0030).
      # Lets operator-driven restore work after a server restart when
      # AgentStates is empty.
      KaoiroServer.AgentDirectory,
      # Restart-surviving user identity ledger — user_id → {kind,
      # display_name} (issue #197, ADR-0050 D1 Phase A). Resolved from
      # OAuth login / shared-token login before either writes its
      # session cookie, so it must be up before Endpoint (below) starts
      # serving those requests.
      KaoiroServer.Users,
      # Per-conversation hard limits for inter-agent messaging
      # (protocol-inter-agent spec, phase-8 Stage B). `:on_auto_closed`
      # (issue #221 direction 2) is the ONLY place this otherwise
      # web-independent module's data crosses into KaoiroServerWeb — see
      # ConversationStates' own moduledoc for why that boundary is kept.
      {KaoiroServer.ConversationStates,
       on_auto_closed: &KaoiroServerWeb.SynthEnvelope.deliver_conversation_closed/3},
      # One-token-per-agent planned wrapper-cycle state (issue #266).
      # ConversationStates supplies a read-only peer snapshot at disconnect;
      # timeout returns through the web boundary so authoritative reachability
      # selects terminal disconnected or neutral reconnected for its targets.
      {KaoiroServer.PlannedDisconnects, on_timeout: &KaoiroServerWeb.PeerConnectivity.timeout/3},
      # Single owner of the common-footer snapshot + last-known-good
      # (ADR-0045). Must precede FooterWatcher, which rebuilds through it,
      # and the Endpoint, whose WrapperChannel reads the snapshot.
      KaoiroServer.FooterAssets,
      # Serializes PersonaAssets.rebuild/0 within this node (issue #195
      # must-fix 1) and OWNS the boot-time warm rebuild (ADR-0029) via
      # its own `init/1` (`warm: true`, issue #195 round-3, ふじ
      # 2026-08-05 spec) — a raise there fails THIS Supervisor.start_link
      # outright (a root supervisor's initial child-start failure does
      # not enter the restart-intensity retry loop; measured OTP
      # 29.0.2), preserving ADR-0046 F4's cold-start fail-fast with no
      # boot-only bypass of the lock. Must precede PersonaWatcher, whose
      # FS-event handler calls `PersonaAssets.rebuild/0` (routed through
      # this lock).
      {KaoiroServer.PersonaRebuildLock, warm: true},
      # Watch persona ingest dir for zip changes and rebuild the manifest
      # cache without restart (ADR-0029 F6).
      KaoiroServer.PersonaWatcher,
      # Watch KAOIRO_FOOTER_DIR for system-footer.md / user-footer.md
      # (ADR-0045 F4). Ignores itself when the env is unset or the dir is
      # absent — file-based footers are opt-in.
      KaoiroServer.FooterWatcher,
      # Change-driven targeted disconnect for OAuth allow-list edits
      # (issue #170, ふじ 2026-08-05 spec). MUST start after
      # Phoenix.PubSub (broadcasts need it) and BEFORE Endpoint: no
      # client socket can exist yet when this runs its first reconcile,
      # so the :persistent_term checkpoint is seeded without diffing
      # against an empty map (see OAuthAllowlistWatcher moduledoc
      # "Checkpoint"). Ignores itself only when
      # KAOIRO_OAUTH_ALLOWLIST_PATH is unset; otherwise degrades to
      # periodic-poll-only rather than :ignore (unlike PersonaWatcher /
      # FooterWatcher above) — this is an authorization control, not an
      # asset cache, so a missing event source must not silently stop
      # enforcing revocation.
      KaoiroServer.OAuthAllowlistWatcher,
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

  # `:plain_http_build` is set only by config/prod.exs (compile time), so
  # dev/test — where force_ssl/session_secure are off anyway — skip the
  # check. In a release, the flag baked into the build must match the
  # runtime env: a TLS build run with KAOIRO_PLAIN_HTTP=true would still
  # 301 every http request (force_ssl is compile-time), and a plain-HTTP
  # build run without it would emit http URLs while claiming https.
  def verify_plain_http_config! do
    case Application.fetch_env(:kaoiro_server, :plain_http_build) do
      :error ->
        :ok

      {:ok, built?} ->
        runtime? = System.get_env("KAOIRO_PLAIN_HTTP") == "true"

        if built? != runtime? do
          raise """
          KAOIRO_PLAIN_HTTP mismatch: this release was built with \
          KAOIRO_PLAIN_HTTP=#{built?} but is running with \
          KAOIRO_PLAIN_HTTP=#{runtime?}. The flag is compile-time \
          (force_ssl / Secure cookie) — rebuild the image with the same \
          value set in .env (docker compose wires it to both build and \
          runtime), or unset it in both places.
          """
        end

        :ok
    end
  end
end
