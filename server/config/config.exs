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
  # fail-closed on an unset token list in :prod only (issue #138).
  env: config_env(),
  # Static serving of the bundled dashboard (ADR-0007). Channels and the
  # public API stay on regardless.
  serve_dashboard: true,
  # Hard limits per inter-agent conversation (protocol-inter-agent spec,
  # phase-8 Stage B). The server enforces these mechanically — quota
  # overshoot automatically terminates the conversation with a synthetic
  # escalate-to-user broadcast.
  inter_agent: [
    max_turns: 20,
    max_tokens: 100_000,
    max_wallclock_ms: 600_000,
    max_concurrent_agents: 2
  ]

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

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
