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

# Optional sprite overlay directory (ADR-0008 stage 1); per sprite set
# it takes precedence over the bundled pack in priv/personas.
config :kaoiro_server, :persona_dir, System.get_env("KAOIRO_PERSONA_DIR")

# Socket auth (ADR-0011). Unset lists disable enforcement (dev mode —
# clients then act as operator); always set both in production.
# Formats: wrapper "agent_id:token,...", client "token:role,...".
config :kaoiro_server, :wrapper_tokens, System.get_env("KAOIRO_WRAPPER_TOKENS")
config :kaoiro_server, :client_tokens, System.get_env("KAOIRO_CLIENT_TOKENS")

# DETS file for the restart-surviving session_id pointers (ADR-0014 F1,
# issue #49). Point this at a persistent volume in production; the unset
# default (a tmp path, resolved in KaoiroServer.SessionPointers) survives
# a process restart but not a fresh container. The file is created
# owner-only (chmod 600) since records carry cwd (sensitive, #46). A lost
# pointer only drops the default resume target — the runner re-enumerates
# (ADR-0014 F2).
config :kaoiro_server,
       :session_pointers_path,
       System.get_env("KAOIRO_SESSION_POINTERS_PATH")

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
