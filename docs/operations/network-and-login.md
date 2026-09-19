---
title: Network and login runbook
description: nginx reverse proxy, the direct-VPN deployment alternative, and configuring OAuth login.
status: accepted
last_updated: 2026-09-19
related: [deployment]
---

# Network and login runbook

The normative reference for why each step is shaped this way is
[Multi-host deployment architecture](../architecture/deployment.md). Auth
mechanism and boundary norms are in
[Authentication and authorization](../reference/security/authentication-authorization.md)
and are linked here, not repeated.

### 1.4 nginx reverse proxy

Terminate TLS at nginx and forward the WebSocket Upgrade/Connection headers.
Set `proxy_read_timeout` longer than the channel heartbeat (30 seconds).

```nginx
server {
    listen 443 ssl;
    server_name kaoiro.example.com;

    ssl_certificate     /etc/letsencrypt/live/kaoiro.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kaoiro.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 75s;
    }
}
```

**Read this constraint:** prod enables `force_ssl` (`server/config/prod.exs`) and
redirects requests whose `X-Forwarded-Proto` is not `https` to `https` with 301.
That fails a WebSocket handshake. Always set
`proxy_set_header X-Forwarded-Proto $scheme;`; **direct `ws://<host>:4000`
connections that bypass nginx are not supported** (only `localhost`/`127.0.0.1`
`PHX_HOST` values are exempt from `force_ssl`). Wrappers and runners must use
`wss://` through nginx. The VPN direct deployment (1.5) disables `force_ssl` at
build time, so this constraint does not apply.

### 1.5 Direct VPN deployment (no nginx, plain HTTP, 2026-07-26)

For hosts reachable only inside a VPN (WireGuard), you may deploy without nginx
and connect directly to `http://<host>:<port>`. Tokens and cookies travel in
plaintext inside the VPN, so **the VPN is responsible for path confidentiality**
([threat-model](../architecture/security-threat-model.md)). Never expose this mode to the public Internet.

Add these two variables to `.env` (all other steps are the same as 1.1–1.3):

| env | Value | Meaning |
|---|---|---|
| `KAOIRO_PLAIN_HTTP` | `true` | Build time: disable `force_ssl` and Secure cookies (compile-time). Runtime: switch URL generation and `check_origin` to `http://PHX_HOST:PORT`. Compose wires the same value to both build arg and runtime env; mismatch raises at server startup |
| `KAOIRO_PUBLISH_IP` | Host's VPN-side interface IP | Compose bind address (default `127.0.0.1`); restrict to the VPN interface rather than publishing on all interfaces |

#### Boot order for a VPN publish address

If `KAOIRO_PUBLISH_IP` is an address that appears late during boot, such as a
VPN address, `docker.service` **MUST** start after the unit that creates that
address. This is unnecessary for the default `127.0.0.1` publish address behind
nginx. The only shipped asset for this ordering is the
[`docker-vpn-order.conf.example`](../../server/deploy/systemd/docker-vpn-order.conf.example)
template; replace `@@VPN_UNIT@@` with the actual VPN systemd unit, rather than
assuming a WireGuard interface name.

From the checkout root, expand the template, reload systemd, and verify the
result. This example uses `wg-quick@wg0.service`; substitute the unit that owns
the configured publish address.

```sh
VPN_UNIT=wg-quick@wg0.service
sudo install -d -m 0755 /etc/systemd/system/docker.service.d
sed "s|@@VPN_UNIT@@|${VPN_UNIT}|g" server/deploy/systemd/docker-vpn-order.conf.example \
  | sudo tee /etc/systemd/system/docker.service.d/kaoiro-vpn.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl show docker -p After -p Wants -p NeedDaemonReload
```

Do not restart Docker as part of this procedure: it affects every container
under the same daemon. The ordering applies on the next Docker start or boot.
`Wants=` and `After=` order the startup attempt; they do not guarantee that the
VPN unit succeeds or that its address is ready. If the VPN unit fails, Docker
may still start and the bind may still fail.

As a host-wide alternative, an operator may opt into IPv4
`net.ipv4.ip_nonlocal_bind=1`. It permits binding an address before the
interface owns it, but also lets an incorrect publish address bind successfully
and therefore makes configuration errors harder to notice. It is an explicit
operator choice, not a shipped sysctl asset or default.

`check_origin` allows only `http://PHX_HOST:PORT` and loopback (private Gitea
issue 154 M1: comparing only the default host would let another port on the same
host steal an operator socket). **Opening the dashboard with another name or a
literal IP renders the page but the client socket receives 403**, so always use
the same name as `PHX_HOST`.

`PHX_HOST` is the FQDN used for connections (for example,
`linux-host.example`). Rebuild with `docker compose up -d --build` after changing
it (compile-time flag; images cannot be reused). The runner `server_url` is
`ws://<PHX_HOST>:<PORT>/runner`; the dashboard is
`http://<PHX_HOST>:<PORT>/?token=...`.

