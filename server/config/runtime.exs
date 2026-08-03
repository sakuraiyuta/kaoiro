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
# for `*.zip` packs and rebuilds the manifest on every filesystem
# change. READ-ONLY as of ADR-0046: extraction goes to
# KAOIRO_PERSONA_CACHE_DIR (below), so this may be a `:ro` mount. A
# missing dir warns, serves an empty manifest, and disables the watcher
# — the server never creates it. Unset falls back to
# `priv/persona-packs/` bundled with the app dir so a fresh `mix
# phx.server` still ships the reference 4 packs.
# Env override guard (issue #120): only overwrite compile-time config when
# the corresponding env is actually set, so `config/test.exs` (loaded
# earlier) is not silently clobbered with nil. Same pattern as the three
# `if path = System.get_env(...)` blocks below (commit a0b49ab).
if v = System.get_env("KAOIRO_PERSONA_DIR") do
  config :kaoiro_server, :persona_dir, v
end

# Footer file directory (ADR-0045 F1). Server reads `system-footer.md` /
# `user-footer.md` directly under it and watches them for changes; it
# never writes here and never creates the directory, so a `:ro` mount is
# the intended shape. UNSET DISABLES file-based footers entirely — the
# built-in default (`priv/footers/system-footer.md`, embedded at compile
# time) is used and no user footer is appended. Deliberately separate
# from KAOIRO_PERSONA_DIR — that root's default sits inside the repo, so
# operational footers placed there would land in git and the docker
# build context — and because pack distribution and prompt policy are
# different concerns with different edit cadences.
if v = System.get_env("KAOIRO_FOOTER_DIR") do
  config :kaoiro_server, :footer_dir, v
end

# Persona pack extraction cache root (ADR-0046 F1). Kept OUT of the
# ingest dir so that dir can be mounted `:ro`. Unset falls back to a tmp
# path namespaced by the ingest dir's hash (KaoiroServer.PersonaAssets);
# the cache is regenerated from the zips, so losing it costs one
# re-extraction. Point it at a persistent volume to skip that on every
# container recreation. One cache root per server process — sharing a
# root across processes is not supported (ADR-0046 F5).
if v = System.get_env("KAOIRO_PERSONA_CACHE_DIR") do
  config :kaoiro_server, :persona_cache_dir, v
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

# Dashboard OAuth login (ADR-0042). A provider is offered only when its
# whole set is present, so a half-filled pair silently disables it —
# KaoiroServer.OAuth.warn_config/0 says so at boot. Google additionally
# requires an https redirect URI off localhost, so it cannot be used
# together with KAOIRO_PLAIN_HTTP=true.
if v = System.get_env("KAOIRO_OAUTH_GOOGLE_CLIENT_ID") do
  config :kaoiro_server, :oauth_google_client_id, v
end

if v = System.get_env("KAOIRO_OAUTH_GOOGLE_CLIENT_SECRET") do
  config :kaoiro_server, :oauth_google_client_secret, v
end

if v = System.get_env("KAOIRO_OAUTH_GITHUB_CLIENT_ID") do
  config :kaoiro_server, :oauth_github_client_id, v
end

if v = System.get_env("KAOIRO_OAUTH_GITHUB_CLIENT_SECRET") do
  config :kaoiro_server, :oauth_github_client_secret, v
end

if v = System.get_env("KAOIRO_OAUTH_NEXTCLOUD_CLIENT_ID") do
  config :kaoiro_server, :oauth_nextcloud_client_id, v
end

if v = System.get_env("KAOIRO_OAUTH_NEXTCLOUD_CLIENT_SECRET") do
  config :kaoiro_server, :oauth_nextcloud_client_secret, v
end

if v = System.get_env("KAOIRO_OAUTH_NEXTCLOUD_BASE_URL") do
  config :kaoiro_server, :oauth_nextcloud_base_url, v
end

