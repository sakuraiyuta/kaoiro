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
    |> put_resp_header("content-security-policy", policy())
  end

  @doc """
  CSP `connect-src` sources for a `:check_origin` value and the
  endpoint's own URL.

  `'self'` alone is not enough: it does not resolve to the `ws:`/`wss:`
  variant of the page origin in every browser, so the socket origins
  are listed explicitly. They are the `:check_origin` list
  `config/runtime.exs` derives from `plain_http?` / host / port — by
  definition the origins a browser is allowed to open a socket from —
  with the scheme swapped. Anything else (dev/test leave it `false`)
  falls back to the endpoint's own URL. Entries that are not http(s)
  URLs (wildcards, `:conn`) carry no usable origin and are dropped.
  """
  def connect_src(check_origin, endpoint_url) do
    origins = if is_list(check_origin), do: check_origin, else: [endpoint_url]

    ["'self'" | Enum.flat_map(origins, &ws_origin/1)]
  end

  # The dashboard loads scripts, styles, images and fonts from its own
  # origin only. Inline <style> is the one exception: mermaid emits one
  # inside every rendered SVG (dashboard/src/lib/markdown.ts) and
  # dropping 'unsafe-inline' leaves diagrams unstyled. Scripts stay
  # strict — the built index.html carries no inline <script> — so the
  # untrusted agent output rendered through {@html} has no script
  # vector left even if the DOMPurify chokepoint were bypassed.
  defp policy do
    connect =
      connect_src(
        KaoiroServerWeb.Endpoint.config(:check_origin),
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

  defp ws_origin("https://" <> rest), do: ["wss://" <> rest]
  defp ws_origin("http://" <> rest), do: ["ws://" <> rest]
  defp ws_origin(_other), do: []
end
