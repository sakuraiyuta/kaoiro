import Config

# Plain-HTTP deployment mode (2026-07-26, VPN-only hosts without a
# TLS-terminating reverse proxy): building the release with
# KAOIRO_PLAIN_HTTP=true drops force_ssl and the Secure cookie flag so
# http://<host>:<port> (and ws://) direct access works. Both settings are
# compile-time, so the SAME variable must also be set when the release
# runs (config/runtime.exs switches the URL scheme; application boot
# raises on a build/runtime mismatch). Never use a plain-HTTP build
# behind a TLS proxy — its session cookie lacks the Secure flag.
plain_http? = System.get_env("KAOIRO_PLAIN_HTTP") == "true"
config :kaoiro_server, :plain_http_build, plain_http?

if not plain_http? do
  # Force using SSL in production. This also sets the "strict-security-transport" header,
  # known as HSTS. If you have a health check endpoint, you may want to exclude it below.
  # Note `:force_ssl` is required to be set at compile-time.
  config :kaoiro_server, KaoiroServerWeb.Endpoint,
    force_ssl: [
      rewrite_on: [:x_forwarded_proto],
      exclude: [
        # paths: ["/health"],
        hosts: ["localhost", "127.0.0.1"]
      ]
    ]
end

# Mark the session cookie Secure in production — TLS is terminated at the
# reverse proxy (force_ssl above rewrites on x-forwarded-proto), so the
# cookie must only ride https (ADR-0013). Dev keeps the default false.
# Plain-HTTP builds must drop it or the browser never sends the cookie.
config :kaoiro_server, :session_secure, not plain_http?

# Do not print debug messages in production
config :logger, level: :info

# Runtime production configuration, including reading
# of environment variables, is done on config/runtime.exs.