# Text file mapping OAuth identities to roles (`provider:identifier[:role]`,
# KaoiroServer.OAuthAllowlist). Unset or unreadable rejects every OAuth
# login (fail-closed). Re-read on every lookup, so removing a line takes
# effect at that identity's next connect/refresh without a restart.
if path = System.get_env("KAOIRO_OAUTH_ALLOWLIST_PATH") do
  config :kaoiro_server, :oauth_allowlist_path, path
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

  # A silently-wrong default here breaks URL generation and check_origin
  # without an obvious symptom (issue #139) — fail fast like
  # SECRET_KEY_BASE above instead of falling back to "example.com".
  host =
    System.get_env("PHX_HOST") ||
      raise """
      environment variable PHX_HOST is missing.
      Set it to the public hostname this server is reachable at (used for
      URL generation and WebSocket check_origin).
      """

  config :kaoiro_server, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  # Bind IP override (issue #139). Unset keeps the default below (all
  # interfaces). Accepts any IPv4/IPv6 literal :inet.parse_address/1
  # understands (e.g. "0.0.0.0", "::", "192.168.1.10"). Deliberately
  # scoped to :prod only — config/dev.exs hardcodes both loopback
  # (127.0.0.1) AND a repo-committed, publicly-known secret_key_base, so
  # a KAOIRO_BIND_IP effective in :dev too would let a value in the
  # .env shared with the prod/docker flow (server/README.md) silently
  # expose that known key to the network the "dev is loopback-only"
  # warning above assumes never happens.
  bind_ip =
    case System.get_env("KAOIRO_BIND_IP") do
      nil ->
        # Enable IPv6 and bind on all interfaces.
        # Set it to {0, 0, 0, 0, 0, 0, 0, 1} for local network only access.
        # See https://hexdocs.pm/bandit/Bandit.html#t:options/0 for
        # IPv6 vs IPv4 and loopback vs public addresses.
        {0, 0, 0, 0, 0, 0, 0, 0}

      v ->
        case :inet.parse_address(String.to_charlist(v)) do
          {:ok, ip} -> ip
          {:error, _reason} -> raise "invalid KAOIRO_BIND_IP: #{inspect(v)}"
        end
    end

  # Plain-HTTP deployment (config/prod.exs): generated URLs and
  # check_origin must match the http://<host>:<port> the browser actually
  # uses. Requires an image BUILT with KAOIRO_PLAIN_HTTP=true as well —
  # KaoiroServer.Application.verify_plain_http_config!/0 raises at boot
  # when build and runtime disagree.
  plain_http? = System.get_env("KAOIRO_PLAIN_HTTP") == "true"
  port = String.to_integer(System.get_env("PORT", "4000"))

  url_config =
    if plain_http? do
      [host: host, port: port, scheme: "http"]
    else
      [host: host, port: 443, scheme: "https"]
    end

  # WebSocket origin allow-list. Phoenix's default (`true`) compares the
  # HOST ONLY — scheme and port are ignored — so any other service on the
  # same host (a different port, an XSS'd dev server) passes the check and
  # can open an operator socket riding the victim's session cookie, which
  # SameSite cannot stop because it is site- (not port-) scoped. Pinning
  # scheme+host+port closes that. Requests WITHOUT an Origin header (the
  # runner/wrapper ws clients) skip the check entirely and are unaffected.
  # Loopback is allowed in BOTH branches: config/prod.exs keeps
  # localhost/127.0.0.1 out of force_ssl, so a local release
  # (scripts/dogfood.sh) is reached over http and cannot match
  # `https://host`; and on the server host itself `http://localhost:PORT`
  # must not serve the page but 403 the socket.
  loopback_origins = ["http://localhost:#{port}", "http://127.0.0.1:#{port}"]

  check_origin =
    if plain_http? do
      ["http://#{host}:#{port}" | loopback_origins]
    else
      ["https://#{host}" | loopback_origins]
    end

  config :kaoiro_server, KaoiroServerWeb.Endpoint,
    url: url_config,
    check_origin: check_origin,
    http: [ip: bind_ip],
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
