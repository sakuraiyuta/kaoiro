---
title: "Runner configuration"
status: implemented
last_updated: 2026-10-02
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
Set `server_url` in `runner.config.json`. The deprecated variable
`KAOIRO_RUNNER_SERVER_URL` still overrides it (see below).

For local launchers, `runner/runner.env` is a separate gitignored file that
contains only `KAOIRO_RUNNER_TOKEN=<64 lowercase hex>`. `scripts/dev.sh` and
`scripts/dogfood.sh` create it with mode 0600 when absent and append its pair
to the server list for the configured host; a preset environment token wins
after validation.

`server_url` is a `runner.config.json` key and hot-reloads (the runner reconnects
when it changes). The environment variable `KAOIRO_RUNNER_SERVER_URL`
(**deprecated; it still takes precedence over the config file**, issue #135)
replaces the file value when it is set and not empty. It must begin with `ws://`
or `wss://`, and an invalid format fails fast at startup / config reload. The
runner warns once per process that the variable is deprecated, and warns again
whenever the file value changes while a different variable value hides it.
Because hot reload keeps the same precedence, rewriting `server_url` in
`runner.config.json` while the variable is set does not change the actual
destination. Move the value into `server_url` and remove the variable from
`runner.env` to silence the warnings (see
[Runner install](../../operations/runner-install.md)). The variable is not
relayed to wrappers; they get their URL from the runner's own `server_url`.

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
continue to be emitted as before. Set `"log_phoenix_heartbeats": true` in
`runner.config.json` only when full logging is required for connection-level
investigation; the change applies to the next log line, with no restart. The
deprecated variable `KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS` still overrides the
key (exactly `1` keeps heartbeats; any other set value omits them). For
temporary dogfood investigation, launching with
`KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS=1 scripts/dogfood.sh` also emits the full
log to `tmp/dogfood-logs/runner.log`.

## Behaviour settings

Behaviour settings of the runner and its wrappers live in `runner.config.json`
(issue #469). A deprecated `KAOIRO_*` variable still overrides the key; it
logs a deprecation warning and will be removed in a later release. Settings
are per host; engine settings go in the engine's block (`claude_code`,
`codex` or `antigravity`) and settings for every engine are top-level keys.

Precedence is variable, then `runner.config.json`, then the default. The
runner does not copy a variable into the wrapper config: when a variable is
set (not undefined and not the empty string), the runner relays nothing for
that key and the wrapper reads the inherited variable through its own reader.
A set variable is validated at runner start and on every reload with the
wrapper's own grammar, so an invalid one (including a whitespace-only value)
stops the runner at start, naming the variable, and a reload that would enable
an engine with an invalid variable is skipped. Variables of an engine not in
`capabilities` are neither read nor validated.

A numeric value in `runner.config.json` must be a JSON number; strings, booleans and
`null` are rejected (`log_phoenix_heartbeats` must be a JSON boolean, `server_url`
a string), and an invalid file value skips the reload (the last valid
configuration stays). A change reaches wrappers launched after the reload
(spawn, resume, restart, reset, crash relaunch); running wrappers keep their
launch-time values. The runner logs `runner: behaviour settings for subsequent
wrappers: ...` when the relayed values change, and warns when a file value is
hidden by a variable.

| Variable | Config key | Type | Range | Default | Reader | Precedence |
| --- | --- | --- | --- | --- | --- | --- |
| `KAOIRO_CLAUDE_YIELD_CLAIM_TIMEOUT_MS` | `claude_code.yield_claim_timeout_ms` | integer | 1..60000 | 2000 | Claude wrapper (`parseConfig`) | variable > file > default |
| `KAOIRO_CLAUDE_PENDING_RECEIPT_ROOT_TIMEOUT_MS` | `claude_code.pending_receipt_root_timeout_ms` | integer | 1..60000 | 2000 | Claude wrapper (`parseConfig`) | variable > file > default |
| `KAOIRO_CLAUDE_URGENT_OVERTAKE_LIMIT` | `claude_code.urgent_overtake_limit` | integer | 1..64 | 2 | Claude wrapper (`parseConfig`) | variable > file > default |
| `KAOIRO_CLAUDE_FOLDS_PER_TURN` | `claude_code.folds_per_turn` | integer | 1..64 | 3 | Claude wrapper (`parseConfig`) | variable > file > default |
| `KAOIRO_CLAUDE_TURN_WATCHDOG_INACTIVITY_MS` | `claude_code.turn_watchdog_inactivity_ms` | integer | 60000..2147483647 | 1800000 | Claude wrapper (`resolveTurnWatchdogSettings`) | variable > file > default |
| `KAOIRO_CLAUDE_TURN_WATCHDOG_ABORT_GRACE_MS` | `claude_code.turn_watchdog_abort_grace_ms` | integer | 1..2147483647 | 60000 | Claude wrapper (`resolveTurnWatchdogSettings`) | variable > file > default |
| `KAOIRO_CODEX_TURN_WATCHDOG_INACTIVITY_MS` | `codex.turn_watchdog_inactivity_ms` | integer | 60000..2147483647 | 1800000 | Codex wrapper (`resolveTurnWatchdogSettings`) | variable > file > default |
| `KAOIRO_CODEX_TURN_WATCHDOG_ABORT_GRACE_MS` | `codex.turn_watchdog_abort_grace_ms` | integer | 1..2147483647 | 60000 | Codex wrapper (`resolveTurnWatchdogSettings`) | variable > file > default |
| `KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_INACTIVITY_MS` | `antigravity.turn_watchdog_inactivity_ms` | integer | 60000..2147483647 | 1800000 | Antigravity wrapper (`resolveTurnWatchdogSettings`) | variable > file > default |
| `KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_ABORT_GRACE_MS` | `antigravity.turn_watchdog_abort_grace_ms` | integer | 1..2147483647 | 60000 | Antigravity wrapper (`resolveTurnWatchdogSettings`) | variable > file > default |
| `KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS` | `antigravity.tool_timeout_ms` | integer | 1000..2147483647 | 600000 | Antigravity wrapper (`resolveTurnWatchdogSettings`) | variable > file > default |
| `KAOIRO_ANTIGRAVITY_EPOCH_IDLE_MS` | `antigravity.epoch_idle_ms` | integer | 1000..2147483647 | 1800000 | Antigravity wrapper (`resolveEpochIdleMs`) | variable > file > default |
| — | `claude_code.inter_agent_batch_max_items` | integer | 1..9007199254740991 | 10 | every wrapper (`parseConfig`); omitted keys are resolved in the spawn snapshot | file > default |
| — | `claude_code.inter_agent_backlog_max_items` | integer | 1..1000 | 100 | every wrapper (`parseConfig`); omitted keys are resolved in the spawn snapshot | file > default |
| — | `claude_code.inter_agent_backlog_max_bytes` | integer | 16384..9007199254740991, and at most the server's `backlog_max_bytes_ceiling` at join | 524288 | every wrapper (`parseConfig`); omitted keys are resolved in the spawn snapshot | file > default |
| — | `codex.inter_agent_batch_max_items` | integer | 1..9007199254740991 | 10 | every wrapper (`parseConfig`); omitted keys are resolved in the spawn snapshot | file > default |
| — | `codex.inter_agent_backlog_max_items` | integer | 1..1000 | 100 | every wrapper (`parseConfig`); omitted keys are resolved in the spawn snapshot | file > default |
| — | `codex.inter_agent_backlog_max_bytes` | integer | 16384..9007199254740991, and at most the server's `backlog_max_bytes_ceiling` at join | 524288 | every wrapper (`parseConfig`); omitted keys are resolved in the spawn snapshot | file > default |
| — | `antigravity.inter_agent_batch_max_items` | integer | 1..9007199254740991 | 10 | every wrapper (`parseConfig`); omitted keys are resolved in the spawn snapshot | file > default |
| — | `antigravity.inter_agent_backlog_max_items` | integer | 1..1000 | 100 | every wrapper (`parseConfig`); omitted keys are resolved in the spawn snapshot | file > default |
| — | `antigravity.inter_agent_backlog_max_bytes` | integer | 16384..9007199254740991, and at most the server's `backlog_max_bytes_ceiling` at join | 524288 | every wrapper (`parseConfig`); omitted keys are resolved in the spawn snapshot | file > default |
| `KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS` | `permission_timeout_ms` | integer | 1..2147483647 | none (wait for the operator) | every wrapper (`parseConfig`) | variable > file > default |
| `KAOIRO_CODEX_OPERATOR_STEER` | `codex.operator_steer` | boolean | `true` / `false` (variable: exactly `1` is on) | `false` | Codex wrapper (`flagArgument`) | variable > file > persona list |
| `KAOIRO_CODEX_APPROVAL_AXIS` | `codex.approval_axis` | boolean | `true` / `false` (variable: exactly `1` is on) | `false` | Codex wrapper (`flagArgument`) | variable > file > persona list |
| `KAOIRO_CLAUDE_PHASE2_DELIVERY` | `claude_code.phase2_delivery` | boolean | `true` / `false` (variable: exactly `1` is on) | `false` | Claude wrapper (`flagArgument`) | variable > file > persona list |
| `KAOIRO_RUNNER_SERVER_URL` | `server_url` | string | `ws://` or `wss://` URL | required in the file | the runner (`applyServerUrlOverride`) | variable > file |
| `KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS` | `log_phoenix_heartbeats` | boolean | `true` / `false` (variable: exactly `1` is on) | `false` | the runner (live, per log line) | variable > file > default |

The turn watchdog interrupts a turn whose SDK stream has been silent for
`turn_watchdog_inactivity_ms`, then stops the wrapper if the interrupt has not
ended the turn within `turn_watchdog_abort_grace_ms`. A variable for it is read
with a digits-only grammar (`"1e3"` is rejected); the permission timeout
variable and the scheduler variables use `Number()` (`"1e3"` is accepted).
Whitespace-only values are invalid for every numeric variable. What each Claude
scheduler key controls is in [Wrapper configuration](wrapper.md).

`antigravity.tool_timeout_ms` is the absolute bound on one Antigravity tool
step, and `antigravity.epoch_idle_ms` is how long an idle `agy` epoch lives
before it is ended. Both variables use the digits-only grammar; the epoch idle
variable is capped at 2147483647 (a larger value reached `setTimeout`,
which clamps it to 1 ms). `server_url` and `log_phoenix_heartbeats` are acted on
by the runner itself and are never relayed to a wrapper.

## Codex home

`CODEX_HOME` in `runner.env` selects the Codex state directory (auth, sessions,
state databases) for the whole runner. It is an environment variable, not a
`runner.config.json` key: the runner, Codex wrappers, the Codex SDK and the
`codex app-server` child retain it for state and resume. Claude Code and
Antigravity wrapper children receive an environment without it. Codex shell
tools receive a separate private home through `shell_environment_policy.set`.
The runner removes that tool home when its wrapper exits. The value is read
once at startup (restart the runner after changing it).

- Unset or empty means `~/.codex`, as for the Codex CLI itself.
- It must be an absolute path of an existing directory. Otherwise the runner
  logs `runner: error — CODEX_HOME=... ; Codex launches are refused until it is
  fixed` at startup and refuses every Codex launch (spawn, restart, reset,
  switch and crash relaunch) with a `runner: codex launch refused for <agent>`
  line; other engines are unaffected. A refused spawn, resume, switch or restart
  is reported to the server as a failed result (`error`, under the command's
  request id, so a restart's planned-downtime window is closed and the running
  wrapper stays). A refused crash relaunch has no command to answer: the agent
  stays offline and the journal line is the only signal.
- The directory is checked at every launch, so creating a missing directory
  needs no restart; changing the value does (it is read at startup).
- The runner logs `runner: codex home=<path>` at startup and each Codex wrapper
  logs `codex: home=<path>`.
- Readers: the runner's resume scan (`sessions.ts`) and the wrapper's rollout
  readers (`rollout.ts`) resolve the directory through `codexHome()`
  (`wrapper/codex/src/codex_home.ts`); no other source file may spell the
  default path (a test scans for it).

Operator procedure, verification and rollback:
[Codex home for production](../../operations/codex-home.md).

## Codex backend

The public Codex engine defaults to `codex exec`. Set `codex.backend` to
`"app-server"` in `runner.config.json` to select the persistent app-server child;
`"exec"` or omission keeps the default. The setting is host-wide and applies
only to new Codex wrapper lifetimes, including resume, reset, and automatic
restart. Existing children retain their launch-time selection after reload.
The runner relays only its local selection as `codex_backend` in the wrapper
startup config; direct wrapper launches may use that same field. No environment
variable, command-line backend flag, dashboard selector, spawn payload, or
resume snapshot selects a backend.

Unknown values reject startup; a bad reload is skipped without replacing the
last valid configuration. After a valid reload, wait for the runner's
`codex backend=... for subsequent wrappers` diagnostic: the earlier `config
reload` line is not an application receipt. New launches and resumes use the
new selection, and the wrapper logs its selected backend at startup. There is
no automatic fallback to exec. Use a runner release that bundles this selector
and both backends; older wrapper releases may ignore the new field. For
rollback, stop the target agent, set `backend` to `"exec"`, wait for the applied
configuration diagnostic, then resume its recorded session on the same host
and cwd. See the
[rollback runbook](../../operations/codex-backend-switch.md#codex-backend-selection-and-rollback)
and [ADR-0058](../../adr/0058-codex-app-server-turn-steer.md).
Steering remains disabled and approval remains `never`.

### Codex backend selection

This subsection is retained as a fragment-compatible pointer. The selector,
reload, compatibility, and rollback contract is in
[Codex backend](#codex-backend); the operator procedure is in the
[backend switching runbook](../../operations/codex-backend-switch.md#codex-backend-selection-and-rollback).

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

- `max_sandbox` (`"read-only" | "workspace-write" | "danger-full-access"`),
  `max_approval` (`"untrusted" | "on-request" | "local" | "never"`), and
  `max_network_access` (boolean) are host-local runtime permission-switch
  ceilings ([ADR-0057](../../adr/0057-antigravity-adapter.md) F4c Stage B0,
  issue #359). Each optional axis caps how far a server-originated
  `set_permission` may widen this agent's cell beyond its launch value. An
  absent axis defaults to the launch value (`sandbox` / `network_access`) or
  `permissive_max(launch, "local")` (`approval`). A ceiling narrower than the
  launch value is a contradiction and is rejected at spawn. Relayed to the
  wrapper as `WrapperConfig.max_sandbox` / `max_approval` /
  `max_network_access`.
  ```json
  "antigravity": {
    "max_sandbox": "workspace-write",
    "max_approval": "on-request",
    "max_network_access": false
  }
  ```

**live reload**: same semantics as the Codex block above — a config change
reaches only spawns after the reload. A reload resolves the path again, so a
fixed executable can recover without a config-text change. A catalog snapshot
fallback merely preserves model choices; it does not prove that a wrapper can
start.