Because nginx is absent in this mode, the server itself adds the security headers
nginx normally supplies (CSP / `nosniff` / `X-Frame-Options` /
`Referrer-Policy`) to every response (#145,
`KaoiroServerWeb.SecurityHeaders`; intent and details are in the
[threat-model](../architecture/security-threat-model.md) mitigations). CSP `connect-src` copies to `ws:` /
`wss:` **only the `check_origin` entry matching the origin serving that response**;
changing `PHX_HOST` / `PORT` follows automatically and never puts a loopback WS
target on an external-host page. Conversely, **CSP rejects changes that bring
scripts, styles, or images from external origins into the dashboard**.

### 1.6 Configure OAuth login (optional, ADR-0042 / issue #65)

The dashboard can add Google / GitHub / Nextcloud OAuth login. See
[ADR-0042](../adr/0042-oauth-allowlist-login.md) for mechanism and design
decisions and [auth-and-authz](../architecture/security-boundaries.md) for the boundary map. If
`KAOIRO_CLIENT_TOKENS` is unset, token auth is disabled (OAuth only); when set,
the two paths coexist.

**Redirect URI** (common to all providers; the server derives it from the
endpoint `url`, so register exactly this form):

```text
{scheme}://{PHX_HOST}[:{PORT}]/auth/{provider}/callback
# 例: https://kaoiro.example.com/auth/github/callback
#     http://localhost:4000/auth/google/callback   (dev)
```

**Register a client for each provider** (paths current as of 2026-07):

| provider | Registration path | Notes |
|---|---|---|
| Google | [console.cloud.google.com](https://console.cloud.google.com) → Google Auth Platform (first use: Get started to configure Branding/Audience; for Testing add the account under Test users) → Clients → Create Client → Web application → Authorized redirect URIs | **Redirect URI must use https (http only for localhost)**; unavailable in plain-HTTP deployment (1.5) |
| GitHub | Settings → Developer settings → OAuth Apps → New OAuth App → Authorization callback URL; after registration, Generate a new client secret | **One callback URL per App**; create a separate App per environment |
| Nextcloud | Target instance Settings → Administration → Security → OAuth 2.0 clients → add a name + Redirection URI | No scope support (tokens have full access), but the server discards the token after obtaining identity (ADR-0042). No PKCE; CSRF protection is state only |

**Generate settings automatically with `mix kaoiro.env`** (2026-07-27,
[setup-wizards](../specs/setup-wizards.md)). The wizard's OAuth questions cover provider
selection → ID/secret entry → allowlist generation (prompting for at least one
entry) → a compose-mount line, and write generated files with mode 0600. The
following describes manual configuration (and what the wizard writes).

**Append to `.env`** (a provider is enabled only when both ID and secret exist;
Nextcloud also requires `base_url`):

```sh
KAOIRO_OAUTH_GOOGLE_CLIENT_ID=...
KAOIRO_OAUTH_GOOGLE_CLIENT_SECRET=...
KAOIRO_OAUTH_GITHUB_CLIENT_ID=...
KAOIRO_OAUTH_GITHUB_CLIENT_SECRET=...
KAOIRO_OAUTH_NEXTCLOUD_CLIENT_ID=...
KAOIRO_OAUTH_NEXTCLOUD_CLIENT_SECRET=...
KAOIRO_OAUTH_NEXTCLOUD_BASE_URL=https://cloud.example.com
KAOIRO_OAUTH_ALLOWLIST_PATH=/etc/kaoiro/oauth-allowlist.txt
```

**Allowlist** (unset, missing, or mismatched values all reject authentication =
fail-closed; malformed lines warn and skip):

```text
# provider:identifier[:role]   omitted role means viewer
# identifier: google=lowercase email / github=login / nextcloud=user id
google:alice@example.com:operator
github:octocat:viewer
nextcloud:alice:operator
```

For compose, put the file in `server/`. The bundled `docker-compose.yaml`
already mounts it read-only (`server/docker-compose.yaml:112`); no compose
edit is needed, only creating the plain file at that path.

**Verify**:

```sh
curl http://<PHX_HOST>:<PORT>/session/auth-methods
# → {"token":true|false,"oauth":["github","nextcloud",...]}
```

The login screen lists buttons for enabled providers; accounts outside the
allowlist are rejected with `auth_error=not_allowed`. Removing a line applies
immediately on an active socket too: issue #158 closed the earlier gap by
re-resolving the role from the credential on every HTTP request
(`RequireOperatorPlug`) and every operator WS action
(`AgentsChannel.require_operator_role/1`), rather than caching it at connect
time. Rejection WARN logs include `provider:uid`, so the identifier to copy
into the allowlist can be read from the log.

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [Server install runbook](server-install.md).
- [Server configuration](../reference/configuration/server.md).
- [Production deployment manual](production.md).
