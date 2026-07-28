defmodule KaoiroServerWeb.SecurityHeaders do
  @moduledoc """
  Browser hardening headers on every response (issue #155).

  The VPN-only direct deployment (no nginx, plain HTTP — see
  `docs/specs/deployment.md` 1.5) has no reverse proxy left to add
  them, so the endpoint must. This plug therefore sits BEFORE
  `Plug.Static` / `DashboardStatic` in the endpoint: `index.html` and
  the built assets are served there and never reach the router, so
  `put_secure_browser_headers` in the `:browser` pipeline would leave
  the SPA itself — the one page that renders untrusted agent output —
  uncovered.
  """

  @behaviour Plug

  import Plug.Conn

  # X-Frame-Options duplicates `frame-ancestors 'none'` below for
  # browsers that predate CSP Level 2: without it a framing page can
  # steer operator clicks, and instruct/approve are one click away
  # (docs/specs/threat-model.md).
  @fixed_headers [
    {"x-content-type-options", "nosniff"},
    {"x-frame-options", "DENY"},
    {"referrer-policy", "strict-origin-when-cross-origin"}
  ]

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    conn
    |> merge_resp_headers(@fixed_headers)
    |> put_resp_header("content-security-policy", policy(conn))
  end

  @doc """
  CSP `connect-src` sources for a `:check_origin` value, the origin THIS
  response is being served from, and the endpoint's own URL.

  `'self'` alone is not enough: it does not resolve to the `ws:`/`wss:`
  variant of the page origin in every browser, so the socket origin is
  listed explicitly. But `:check_origin` and `connect-src` sit on
  opposite trust axes (ふじ advisory on issue #155): the former lists
  every origin a browser may open a socket FROM, the latter every
  destination THIS page may connect TO. Copying the whole list would put
  `ws://localhost:4000` into a page served to an external host.

  So the list is narrowed to the entry matching the request's own
  origin, and the WS destination is derived from that. The matched
  CONFIG string is what reaches the header — the request's Host is used
  for comparison only, so a hostile Host header cannot inject into the
  policy. No match (an origin `:check_origin` would 403 anyway) leaves
  `'self'` alone; a non-list `:check_origin` (dev/test) falls back to
  the endpoint's own URL. Entries that are not http(s) URLs (wildcards,
  `:conn`) carry no usable origin and are dropped.
  """
  def connect_src(check_origin, request_origin, endpoint_url) do
    origins =
      case check_origin do
        list when is_list(list) -> Enum.filter(list, &same_origin?(&1, request_origin))
        _ -> [endpoint_url]
      end

    ["'self'" | Enum.flat_map(origins, &ws_origin/1)]
  end

  defp same_origin?(configured, request_origin) when is_binary(configured),
    do: normalize(configured) == request_origin

  defp same_origin?(_configured, _request_origin), do: false

  # Default ports are dropped so "https://host" and "https://host:443"
  # (the shape `conn` yields) compare equal.
  defp normalize(origin) do
    case URI.parse(origin) do
      %URI{scheme: scheme, host: host, port: port} when is_binary(scheme) and is_binary(host) ->
        origin_string(scheme, host, port)

      _ ->
        origin
    end
  end

  defp origin_string("http", host, port) when port in [nil, 80], do: "http://#{host}"
  defp origin_string("https", host, port) when port in [nil, 443], do: "https://#{host}"
  defp origin_string(scheme, host, port), do: "#{scheme}://#{host}:#{port}"

  # The dashboard loads scripts, styles, images and fonts from its own
  # origin only. Inline <style> is the one exception: mermaid emits one
  # inside every rendered SVG (dashboard/src/lib/markdown.ts) and
  # dropping 'unsafe-inline' leaves diagrams unstyled. Scripts stay
  # strict — the built index.html carries no inline <script> — so the
  # untrusted agent output rendered through {@html} has no script
  # vector left even if the DOMPurify chokepoint were bypassed.
  defp policy(conn) do
    connect =
      connect_src(
        KaoiroServerWeb.Endpoint.config(:check_origin),
        request_origin(conn, KaoiroServerWeb.Endpoint.config(:url)),
        KaoiroServerWeb.Endpoint.url()
      )

    Enum.join(
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self'",
        "font-src 'self'",
        "connect-src " <> Enum.join(connect, " "),
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'"
      ],
      "; "
    )
  end

  @doc """
  The origin the browser used for this request, normalized for
  comparison against the configured entries.

  Behind a TLS reverse proxy the connection is NOT the outside view of
  itself: `config/prod.exs` rewrites only `:x_forwarded_proto`, so the
  scheme becomes `https` while the port stays at the internal listen
  port — a proxied request looks like `https://host:4000` and never
  matches the `https://host` in `:check_origin` (ふじ 2nd review
  must-fix on issue #155; left unfixed, `connect-src` collapses to
  `'self'` and the socket is CSP-blocked in the browsers that do not
  resolve `'self'` to `wss:`).

  So when the request's scheme and host match the endpoint's advertised
  `:url` — the deployment's own trusted statement of how it is reached
  from outside — the port is taken from there instead of from the
  connection. Everything else (loopback, a forged Host) keeps the
  connection's own values. This only decides WHICH configured entry is
  selected; the header still carries the config string, never a request
  value.
  """
  def request_origin(conn, url_config) do
    url = url_config || []
    scheme = to_string(conn.scheme)

    if scheme == url[:scheme] and conn.host == url[:host] do
      origin_string(scheme, conn.host, url[:port])
    else
      origin_string(scheme, conn.host, conn.port)
    end
  end

  defp ws_origin("https://" <> rest), do: ["wss://" <> rest]
  defp ws_origin("http://" <> rest), do: ["ws://" <> rest]
  defp ws_origin(_other), do: []
end
