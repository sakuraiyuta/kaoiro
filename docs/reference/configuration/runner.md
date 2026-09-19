---
title: "Runner configuration"
status: implemented
last_updated: 2026-09-19
---

# Runner configuration

## Coverage

This page covers the connection fields in `runner.config.json` (`host_id` /
`server_url` / `cwd_allowlist` / `capabilities` / tokens, below) and the Codex
backend selector. Codex-specific and Antigravity-specific `runner.config.json`
fields remain documented in [runner/README.md](../../../runner/README.md)'s
own "Codex 設定" and "Antigravity configuration" sections. Operator steps are
in the [backend switching runbook](../../operations/codex-backend-switch.md).
The per-spawn config fields the runner relays to the wrapper process itself
are in [Wrapper configuration](wrapper.md).

## `runner.config.json` example (`wss://` required)

For prod deployments through nginx, `server_url` must be `wss://` (`ws://`
direct connections receive 301 under the [1.4](../../operations/network-and-login.md#14-nginx-reverse-proxy) constraint). Only the direct VPN
deployment ([1.5](../../operations/network-and-login.md#15-direct-vpn-deployment-no-nginx-plain-http-2026-07-26)) uses `ws://<PHX_HOST>:<PORT>/runner`. Make `host_id` unique per
host: the server's `HostRegistry` registers by host ID, so duplicates overwrite
one host with the other.

```json
{
  "host_id": "lab-pc-1",
  "server_url": "wss://kaoiro.example.com/runner",
  "cwd_allowlist": ["/home/agent/repos"],
  "capabilities": ["claude-code", "codex", "antigravity"]
}
```

Set `KAOIRO_RUNNER_TOKEN=<token issued in 1.1>` in `runner.env` (pair it with
`<host_id>:<token>` in server-side `KAOIRO_RUNNER_TOKENS`) and run `chmod 600`.
Override `server_url` with `KAOIRO_RUNNER_SERVER_URL` in `runner.env` as well
(issue #135; env takes precedence over the config file).

For local launchers, `runner/runner.env` is a separate gitignored file that
contains only `KAOIRO_RUNNER_TOKEN=<64 lowercase hex>`. `scripts/dev.sh` and
`scripts/dogfood.sh` create it with mode 0600 when absent and append its pair
to the server list for the configured host; a preset environment token wins
after validation.

## Codex backend

The public Codex engine defaults to `codex exec`. Set `codex.backend` to
`"app-server"` in `runner.config.json` to select the persistent app-server child
for subsequent Codex wrapper lifetimes on that host. `"exec"` or omission keeps
the default. The runner relays only its local selection as `codex_backend` in
the wrapper startup config; direct wrapper launches may use that same field.
Unknown values are rejected. No environment variable, command-line backend flag,
dashboard selector, spawn payload or resume snapshot selects a backend.

Configuration reload does not switch running children. After the runner's
`codex backend=... for subsequent wrappers` diagnostic, new launches and resumes
use the new selection. The wrapper also logs its selected backend at startup.
There is no automatic fallback to exec. See the
[rollback runbook](../../operations/codex-backend-switch.md#codex-backend-selection-and-rollback)
and [ADR-0058](../../adr/0058-codex-app-server-turn-steer.md).
Steering remains disabled and approval remains `never`.
