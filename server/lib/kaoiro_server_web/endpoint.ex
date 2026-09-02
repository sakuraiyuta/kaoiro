defmodule KaoiroServerWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :kaoiro_server

  alias KaoiroServer.TransportLimits

  # The session cookie carries the dashboard's user token (ADR-0013).
  # encryption_salt (not just signing) keeps that token confidential even
  # to whoever can read the cookie jar; max_age is the sliding-window
  # lifetime refreshed by /session/refresh while a tab is open; secure is
  # on only in prod (TLS terminated at the reverse proxy, which must send
  # X-Forwarded-Proto: https), off in dev over http://localhost.
  @session_options [
    store: :cookie,
    key: "_kaoiro_server_key",
    signing_salt: "zbODM6kB",
    encryption_salt: "Hb3kPq9R",
    same_site: "Lax",
    max_age: 60 * 60 * 24 * 3,
    secure: Application.compile_env(:kaoiro_server, :session_secure, false)
  ]

  # Wrapper ingest and client fan-out ride separate sockets so their
  # auth paths can diverge in Phase 3 (wrapper token vs user stub). The
  # client socket reads the session cookie at the WS handshake so a
  # reloaded tab re-authenticates from the cookie (ADR-0013).
  # max_frame_size caps the per-frame DoS surface for the file-upload wire
  # (file-upload spec / ADR-0025): the default `:infinity` would let a 128
  # MB chunk land in one receive buffer. 8 MB matches the protocol's
  # transport safety valve so a misbehaving relay/operator cannot wedge a
  # wrapper/runner receive process with one oversize binary frame.
  socket "/wrapper", KaoiroServerWeb.WrapperSocket,
    websocket: [max_frame_size: TransportLimits.max_frame_bytes()],
    longpoll: false

  # Resident-runner control channel (ADR-0023): separate system from the
  # wrapper data path and the client fan-out, with its own host-token auth.
  # max_frame_size matches the two sockets above: `RunnerSocket.connect/3`
  # accepts unconditionally (auth happens at channel join), so without a cap
  # an unauthenticated peer could park a multi-GB frame in the receive
  # buffer and OOM the node.
  socket "/runner", KaoiroServerWeb.RunnerSocket,
    websocket: [max_frame_size: TransportLimits.max_frame_bytes()],
    longpoll: false

  socket "/client", KaoiroServerWeb.ClientSocket,
    websocket: [
      connect_info: [session: @session_options],
      max_frame_size: TransportLimits.max_frame_bytes()
    ],
    longpoll: false

  # CSP and the other browser hardening headers (issue #155). Must stay
  # ABOVE the two static plugs: they serve index.html and the built
  # assets without ever reaching the router, so the :browser pipeline is
  # too late to cover the SPA itself.
  plug KaoiroServerWeb.SecurityHeaders

  # Serve at "/" the static files from "priv/static" directory.
  #
  # favicon/robots are always served; the dashboard files (index.html +
  # built assets) go through DashboardStatic so :serve_dashboard can turn
  # them off (ADR-0007).
  plug Plug.Static,
    at: "/",
    from: :kaoiro_server,
    gzip: not code_reloading?,
    only: ~w(favicon.ico robots.txt)

  plug KaoiroServerWeb.DashboardStatic,
    at: "/",
    from: :kaoiro_server,
    gzip: not code_reloading?,
    only: ~w(index.html assets)

  # Code reloading can be explicitly enabled under the
  # :code_reloader configuration of your endpoint.
  if code_reloading? do
    plug Phoenix.CodeReloader
  end

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug Plug.MethodOverride
  plug Plug.Head
  plug Plug.Session, @session_options
  plug KaoiroServerWeb.Router
end
