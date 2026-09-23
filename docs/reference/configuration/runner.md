---
title: "Runner configuration"
status: implemented
last_updated: 2026-09-19
---

# Runner configuration

## Coverage

This page covers the connection fields in `runner.config.json` (`host_id` /
`server_url` / `cwd_allowlist` / `capabilities` / tokens, below), the Codex
and Antigravity engine-specific blocks, and the Codex backend selector.
Operator steps are in the
[backend switching runbook](../../operations/codex-backend-switch.md). The
per-spawn config fields the runner relays to the wrapper process itself
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

The target `server_url` can be overridden by the environment variable
`KAOIRO_RUNNER_SERVER_URL` (**env takes precedence over the config file**, issue
#135). Use this when switching the connection destination without editing
`runner.config.json` in distributed binary or service operations (systemd/launchd
units, `env_file`, etc.). It must begin with `ws://` or `wss://`, and an invalid
format fails fast at startup / config reload. Because hot reload
(`watchRunnerConfig`) maintains the same precedence, rewriting `server_url` in
`runner.config.json` while the env var is set does not change the actual
destination (hot reload from changes to other fields like `host_id` continues to
work as usual).

## Other `runner.config.json` and env fields

`context_work_budget_percent` is the soft working budget percentage relative to
Claude's context window, defaulting to `60`. Because the wrapper derives the
token denominator from `maxTokens` returned by the SDK for each model, the
working budget is 600k for a 1M window and 120k for a 200k window. It accepts
only finite numbers satisfying `0 < value <= 100`, and changes take effect
starting from the next spawn after hot reload. The raw window utilization and
this working budget ratio are reported together with their denominators in the
dashboard and wrapper context notifications (issue #254).

The runner's Phoenix wire log omits periodic heartbeat pushes and corresponding
replies by default. Other transport / reconnect / error / control messages
continue to be emitted as before. Set `KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS=1`
in `runner.env` only when full logging is required for connection-level
investigation. Any value other than `1` or an unset variable keeps heartbeats
omitted. Because this value is read from `process.env` at runner startup, restart
the runner service after changing it. For temporary dogfood investigation,
launching with `KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS=1 scripts/dogfood.sh` also
emits the full log to `tmp/dogfood-logs/runner.log`.

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

### Codex backend selection

`runner.config.json` accepts `"codex": { "backend": "app-server" }` alongside
existing auth/catalog options. Omission or `"exec"` selects exec. The setting
is host-wide and applies only to new Codex wrapper lifetimes, including resume,
reset, and automatic restart. Existing children are not switched by a reload.
Invalid values reject startup (or skip a bad reload without replacing the last
valid config). Wait for `runner: codex backend=... for subsequent wrappers`
after editing; the earlier `config reload` line is not an application receipt.
There is no backend environment variable, flag or dashboard launch selector.

For rollback, stop the target agent, set `backend` to `"exec"`, wait for the
applied-config diagnostic, then resume its recorded session on the same host
and cwd. See [backend switching runbook](../../operations/codex-backend-switch.md#codex-backend-selection-and-rollback).
Use a runner release that bundles this selector and both backends; older
wrapper releases may ignore the new field. No automatic exec fallback is used.

## Codex configuration

`runner.config.json`'s `codex` block passes Codex-engine-specific settings.

- `auth_mode` (`"chatgpt"` / `"apikey"`) — explicit declaration of the auth mode
  used for Codex adapter catalog resolution (phase-24). Precedence is
  **explicit declaration > codex CLI `doctor` detection > `"unknown"`**;
  declaring a mode skips detection so the catalog is not empty even without a
  codex binary in the runner's `PATH`. This is only declarative metadata for
  catalog selection; the runner neither attaches nor modifies credentials. It
  does not implicitly infer from `chatgpt_plan` (to avoid misclassifying a config
  that specifies a plan despite using API-key auth). A misdeclaration drifts the
  catalog from actual entitlements, causing explicit requests for unsupported
  models / efforts to fail loudly on the SDK side and fall back to the existing
  `switch_error` rollback.
- `chatgpt_plan` — operator-declared ChatGPT plan (used for catalog resolution;
  ignored under API-key auth).
- `extra_models` (`EngineModelInfo[]`, issue #292) — lets the operator
  declare a model kaoiro's curated catalog
  (`wrapper/codex/src/catalog.ts`, ADR-0035 H3) has not caught up with yet,
  without waiting for a kaoiro release. Only `value` is required; every
  field accepts only `EngineModelInfo`'s INPUT subset — `resolved_model`
  is upstream-derived metadata and is never read from config.
  `display_name` defaults to `value`; omitting `effort_levels` means no
  effort UI is offered (ADR-0035's "never infer an effort level" rule). A
  matching `value` overrides the curated catalog's entry; a new `value` is
  appended (`mergeExtraModels`). The same merge applies both to the
  runner's register (LaunchDialog) and to the wrapper's own catalog
  resolution (`ext.models` / effort-switch / `setModel`). This does not
  bypass entitlement — declaring a model the account cannot actually use
  still hits the SDK's usual 400/404, surfaced as the existing
  `switch_error` rollback (or a launch failure for a fresh spawn).
  ```json
  "extra_models": [
    { "value": "gpt-6-astra", "display_name": "GPT-6-Astra",
      "effort_levels": ["low", "medium", "high", "xhigh", "max", "ultra"],
      "default_effort": "low" }
  ]
  ```
- `internal_subagents` (boolean, default `true`) — whether Codex internal
  subagents may be spawned. A strict boolean (not merely truthy) where `true` is
  force-enable, `false` disables them, and omission yields the effective default
  of `true`.
  The wrapper always injects the effective value as `features.multi_agent` into
  the per-run config
  ([ADR-0038](../../adr/0038-codex-internal-subagents-toggle.md)).

**precedence**: the runner option is SoT and ranks **above** user-global Codex
config (`~/.codex/config.toml`, etc.). Because the effective value (= configured
?? true) is always written into the per-run config, the runner's intent takes
precedence regardless of global settings (only `false` actually disables, while
`true` / omission is also explicitly injected).

**live reload**: modifying the config takes effect only for spawns after the
change. Running wrapper processes retain their launch-time values and do not
change immediately.

## Antigravity configuration

`runner.config.json`'s `antigravity` block passes Antigravity-engine-specific
settings (phase-34 Stage B6, issue #292).

- `cli_path` is an optional absolute path to `agy`. It is used unchanged for
  the model probe, hook registration, and every Antigravity turn. When it is
  absent, the runner searches only absolute directories in its own `PATH`.
  A bad explicit path never falls back to `PATH`; a newly spawned Antigravity
  wrapper is refused while existing wrappers retain their launch snapshot.
- `probe_timeout_ms` is an optional integer from 1000 through 120000, with a
  default of 30000. It bounds only `agy models` and `/hooks` probes, not a
  model turn or permission deadline. `KAOIRO_NODE` selects Node for runner
  helpers and is unrelated to this executable path.

- `extra_models` (`EngineModelInfo[]`) — the same operator-declaration
  mechanism as Codex's `extra_models` above, reusing the identical
  `parseExtraModels` / `mergeExtraModels` helpers: lets the operator
  declare a model that the register-time `agy models` probe (or the pinned
  1.1.26 snapshot fallback) does not yet return, without waiting for a
  kaoiro release. Only `value` is required; every field accepts only
  `EngineModelInfo`'s INPUT subset — `resolved_model` is upstream-derived
  metadata and is never read from config. `display_name`
  defaults to `value`; omitting `effort_levels` means no effort UI is
  offered (ADR-0035's "never infer an effort level" rule, which this
  engine follows too even though Antigravity itself has no effort switch
  today). A matching `value` overrides the resolved base catalog's entry;
  a new `value` is appended. The same merge applies both to the runner's
  register (LaunchDialog) and to the wrapper's own catalog (`ext.models`,
  `setModel`), and is re-applied on every live probe refresh so a
  refreshed catalog does not silently drop a declared model.
  ```json
  "antigravity": {
    "extra_models": [
      { "value": "gemini-4-nova", "display_name": "Gemini 4 Nova" }
    ]
  }
  ```

**live reload**: same semantics as the Codex block above — a config change
reaches only spawns after the reload. A reload resolves the path again, so a
fixed executable can recover without a config-text change. A catalog snapshot
fallback merely preserves model choices; it does not prove that a wrapper can
start.
