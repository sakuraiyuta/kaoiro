---
title: Move runner/wrapper behaviour settings from KAOIRO_* variables into runner.config.json
status: in_progress
last_updated: 2026-10-02
related: [issue-469, issue-438, issue-463, issue-470]
---

# Move runner/wrapper behaviour settings into `runner.config.json`

[Issue #469](https://github.com/sakuraiyuta/kaoiro/issues/469) (operator
decision 2026-10-01): behaviour settings live in `runner.config.json`, which
already hot-reloads; the `KAOIRO_*` variable stays as an override (it wins),
logs a deprecation warning, and is removed later. This plan is the inventory
(part 1), the design (part 2), and the verification plan (part 3). Nothing
is implemented yet. Base: `develop` at `e1073d7d`.

## 1. Inventory

Method: every `KAOIRO_*` name in `runner/`, `wrapper/`, `protocol/`,
`scripts/`, `.github/` (non-test) was followed to the function that decides
its value; `server/` and `dashboard/` are out of scope (issue #470). The
production `runner.env` on `yuta-win` was read with values redacted: it sets
`KAOIRO_RUNNER_TOKEN`, `KAOIRO_NODE`, `PATH`, `CODEX_HOME`,
`KAOIRO_CODEX_APPROVAL_AXIS`, `KAOIRO_CODEX_OPERATOR_STEER`,
`KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS`.

Facts that shape the design (observed in code, not inferred):

- `makeLauncher` (`runner/src/spawn.ts:130`) copies the runner's own
  `process.env` at each launch. The runner process's environment does not
  change after it starts, so an edit to a service env file reaches a wrapper
  only after a runner restart, and a wrapper reads it once at its own
  startup.
- The three wrapper entrypoints read the watchdog values straight from
  `process.env` (`readTurnWatchdogSettings(process.env, ...)` in each
  `cli.ts`), Antigravity does the same for epoch idle, and every default-model
  resolution reads its variable directly. Serialising a new `WrapperConfig`
  field is therefore not enough: each consumer must be changed to read it
  (section 2.2).
- The wrapper's `parseConfig` (`wrapper/core/src/persona.ts:262-308`) already
  reads five of these as `config field ?? env`. A config field therefore
  already outranks the variable inside the wrapper. #469 wants the opposite
  (variable wins) at the runner level; section 2.4 reconciles the two.
- `resolveWrapperConfig` (`runner/src/supervisor.ts:421`) has 14 positional
  parameters ("appended last" by convention). Adding about ten more the same
  way is not workable, hence the common path in section 2.2.
- `changedFields` (`runner/src/config-diff.ts`) is an allowlist of top-level
  keys, and `applyReload` returns early when it is empty
  (`runner/src/runner-cli.ts`, `diff.length === 0 && !nextAntigravityEnabled`).
  A new key missing from that list is never applied on reload, silently.

### 1.1 Migrate (behaviour)

"Hot reload" column: **next lifetime** = applied to the next wrapper launch
(spawn, resume, restart, reset, crash relaunch, because `#wrapperConfig` is
evaluated at each launch); a running wrapper keeps its launch-time value.
Today's column for every row is "no: needs a runner restart".

| Variable | Reader | Class | Config key | Hot reload |
| --- | --- | --- | --- | --- |
| `KAOIRO_CLAUDE_YIELD_CLAIM_TIMEOUT_MS` | wrapper (`core/persona.ts:285`) | behaviour | `claude_code.yield_claim_timeout_ms` | next lifetime |
| `KAOIRO_CLAUDE_PENDING_RECEIPT_ROOT_TIMEOUT_MS` | wrapper (`core/persona.ts:286`) | behaviour | `claude_code.pending_receipt_root_timeout_ms` | next lifetime |
| `KAOIRO_CLAUDE_URGENT_OVERTAKE_LIMIT` | wrapper (`core/persona.ts:298`) | behaviour | `claude_code.urgent_overtake_limit` | next lifetime |
| `KAOIRO_CLAUDE_FOLDS_PER_TURN` | wrapper (`core/persona.ts:299`) | behaviour | `claude_code.folds_per_turn` | next lifetime |
| `KAOIRO_CLAUDE_TURN_WATCHDOG_INACTIVITY_MS` | wrapper (`claude-code/turn_watchdog.ts:18`, called from `cli.ts:185`) | behaviour | `claude_code.turn_watchdog_inactivity_ms` | next lifetime |
| `KAOIRO_CLAUDE_TURN_WATCHDOG_ABORT_GRACE_MS` | wrapper (same) | behaviour | `claude_code.turn_watchdog_abort_grace_ms` | next lifetime |
| `KAOIRO_CODEX_TURN_WATCHDOG_INACTIVITY_MS` | wrapper (`codex/turn_watchdog.ts:15`, `cli.ts:195`) | behaviour | `codex.turn_watchdog_inactivity_ms` | next lifetime |
| `KAOIRO_CODEX_TURN_WATCHDOG_ABORT_GRACE_MS` | wrapper (same) | behaviour | `codex.turn_watchdog_abort_grace_ms` | next lifetime |
| `KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_INACTIVITY_MS` | wrapper (`antigravity/turn_watchdog.ts:12`, `cli.ts:102`) | behaviour | `antigravity.turn_watchdog_inactivity_ms` | next lifetime |
| `KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_ABORT_GRACE_MS` | wrapper (same) | behaviour | `antigravity.turn_watchdog_abort_grace_ms` | next lifetime |
| `KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS` | wrapper (`antigravity/turn_watchdog.ts:15`) | behaviour | `antigravity.tool_timeout_ms` | next lifetime |
| `KAOIRO_ANTIGRAVITY_EPOCH_IDLE_MS` | wrapper (`antigravity/epoch.ts:58`, `cli.ts:106`) | behaviour | `antigravity.epoch_idle_ms` | next lifetime |
| `KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS` | wrapper (`core/persona.ts:272`), all engines | behaviour | `permission_timeout_ms` (top level) | next lifetime |
| `KAOIRO_CLAUDE_CODE_DEFAULT_MODEL` | wrapper (`claude-code/cli.ts:191`) | behaviour | `claude_code.default_model` | next lifetime |
| `KAOIRO_CODEX_DEFAULT_MODEL` | wrapper (`codex/cli.ts:205`, `source_resolution.ts`) | behaviour | `codex.default_model` | next lifetime |
| `KAOIRO_ANTIGRAVITY_DEFAULT_MODEL` | wrapper (`antigravity/cli.ts:118`) | behaviour | `antigravity.default_model` | next lifetime |
| `KAOIRO_CODEX_TURN_TRACE_DIR` | wrapper (`codex/turn_diagnostics.ts:26`) | behaviour (directory) | `codex.turn_trace_dir` | next lifetime |
| `KAOIRO_IA_PENDING_DIR` | wrapper (`agent-common/ia_sidecar.ts:111`) | behaviour (directory) | `ia_pending_dir` (top level) | next lifetime |
| `KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS` | runner (`config.ts:747`, `transport.ts:345`) | behaviour | `log_phoenix_heartbeats` (top level, boolean) | live (see 2.5) |
| `KAOIRO_RUNNER_SERVER_URL` | runner (`config.ts:763`) | wiring, key already exists | `server_url` (existing) | already live; the variable is deprecated like the others |
| `KAOIRO_CODEX_OPERATOR_STEER` | wrapper (`codex/cli.ts:182`) | behaviour flag (group 4) | `codex.operator_steer` | next lifetime |
| `KAOIRO_CODEX_APPROVAL_AXIS` | wrapper (`codex/cli.ts:188`) | behaviour flag (group 4) | `codex.approval_axis` | next lifetime |
| `KAOIRO_CLAUDE_PHASE2_DELIVERY` | wrapper (`claude-code/cli.ts:173`) | behaviour flag (group 4) | `claude_code.phase2_delivery` | next lifetime |

### 1.2 Stay in the environment

| Variable | Reader | Class | Why |
| --- | --- | --- | --- |
| `KAOIRO_RUNNER_TOKEN` | runner (`runner-cli.ts:169`, `transport.ts`) | secret | out of scope (issue #469) |
| `KAOIRO_RUNNER_TOKENS`, `KAOIRO_WRAPPER_TOKENS`, `KAOIRO_CLIENT_TOKENS`, `KAOIRO_LAUNCHER_RUNNER_TOKENS` | server / scripts | secret | out of scope |
| `KAOIRO_CODEX_OPERATOR_STEER_PERSONAS`, `KAOIRO_CODEX_APPROVAL_AXIS_PERSONAS`, `KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS` | wrapper cli (`personaOptInSource`) | behaviour | issue #463 owns them |
| `KAOIRO_NODE`, `KAOIRO_RUNNER_DIR`, `KAOIRO_RUNNER_ENV`, `KAOIRO_RUNNER_CONFIG`, `KAOIRO_RUNNER_INSTALL_DIR` | `runner/deploy/*.sh`, `setup.ts` | startup wiring | read before the config file exists (they locate it) |
| `KAOIRO_WRAPPER_DEV` | runner (`spawn.ts:65`) | startup wiring | dev launcher toggle, read once per engine at first launch and cached |
| `KAOIRO_SYSTEMCTL`, `KAOIRO_SYSTEMD_RUN`, `KAOIRO_LAUNCHCTL`, `KAOIRO_UNAME`, `KAOIRO_VERIFIED_IDENTITY` | deploy scripts | launch/test plumbing | test seams for the scripts |
| `KAOIRO_BRIDGE_SOCKET`, `KAOIRO_BRIDGE_NONCE`, `KAOIRO_BRIDGE_STDERR_PATH`, `KAOIRO_GATE_SOCKET`, `KAOIRO_GATE_NONCE`, `KAOIRO_GATE_DEADLINE_MS` | wrapper child processes | internal hand-off | the wrapper sets them for its own children (`host.ts`) |
| `KAOIRO_BUILD_*` | build scripts | build-time | baked into the artifact |
| `KAOIRO_TEST_OWNER_TAG`, `KAOIRO_WRITE_FIXTURES`, `KAOIRO_SESSION_RESET_REQUEST_REPLY_REASONS` | tests / CI | test-only | not operator settings |
| `KAOIRO_*_PATH` store paths set by `scripts/dev.sh` | server | server | issue #470 |

`CODEX_HOME` is not a `KAOIRO_*` variable and stays as documented in
`docs/operations/codex-home.md`.

Observation (measured by the design reviewer on Node 24.3.0): `readEpochIdleMs`
checks a minimum only, and a value above 2,147,483,647 reaches `setTimeout`,
which clamps it to 1 ms and emits `TimeoutOverflowWarning`. Section 2.1 adds
the ceiling as an intentional behaviour change, not as baseline parity.

## 2. Design

### 2.1 Schema: per host, per engine, flat keys

`runner.config.json` is already per host, so every setting is per host. Engine
settings go in the engine's block, as `codex` and `antigravity` already do;
Claude gets a `claude_code` block (the engine id and capability name; the
`claude` alias is deprecated). Keys stay flat and snake_case inside a block,
matching `cli_path`, `probe_timeout_ms`, `extra_models`. Settings that apply
to every engine, or to the runner itself, are top level. Per-persona values
are out of scope (issue #463); a persona override can be added later as a new
key without changing these.

```json
{
  "permission_timeout_ms": 600000,
  "log_phoenix_heartbeats": false,
  "claude_code": {
    "folds_per_turn": 3,
    "turn_watchdog_inactivity_ms": 1800000
  },
  "codex": { "turn_watchdog_abort_grace_ms": 60000 },
  "antigravity": { "tool_timeout_ms": 600000, "epoch_idle_ms": 1800000 }
}
```

An unknown key inside a known block is ignored, as today. A wrongly typed or
out-of-range value throws `ConfigError`, which the existing reload path turns
into "skip the reload, keep the last valid configuration".

#### Input contract

Two separate things are specified per setting: the **file value** (new keys,
so new constraints are a schema choice, not a change to anything supported
today) and the **environment value** (an existing contract that this
migration keeps exactly). The environment value is never re-interpreted by
the runner: its meaning is whatever the wrapper's current reader does
(verified against the readers; see the whitespace row below). "Env counts as
set" mirrors each reader's own test.

| Setting | File value (new constraints) | Env counts as set when | Env grammar and constraints (retained, as the wrapper reader applies them) |
| --- | --- | --- | --- |
| `claude_code.yield_claim_timeout_ms`, `pending_receipt_root_timeout_ms` | JSON number, safe integer, 1..60000 | not undefined and not `""` | `Number(value)` safe integer in 1..60000 (`persona.ts`); `"1e3"` accepted, whitespace-only rejected |
| `claude_code.urgent_overtake_limit`, `folds_per_turn` | JSON number, safe integer, 1..64 | same | same with 1..64 |
| `permission_timeout_ms` | JSON number, integer >= 1 | same | `Number(value)` integer >= 1; whitespace-only rejected |
| `*.turn_watchdog_inactivity_ms` | JSON number, 60000..2147483647 | same | digits only, then range; whitespace-only rejected |
| `*.turn_watchdog_abort_grace_ms` | JSON number, 1..2147483647 | same | digits only, then range; whitespace-only rejected |
| `antigravity.tool_timeout_ms` | JSON number, 1000..2147483647 | same | digits only, then range; whitespace-only rejected |
| `antigravity.epoch_idle_ms` | JSON number, 1000..2147483647 | same | digits only, minimum 1000 as today; **new ceiling 2147483647** (the only tightening of an existing environment contract) |
| `*.default_model` | non-empty string, at most 256 characters | not undefined (an empty value is "set", as today) | any string, no validation (a 257-character value passes today and still does) |
| `codex.turn_trace_dir` | absolute path, no NUL | not undefined | any string, relative paths accepted (today's `defaultCodexTurnTraceDir`) |
| `ia_pending_dir` | absolute path, no NUL | not undefined | any string, relative paths accepted (today's `defaultPendingDir`) |
| `log_phoenix_heartbeats` | boolean | not undefined and not `""` | exactly `"1"` is on, anything else off (today's rule) |
| the three flags | boolean | not undefined and not `""` | exactly `"1"` is the global opt-in, anything else defers to the persona list (today's rule) |

Notes on the table:

- The three numeric families reject a whitespace-only value today (`" "` is
  not an empty string, fails the digits grammar or `Number(" ") = 0`), so that
  rejection is retained, not softened. Only an undefined or exactly empty
  value is "unset".
- The runner does not copy an environment value into the wrapper config. When
  a variable is set (per the column above) the runner relays nothing for that
  key and the wrapper consumes the inherited variable through its existing
  reader, so the runner's notion of "set" and the wrapper's cannot diverge.
  A whitespace-only numeric variable is therefore rejected by the runner at
  start (it runs the same reader, section 2.4) instead of being treated as
  absent while the wrapper later throws on the inherited copy.
- File values: a numeric setting in `runner.config.json` must be a JSON number.
  Strings, booleans, `null`, arrays, objects, `NaN`/infinite values and unsafe
  integers are rejected. `parseConfig` in the wrapper still coerces `"3"` and
  `true` for the four Claude fields when read from a directly launched wrapper
  config; the runner writes JSON numbers, so the relay path never meets that
  coercion. The checked property is one-directional: every file value the
  runner accepts, the wrapper accepts identically.
- **Intentional tightening of an existing contract** (section 4): (a) the
  epoch-idle ceiling, in the runner and in `readEpochIdleMs`, so a direct
  launch and an existing environment value above the ceiling are affected;
  (b) an already-invalid environment value of an enabled engine now stops the
  runner at start (section 2.7) rather than failing each later wrapper launch.
  Nothing else tightens an existing contract: relative directories, empty or
  long model strings and `"1e3"` remain accepted wherever they are accepted
  today. Known quirks left as they are, not part of this issue: an empty
  `KAOIRO_*_DEFAULT_MODEL` sets an empty model, and an empty directory
  variable yields an empty path.
- **Disabled engines**: environment variables are read, validated and warned
  about only for engines in the effective `capabilities` (top-level rows
  always). A bad `KAOIRO_CODEX_*` value on a host with Codex disabled cannot
  affect anything and does not stop the runner. File values are validated
  regardless, as the `codex` / `antigravity` blocks are today. Enabling an
  engine by reload whose variable is invalid skips that reload.

### 2.2 One relay path: a declarative registry

New `runner/src/behaviour-settings.ts` holds one table. Each row:

```text
{ key: ["claude_code", "folds_per_turn"],   // runner.config.json path
  wrapperField: "folds_per_turn",           // WrapperConfig field
  engines: ["claude-code"],                 // which spawns receive it
  env: "KAOIRO_CLAUDE_FOLDS_PER_TURN",      // deprecated override
  parse: (value, field) => number }         // shared validator
```

The same table drives five things, so a new setting is one row and the five
cannot disagree: file parsing in `parseRunnerConfig`, environment override and
its deprecation warning, the relay into `WrapperConfig`, the `changedFields`
diff, and the documentation table (a test compares the table in
`docs/reference/configuration/runner.md` with the registry, so the doc cannot
drift). `resolveWrapperConfig` gets one more trailing parameter, the
already-resolved relay object for the spawn's engine, and spreads it into the
result. It does not grow ten positional parameters. The supervisor holds the
relay object as one runtime-config entry set by `updateRuntimeConfig`.

New `WrapperConfig` fields (protocol, process-local, never a wire message):
`turn_watchdog_inactivity_ms`, `turn_watchdog_abort_grace_ms`,
`antigravity_tool_timeout_ms`, `antigravity_epoch_idle_ms`, `default_model`,
`codex_turn_trace_dir`, `ia_pending_dir`, `operator_steer`, `approval_axis`,
`phase2_delivery`. The four Claude scheduler fields and `permission_timeout_ms`
already exist. Engine-neutral names are used where the runner relays only the
spawn's own engine's value (the same way `codex_*` fields are relayed only for
Codex spawns).

#### Consumer contract

Relaying a field is inert until the code that uses the value reads it. Every
wrapper-side consumer is changed to the same selection rule,
`config field ?? environment ?? default` (the wrapper's existing rule, so a
direct launch behaves as before), with one exception: the three flags select
the variable first (section 2.4). For a runner-launched wrapper, "variable
wins" is achieved by omission: when a variable is set, the runner leaves the
config field out, so the wrapper falls through to the inherited variable and
its existing reader; when it is not set, the runner relays the file value.

Each consumer obtains its value from one resolved-settings object per wrapper,
built once in `cli.ts` from `(config, process.env)` (value plus source per
setting). The same object is passed to the consumer and printed by the startup
line below, so the line cannot report a value the consumer did not receive.

| Setting | Final consumer (changed) | Change |
| --- | --- | --- |
| watchdog inactivity / abort grace, per engine | `readTurnWatchdogSettings` in each engine's `turn_watchdog.ts`, called from its `cli.ts` | gains a third `config` argument; the warning text names the config key when that was the source |
| Antigravity tool timeout | same function (Antigravity) | same |
| Antigravity epoch idle | `readEpochIdleMs` called from `antigravity/cli.ts:106` | gains a `config` argument and the new ceiling |
| default model, per engine | the `envDefaultModel` argument that each `cli.ts` hands to `resolveClaudeSources` / `resolveCodexSources` / `resolveAntigravitySources` and to `applyEnvDefaultModel` | the argument becomes `config.default_model ?? process.env.<VAR>`; launch picks and resume snapshots keep their higher priority because `config.model` and `model_source` are untouched |
| Codex turn trace directory | `CodexHost` option `turnTraceDir` (`host.ts:825`) | `cli.ts` passes `config.codex_turn_trace_dir`; `defaultCodexTurnTraceDir()` keeps the variable and home fallbacks |
| IA pending directory | `IaSidecar` option `pendingDir`, constructed in `claude-code/cli.ts` and `codex/cli.ts` | both pass `config.ia_pending_dir`; `defaultPendingDir()` keeps the fallbacks |
| the three flags | `personaOptInSource` arguments in `claude-code/cli.ts:173`, `codex/cli.ts:180` and `:186` | flag argument built as in section 2.4; `personaOptInSource` itself is unchanged |
| Claude scheduler keys, `permission_timeout_ms` | `parseConfig` and its existing consumers | none (already config-aware) |

Each wrapper logs one startup line from that resolved-settings object, each
value with its source (`config`, `env`, `default`), next to the existing
summary lines. It is operator-visible and is what the default-composition gate
in section 3 observes. It never prints a secret; no setting here is one.

### 2.3 `changedFields` cannot lag the schema

Replace the hand-written field list with a constant
`Record<keyof RunnerConfig, true>` and make `changedFields` iterate that very
object's keys, so adding a key to `RunnerConfig` without adding it to the
reload diff is a compile error. (The reviewer's TypeScript 5.9.3 probe
rejected an omitted optional key with TS2741; nested blocks are already
whole-object comparisons, so no nested list is needed.) This closes the silent
no-op described above as a class, not a single instance.

### 2.4 Precedence and the wrapper's existing `config ?? env`

- **Runner**: for each registry row of an enabled engine, the variable is "set"
  by the row's own test (section 2.1 table). A set variable is validated by
  calling the wrapper package's existing reader on it (for example
  `readTurnWatchdogSettings` or `readEpochIdleMs` with a one-key record, and
  the Claude scheduler and permission parsers extracted from `parseConfig` into
  exported helpers), so grammar and bounds come from one implementation. The
  readers are exposed through supported package entries (the Claude root index
  and its closed `exports` map do not export its watchdog reader today), and a
  direct dependency on wrapper-core or agent-common is declared if the runner
  imports from them instead of re-exporting through an engine package. An
  invalid value throws `ConfigError` naming the variable, at startup (the
  runner exits non-zero) and on reload (reload skipped), the same contract
  `KAOIRO_RUNNER_SERVER_URL` has. The runner relays the file value only for
  rows whose variable is not set. `RunnerConfig` keeps holding file values, so
  `changedFields` compares file values and the relay is computed from the file
  plus the (fixed) environment.
- **Runner-launched wrapper**: the config field is present only when the
  variable is not set, so the wrapper's `config ?? env` selects the file value
  or the inherited variable exactly as a direct launch would, and a wrapper
  never warns on its own.
- **Directly launched wrapper** (no runner; `wrapper/README.md`): keeps the
  existing `config field ?? env` contract and remains the documented escape
  hatch (issue #438). It has no runner config file, so it emits no
  deprecation warning.
- **Warnings** (runner only, to stderr like the existing deprecations):
  (a) once per variable per process when an override is in use:
  `runner: warn - KAOIRO_X is deprecated; set "block.key" in
  runner.config.json (the variable still overrides the file)`;
  (b) when the JSON also sets that key to a different value, at startup and
  whenever that key's file value changes:
  `runner: warn - "block.key" in runner.config.json is shadowed by KAOIRO_X`.
  Warning (b) is the part that matters for operations: an edit that silently
  has no effect is the failure this issue exists to remove.
  Because `RunnerConfig` holds file values, file=A with variable=B followed by
  file=C with the same variable=B is a non-empty `changedFields` result, so the
  reload handler does not return early and the warning is emitted from the
  new file value. The relay itself is unchanged in that case (still omitted for
  that key). A rejected reload warns about nothing and is not reported as
  applied.
- **`server_url`** keeps its existing mechanism: `KAOIRO_RUNNER_SERVER_URL`
  (set when not empty, must start with `ws://` or `wss://`) replaces the file
  value in the config the runner uses, because the connection target is needed
  before any relay. It now emits the same warnings (a) and (b) as the other
  variables, with no exemption, and is not relayed to a wrapper (the wrapper
  gets its URL from the runner's own `server_url`).
- **Flags** (group 4). `personaOptInSource(personaId, flag, list)`
  takes a string: only `"1"` enables globally and every other value defers to
  the persona list (the reviewer's probe: `"0"` and `"false"` both returned
  `persona_list` for a listed persona). A JSON boolean cannot carry that
  distinction, so the contract is: config `true` means "global opt-in" (the
  same as the variable being `"1"`); config `false` and absent are the same,
  "no global opt-in", and never override a persona-list opt-in. The wrapper
  builds the `flag` argument as: the variable if set and non-empty (passed
  through verbatim), else `"1"` when the config field is `true`, else
  undefined. This is a deliberate exception to the common
  `config ?? environment` rule of section 2.2, for runner-launched and directly
  launched wrappers alike, so that variable `"0"` beats config `true`
  everywhere. The Codex backend gate (`backend === "app-server"`) is evaluated
  first and unchanged; the exec backend ignores both.

  | Variable | Config | Persona in list | Result |
  | --- | --- | --- | --- |
  | unset or empty | absent or `false` | no | off |
  | unset or empty | absent or `false` | yes | on (`persona_list`) |
  | unset or empty | `true` | either | on (`flag`) |
  | `"1"` | any | either | on (`flag`) |
  | other non-empty (`"0"`, `"true"`) | `true` | no | off (the variable wins, and it is not `"1"`) |
  | other non-empty | `true` | yes | on (`persona_list`) |
  | other non-empty | absent or `false` | yes / no | on / off by the list |

  The one new case a reader may not expect is variable `"0"` with config
  `true`: the variable wins, so the config opt-in is ignored. That follows the
  issue's "variable wins" rule and is an accepted decision (section 4).

### 2.5 Hot reload scope

| Setting kind | Applied | Mechanism |
| --- | --- | --- |
| Relayed to a wrapper | next wrapper lifetime (spawn, resume, restart, reset, crash relaunch); running wrappers keep launch-time values | `updateRuntimeConfig` replaces the relay object; `#wrapperConfig` reads it at each launch |
| `log_phoenix_heartbeats` | immediately | `includeHeartbeats` becomes a getter evaluated per log line |
| `server_url`, `host_id` | unchanged (reconnect) | existing |
| Environment-only values (token, plumbing) | restart | unchanged |

The wrapper never re-reads anything at runtime; there is no wrapper-side hot
reload. "Applied" for the relay is observable: the runner already logs
`runner: config reload - <fields>`; add one line per applied relay change so
the reload line is not mistaken for an application receipt (the same trap
`runner.md` documents for `codex.backend`).

### 2.6 Rollout order (one reviewed delivery per group)

1. Common path (registry, environment validation through the wrapper readers
   and omission of relayed keys whose variable is set, relay parameter, exhaustive
   diff) with the four Claude scheduler keys. Closes issue #438.
2. Turn watchdogs (6) and `permission_timeout_ms`.
3. Antigravity `tool_timeout_ms`, `epoch_idle_ms`; the runner-own settings
   `log_phoenix_heartbeats` and the `KAOIRO_RUNNER_SERVER_URL` deprecation
   (section 2.4), with `scripts/dev.sh`, `scripts/dogfood.sh`,
   `runner.env.example` and the docs that name the variable moved to the
   `server_url` key.
4. The three flags.
5. Directories (`turn_trace_dir`, `ia_pending_dir`).
6. Default models.

Progress (updated as each group lands):

| Group | Status |
| --- | --- |
| 1. Common path and Claude scheduler keys | implemented, awaiting implementation review |
| 2. Turn watchdogs and `permission_timeout_ms` | planned |
| 3. Antigravity tool timeout and epoch idle; runner-own settings and `KAOIRO_RUNNER_SERVER_URL` | planned |
| 4. The three flags | planned |
| 5. Directories | planned |
| 6. Default models | planned |

### 2.7 Production compatibility

Existing `runner.env` keeps working unchanged. It currently sets
`KAOIRO_CODEX_APPROVAL_AXIS` and `KAOIRO_CODEX_OPERATOR_STEER`; once those
migrate (group 4) the runner logs the deprecation warning at each start until
the operator moves them. No file is rewritten by the runner. Behaviour
changes are listed in section 2.1 (decided in section 4); the start-up one is that an invalid
value for a migrated variable of an enabled engine now stops the runner at
start instead of failing each later wrapper launch. No current production
value is affected (the migrated names set there are `"1"` flags, valid under
every grammar above).

### 2.8 Documentation

`docs/reference/configuration/runner.md` gains the table the acceptance
criteria require (variable, config key, type, range, default, reader,
precedence), pinned to the registry. `wrapper.md` replaces "Runner-generated
wrapper configs do not relay these fields" and the "no per-peer env override
or config relay" paragraph. `runner.env.example` marks migrated variables as
deprecated. `docs/reference/protocol/model-effort.md` (the `ext.model_source`
section, lines 38-50) is the source of truth for the `env` tier and is updated
in group 6. Closing issue #438 follows group 1.

## 3. Verification plan

Evidence tier per `rules/verification.md`: committed repository code, so the
normal review flow. Expected outcomes in the validator tests are written as
literal values (for example 59999 rejected, 60000 accepted), not derived from
the shared exports, so a wrongly changed bound cannot keep them green; the
mutations below change a real guard or a real consumer connection, not only an
exported constant.

| Claim | Test | Negative control |
| --- | --- | --- |
| Each key reaches the wrapper from the next launch after a reload | supervisor test: set via `updateRuntimeConfig`, spawn, read the `WrapperConfig` handed to the launcher; a running child's config is unchanged | remove the row from the registry; the test fails |
| An invalid value rejects the reload and the last valid config stays | `watchRunnerConfig` tests per setting: min, max, min-1, max+1, string, boolean, `null`, empty and whitespace string, unsafe and overflow numbers | none beyond the cases |
| Runner acceptance implies identical wrapper acceptance | contract test over the same literal cases against the runner parser and the wrapper's `parseConfig` / `readTurnWatchdogSettings` / `readEpochIdleMs` (the property is one-directional, section 2.1) | change the minimum inside a real reader (`value < minimum`); the test fails |
| Environment contract retained per setting | table-driven against the real wrapper readers and the runner's call of them: `"1e3"` accepted where `Number()` is the grammar and rejected where digits-only is; whitespace-only rejected by every numeric family; empty string unset for numerics and flags but "set" for models and directories; a relative directory and a 257-character model passing through unchanged; no-file plus whitespace variable fails at runner start and is never relayed as absent | swap two grammars, or make the runner treat whitespace as unset: the test fails |
| Environment wins, warns once, shadow warning fires | per key: variable set and file set differently; assert the wrapper receives no config field for that key (the variable is consumed), one deprecation line, one shadow line, no repeat on a second reload. Sequence file=A/variable=B then file=C/variable=B: `changedFields` non-empty, shadow warning emitted, relay still omitted. A rejected reload emits neither a warning nor an "applied" line | unset the variable: file value is relayed, no warning |
| Disabled-engine policy | invalid `KAOIRO_CODEX_*` with Codex absent from `capabilities` starts; the same value with Codex enabled exits non-zero naming the variable | enable Codex by reload with the bad value: reload skipped |
| Flag truth table | the table in section 2.4, run through the real `personaOptInSource` call sites in the Claude and Codex CLIs and read from their startup lines (`operator_steer=`, `approval_axis=`, `[claude phase2 delivery] source=`) | variable `"0"` with config `true`: result is the list outcome |
| Default-model provenance (group 6) | for each of the three engines: no default; file-only default; variable over file; explicit launch pick; stored explicit resume pair; each asserts value and `model_source` | drop the `config.default_model` term: file-only case fails |
| New top-level keys cannot miss the reload diff | compile-time `Record<keyof RunnerConfig, true>` iterated by `changedFields`, plus a test that mutates each key and expects it in the result | add a key to `RunnerConfig` without the entry: typecheck fails |
| Docs table matches the registry | test parses the table in `runner.md` and compares rows | add a registry row without a doc row: the test fails |
| Live heartbeat toggle | transport test flipping the getter mid-connection | none |
| Config-only setup works with the default composition (gate) | one test that injects nothing, below | below |

Default-composition gate. It is a bounded integration smoke test of the
assembly, not a second copy of the input matrix: one non-default setting per
engine, no model turn, and the deterministic tests above keep the full cases.
It starts the real runner entrypoint (`runner-cli`, no substituted
constructors, launcher or consumer) as a child process with a config file that
sets one relay key per engine and `KAOIRO_*` scrubbed from its environment.
`server_url` points at a test-owned local endpoint that speaks just enough of
the Phoenix v2 frame protocol to accept the runner join and push a `spawn`. The
runner launches the built wrapper entrypoint through the real `makeLauncher`.
The assertion is on consumption by the child: the wrapper's startup settings
line (section 2.2, printed from the same resolved-settings object the consumer
receives) must show each value with `source=config`, read from the runner's
inherited stderr.

Child ownership. The test holds the `ChildProcess` of the runner it started,
not the wrappers' `ManagedChild` handles (the runner keeps those). It ends the
run with SIGTERM to that owned runner PID, which makes the runner call
`Supervisor.stopAll` on its tracked wrappers and exit
(`runner-cli.ts:434-447`, `supervisor.ts:1265-1276`); the wrappers inherit the
runner's stdio, so the test waits for the runner's `close` event with a timeout
and fails on timeout. `close` confirms that the runner ended and that its
observed stdio closed; it does not prove that every wrapper exited (a child can
close its inherited stdio and stay alive; measured on Node 24.3.0 by the design
reviewer). The gate therefore relies on the known wrapper lifecycle for child
termination and measures it during implementation on both the success and the
failure path: the wrapper's startup line carries its own pid, and after `close`
the test checks that pid with signal 0 (an existence check, no signal sent) and
fails if it is still alive. No process-table discovery, host reaper or pattern
kill is used, and no product shutdown change is part of this task.

Negative controls for the gate: rebuild the artifact after (a) dropping the
relay (the spread in `resolveWrapperConfig`) and, separately, after (b) cutting
the chosen consumer's config argument. Each rebuilt artifact, run through the
same test invocation, must exit non-zero because the observed consumed
value/source no longer matches, and cleanup must complete on both failure
paths. Neither the relay nor the consumer argument exists in the current
baseline, so these are acceptance criteria for the implementation round, not
measured results.

## 4. Operator decisions (2026-10-02)

Recorded on [issue #469](https://github.com/sakuraiyuta/kaoiro/issues/469#issuecomment-5946655395)
against design commit `2214f655`.

- **Flags** (`KAOIRO_CODEX_OPERATOR_STEER`, `KAOIRO_CODEX_APPROVAL_AXIS`,
  `KAOIRO_CLAUDE_PHASE2_DELIVERY`): migrated here (group 4) with the meaning
  in section 2.4: config `true` is a global opt-in, config `false` is the same
  as absent and does not override a persona-list opt-in, and a variable set to
  a non-`"1"` value such as `"0"` wins over config `true`. Issue #463 consumes
  these keys; the `_PERSONAS` lists stay with #463.
- **Removal of the variable fallback**: no earlier than the release after the
  one that ships the keys, and only once a production start shows no
  deprecation warning. Tracked as a separate follow-up issue (the one-release
  precedent is legacy `personas` and `capabilities: "claude"` in
  `runner/src/config.ts`).
- **Key layout**: section 2.1 (per host, per engine block, flat keys, no
  per-persona).
- **`KAOIRO_RUNNER_SERVER_URL`**: migrated fully, with the same deprecation
  and shadow warnings as the other variables (no exemption). Updating
  `scripts/dev.sh`, `scripts/dogfood.sh`, `runner/deploy/runner.env.example`
  and the docs that name the variable (`docs/reference/configuration/runner.md`,
  `docs/reference/configuration/setup-wizards.md`,
  `docs/operations/runner-install.md`) to use the `server_url` key is part of
  this issue (group 3).
- **Default models and `ext.model_source`**: both sources keep the `env`
  label; `docs/reference/protocol/model-effort.md` is reworded to "operator
  default tier" (group 6). The default stays a fallback: launch picks and
  stored explicit resume pairs keep their priority (section 2.2).
- **`ia_pending_dir`**: migrated with the other directories (group 5). The
  pending directory holds only unbound journals. A new generation deletes the
  same agent's other-generation unbound journals
  (`IaSidecar.#collectOrphanJournals`, `ia_sidecar.ts:435-458`), and `bind`
  moves the current generation's records into the durable session sidecar,
  whose path comes from `resolveSessionPath` and does not depend on this
  directory. No cross-generation pending recovery exists to lose; changing the
  directory only moves where the current generation's unbound journal sits
  until `bind`, and leftover journals in the previous directory are no longer
  collected (small files the operator can delete). No recovery mechanism is
  added.
- **Tightening of an existing contract** (section 2.1): accepted both
  (a) the `epoch_idle_ms` ceiling 2147483647, in the runner and in
  `readEpochIdleMs`, and (b) the runner stopping at start on an already-invalid
  variable of an enabled engine, including a whitespace-only numeric value.
  Ordinary choices inside the migration (JSON numbers for the new numeric
  keys, the shadow warning) need no separate decision.
- **Production rollout**: pending until the operator instructs it directly.
  Neither `runner.env` nor the production `runner.config.json` is touched by
  this work.
