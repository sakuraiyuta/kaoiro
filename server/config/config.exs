# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :kaoiro_server,
  generators: [timestamp_type: :utc_datetime],
  # Exposed at runtime as Application.get_env(:kaoiro_server, :env) since
  # config_env() itself is a compile-time-only macro (unavailable in a
  # release). Auth.authorize_wrapper/2 and authorize_runner/2 read this to
  # fail-closed on an unset token list in :prod only (issue #133).
  env: config_env(),
  # Static serving of the bundled dashboard (ADR-0007). Channels and the
  # public API stay on regardless.
  serve_dashboard: true,
  # Hard limits per inter-agent conversation (protocol-inter-agent spec,
  # phase-8 Stage B). The server enforces these mechanically — quota
  # overshoot automatically terminates the conversation with a synthetic
  # escalate-to-user broadcast. issue #211 removed the former
  # max_wallclock_ms hard limit (it punished slow-but-legitimate
  # conversations while never catching a fast runaway ping-pong, which
  # max_turns already catches first) — max_turns / max_tokens /
  # max_concurrent_agents are the only hard limits left.
  #
  # open_conversation_ttl_ms / tombstone_ttl_ms below are GC-only TTLs, NOT
  # hard limits: neither rejects a message or triggers escalate-to-user.
  inter_agent: [
    max_turns: 50,
    max_tokens: 100_000,
    max_concurrent_agents: 2,
    # OPEN entry memory-DoS reclaim (started_at basis) — see
    # KaoiroServer.ConversationStates moduledoc.
    open_conversation_ttl_ms: 86_400_000,
    # CLOSED tombstone reclaim (closed_at basis), kept in step with the
    # wrapper's CLOSED_TRACK_TTL_MS (24h) so a late message cannot land on
    # a conversation_id reused before the wrapper itself has forgotten it.
    tombstone_ttl_ms: 86_400_000
  ],
  delivery_intent: [
    early_pending_per_pair: 4,
    early_pending_per_recipient: 16,
    yield_min_interval_ms: 120_000,
    yield_tokens_per_recipient: 64,
    yield_token_ttl_ms: 86_400_000,
    delivery_stage_max_records: 2_000,
    delivery_stage_max_age_ms: 86_400_000,
    delivery_stage_retention_ms: 3_600_000
  ],
  work_store: [
    work_active_per_assignee: 16,
    work_nominated_per_principal: 16,
    work_nomination_ttl_ms: 86_400_000,
    work_max_records: 4_096,
    work_terminal_retention_ms: 2_592_000_000,
    operation_validity_ms: 86_400_000,
    work_receipts_per_work_principal: 64,
    work_receipts_per_principal: 1_024,
    work_verdicts_per_work: 64,
    work_accepted_verdicts_per_work: 64,
    work_pending_transfers: 8,
    work_checks_per_work: 64
  ]

# Review-quagmire detection (issue #273). Advisory only: nothing here
# rejects a message, closes a conversation, or messages an agent — a false
# positive that stops a working loop costs more than a missed notice. Kept
# out of :inter_agent deliberately, whose entries are all hard limits.
#
# The defaults are provisional. rally_turns comes from a thin sample (a
# healthy delegation runs well under 10 turns; the incident that motivated
# the issue reached round 18), so revisit it against the rally_turns the
# list_conversations projection reports after a month of real traffic.
# stall_ms sits ABOVE the wrapper's 30-minute turn-watchdog inactivity
# default: an unacknowledged delivery also happens while the recipient is
# simply mid-turn, and a long tool run or review workflow passes 30 minutes
# routinely. Firing under the watchdog would double-announce what the
# watchdog's own interrupt already handles.
config :kaoiro_server,
  quagmire: [
    rally_turns: 16,
    # Must not exceed :inter_agent tombstone_ttl_ms above — QuagmireWatch
    # refuses to boot otherwise, since closed conversations are the data.
    rally_window_ms: 86_400_000,
    stall_ms: 3_600_000,
    sweep_interval_ms: 60_000
  ]

# Agent status line change log (issue 482): how many entries each agent
# keeps, 1..100. KAOIRO_STATUS_LINE_RETENTION (config/runtime.exs) overrides
# it, and a value an operator stores from the dashboard overrides both.
config :kaoiro_server, :agent_status_lines, retention: 20

# Whether this node runs the detector at all. ON everywhere but `mix test`:
# the sweep above is a wall-clock timer, so under test it fires in whatever
# test happens to be running and broadcasts a conversation an EARLIER test
# left behind into that test's socket (issue #320). Tests that want the
# detector start their own — KaoiroServer.Application.quagmire_watch_children/1.
config :kaoiro_server, start_quagmire_watch: true

# Configure the endpoint
config :kaoiro_server, KaoiroServerWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [json: KaoiroServerWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: KaoiroServer.PubSub,
  live_view: [signing_salt: "P41Ey8RD"]

# Configure Elixir's Logger
config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

# Socket connect / channel join params are logged at :info. Setting this
# replaces Phoenix's own default (["password", "token"]), so both stay. The
# match is a case-sensitive substring of the key, hence lower-case words.
config :phoenix, :filter_parameters, [
  "password",
  "passwd",
  "token",
  "ticket",
  "secret",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "credential"
]

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
