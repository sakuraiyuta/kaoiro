import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/kaoiro_server start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :kaoiro_server, KaoiroServerWeb.Endpoint, server: true
end

config :kaoiro_server, KaoiroServerWeb.Endpoint,
  http: [port: String.to_integer(System.get_env("PORT", "4000"))]

# Persona pack ingest directory (ADR-0029, phase-10). Server scans it
# for `*.zip` packs, extracts into a `.cache/` subdir, and rebuilds the
# manifest on every filesystem change. Unset falls back to
# `priv/persona-packs/` bundled with the app dir so a fresh `mix
# phx.server` still ships the reference 4 packs.
# Env override guard (issue #120): only overwrite compile-time config when
# the corresponding env is actually set, so `config/test.exs` (loaded
# earlier) is not silently clobbered with nil. Same pattern as the three
# `if path = System.get_env(...)` blocks below (commit a0b49ab).
if v = System.get_env("KAOIRO_PERSONA_DIR") do
  config :kaoiro_server, :persona_dir, v
end

# Socket auth (ADR-0011). Unset lists disable enforcement (dev mode —
# clients then act as operator); always set all in production. Formats:
# wrapper "agent_id:token,...", runner "host_id:token,..." (ADR-0023),
# client "token:role,...".
if v = System.get_env("KAOIRO_WRAPPER_TOKENS") do
  config :kaoiro_server, :wrapper_tokens, v
end

if v = System.get_env("KAOIRO_RUNNER_TOKENS") do
  config :kaoiro_server, :runner_tokens, v
end

if v = System.get_env("KAOIRO_CLIENT_TOKENS") do
  config :kaoiro_server, :client_tokens, v
end

# DETS file for the restart-surviving session_id pointers (ADR-0014 F1,
# issue #49). Point this at a persistent volume in production; the unset
# default (a tmp path, resolved in KaoiroServer.SessionPointers) survives
# a process restart but not a fresh container. The file is created
# owner-only (chmod 600) since records carry cwd (sensitive, #46). A lost
# pointer only drops the default resume target — the runner re-enumerates
# (ADR-0014 F2).
if path = System.get_env("KAOIRO_SESSION_POINTERS_PATH") do
  config :kaoiro_server, :session_pointers_path, path
end

# DETS file for the restart-surviving agent identity ledger (ADR-0030).
# Point this at a persistent volume in production; the unset default
# (a tmp path, resolved in KaoiroServer.AgentDirectory) survives a
# process restart but not a fresh container. The file is created
# owner-only (chmod 600); a lost entry only drops the ability to restore
# that agent until it is spawned fresh.
if path = System.get_env("KAOIRO_AGENT_DIRECTORY_PATH") do
  config :kaoiro_server, :agent_directory_path, path
end

# DETS file for the per-agent permission-mode ledger. Same rationale as
# the two paths above: unset falls back to a tmp path
# (KaoiroServer.PermissionModes) which is destroyed together with the
# container on `docker compose down`. Point at a persistent volume so the
# per-agent mode survives a dogfood restart.
if path = System.get_env("KAOIRO_PERMISSION_MODES_PATH") do
  config :kaoiro_server, :permission_modes_path, path
end

# DETS source of truth for structured inter-agent envelopes (#105). SDK
# JSONL can reconstruct ordinary logs but not these messages, so production
# must point this at the same restart-surviving volume as the other ledgers.
if path = System.get_env("KAOIRO_INTER_AGENT_HISTORY_PATH") do
  config :kaoiro_server, :inter_agent_history_path, path
end

# #109 visibility data must survive a full container recreation together
# with durable IA history. Both stores are fsync-gated before clear ack.
if path = System.get_env("KAOIRO_CLEAR_WATERMARKS_PATH") do
  config :kaoiro_server, :clear_watermarks_path, path
end

if path = System.get_env("KAOIRO_SESSION_STARTS_PATH") do
  config :kaoiro_server, :session_starts_path, path
end

if path = System.get_env("KAOIRO_INGRESS_ORDER_PATH") do
  config :kaoiro_server, :ingress_order_path, path
end

# Token denylist DETS store (ふじ #120 must-fix 1, 2026-07-25). This is
# the authoritative store of revoked agent_ids for fail-closed auth: a lost
# entry silently re-grants a revoked identity. Point at a persistent volume
# in production; unset falls back to KaoiroServer.TokenDenylist.default_path/0
# (a shared `$TMPDIR/kaoiro_token_denylist.dets`) which does NOT survive a
# container recreation.
if path = System.get_env("KAOIRO_TOKEN_DENYLIST_PATH") do
  config :kaoiro_server, :token_denylist_path, path
end

if config_env() == :prod do
  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  host = System.get_env("PHX_HOST") || "example.com"

  config :kaoiro_server, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  config :kaoiro_server, KaoiroServerWeb.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    http: [
      # Enable IPv6 and bind on all interfaces.
      # Set it to  {0, 0, 0, 0, 0, 0, 0, 1} for local network only access.
      # See the documentation on https://hexdocs.pm/bandit/Bandit.html#t:options/0
      # for details about using IPv6 vs IPv4 and loopback vs public addresses.
      ip: {0, 0, 0, 0, 0, 0, 0, 0}
    ],
    secret_key_base: secret_key_base

  # ## SSL Support
  #
  # To get SSL working, you will need to add the `https` key
  # to your endpoint configuration:
  #
  #     config :kaoiro_server, KaoiroServerWeb.Endpoint,
  #       https: [
  #         ...,
  #         port: 443,
  #         cipher_suite: :strong,
  #         keyfile: System.get_env("SOME_APP_SSL_KEY_PATH"),
  #         certfile: System.get_env("SOME_APP_SSL_CERT_PATH")
  #       ]
  #
  # The `cipher_suite` is set to `:strong` to support only the
  # latest and more secure SSL ciphers. This means old browsers
  # and clients may not be supported. You can set it to
  # `:compatible` for wider support.
  #
  # `:keyfile` and `:certfile` expect an absolute path to the key
  # and cert in disk or a relative path inside priv, for example
  # "priv/ssl/server.key". For all supported SSL configuration
  # options, see https://hexdocs.pm/plug/Plug.SSL.html#configure/1
  #
  # We also recommend setting `force_ssl` in your config/prod.exs,
  # ensuring no data is ever sent via http, always redirecting to https:
  #
  #     config :kaoiro_server, KaoiroServerWeb.Endpoint,
  #       force_ssl: [hsts: true]
  #
  # Check `Plug.SSL` for all available options in `force_ssl`.
end
