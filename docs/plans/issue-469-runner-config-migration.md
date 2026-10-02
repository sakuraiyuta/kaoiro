---
title: Move runner/wrapper behaviour settings from KAOIRO_* variables into runner.config.json
status: proposed
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
| `KAOIRO_RUNNER_SERVER_URL` | runner (`config.ts:763`) | wiring, key already exists | `server_url` (existing) | already live; see Q4 |
| `KAOIRO_CODEX_OPERATOR_STEER` | wrapper (`codex/cli.ts:182`) | behaviour flag (see Q1) | `codex.operator_steer` | next lifetime |
| `KAOIRO_CODEX_APPROVAL_AXIS` | wrapper (`codex/cli.ts:188`) | behaviour flag (see Q1) | `codex.approval_axis` | next lifetime |
| `KAOIRO_CLAUDE_PHASE2_DELIVERY` | wrapper (`claude-code/cli.ts:173`) | behaviour flag (see Q1) | `claude_code.phase2_delivery` | next lifetime |

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

Ranges are the current wrapper-side ranges, with one exception (epoch ceiling,
below). Representations are stricter than the wrapper's legacy parser, and
that is deliberate:

| Setting | Range | JSON file value | Environment value (grammar kept from today) |
| --- | --- | --- | --- |
| `claude_code.yield_claim_timeout_ms`, `pending_receipt_root_timeout_ms` | 1..60000 | JSON number, safe integer | `Number(value)` must be a safe integer in range (today's `persona.ts` rule; accepts `"1e3"`) |
| `claude_code.urgent_overtake_limit`, `folds_per_turn` | 1..64 | same | same |
| `permission_timeout_ms` | integer >= 1 | same | `Number(value)` integer >= 1 (today's rule) |
| `*.turn_watchdog_inactivity_ms` | 60000..2147483647 | same | digits only (`^[0-9]+$`), then range (today's rule; `"1e3"` rejected) |
| `*.turn_watchdog_abort_grace_ms` | 1..2147483647 | same | digits only, then range |
| `antigravity.tool_timeout_ms` | 1000..2147483647 | same | digits only, then range |
| `antigravity.epoch_idle_ms` | 1000..2147483647 (**new ceiling**) | same | digits only, then range |
| `*.default_model` | non-empty string, at most 256 characters | string | same string |
| `codex.turn_trace_dir`, `ia_pending_dir` | absolute path, no NUL | string | same string |
| `log_phoenix_heartbeats` | boolean | `true` / `false` | exactly `"1"` is on; any other value is off (today's rule) |

- In `runner.config.json` a numeric setting must be a JSON number. Strings,
  booleans, `null`, arrays and objects are rejected, as are `NaN`/infinite
  and unsafe integers. This is stricter than `parseConfig` in the wrapper,
  which today coerces `"3"` and `true` for the four Claude fields. The runner
  always writes a JSON number into the wrapper config, so the relay path never
  meets that coercion. A directly launched wrapper keeps its current
  acceptance (compatibility). The checked property is one-directional: every
  value the runner accepts, the wrapper accepts identically.
- An empty or all-whitespace environment value counts as unset, as today.
  A set value that fails its grammar is invalid and never silently falls back
  to the file value.
- **Intentional behaviour changes** (director/operator judgment, Q7): the
  epoch-idle ceiling, applied in the runner parser and in `readEpochIdleMs`
  (so a direct launch is tightened too); strict JSON types in the runner file;
  an invalid override for an enabled engine now stops the runner at start
  (section 2.7).
- **Disabled engines**: environment overrides are read, validated and warned
  about only for engines in the effective `capabilities` (top-level rows
  always). A bad `KAOIRO_CODEX_*` value on a host with Codex disabled cannot
  affect anything and does not stop the runner. File values are validated
  regardless, as the `codex` / `antigravity` blocks are today. Enabling an
  engine by reload whose override is invalid skips that reload.

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
direct launch behaves as before). For a runner-launched wrapper the runner has
already put the winning value (variable over file) into the config field, so
that wrapper never reaches its own environment fallback for a key either
source set.

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

Each wrapper also logs one startup line listing the behaviour settings it
resolved, each with its source (`config`, `env`, `default`), next to the
existing summary lines. It is operator-visible and is what the
default-composition gate in section 3 observes. It never prints a secret;
no setting here is one.

### 2.3 `changedFields` cannot lag the schema

Replace the hand-written field list with a constant
`Record<keyof RunnerConfig, true>` and make `changedFields` iterate that very
object's keys, so adding a key to `RunnerConfig` without adding it to the
reload diff is a compile error. (The reviewer's TypeScript 5.9.3 probe
rejected an omitted optional key with TS2741; nested blocks are already
whole-object comparisons, so no nested list is needed.) This closes the silent
no-op described above as a class, not a single instance.

### 2.4 Precedence and the wrapper's existing `config ?? env`

- **Runner**: `effective = env if set and non-empty, else file value`. One
  function, `applyEnvOverrides(config, env, warn)`, generalises
  `applyServerUrlOverride` and runs at startup and on every reload, so the
  effective config (file merged with environment) is what `changedFields`,
  `buildRegister` and the relay see. An invalid environment value throws
  `ConfigError` naming the variable, at startup (the runner exits non-zero) and
  on reload (reload skipped), the same contract `KAOIRO_RUNNER_SERVER_URL` has.
- **Runner-launched wrapper**: receives one concrete resolved value in its
  config file. The wrapper's existing `config ?? env` is then never reached
  for a key either source set, so "variable wins" holds without changing the
  wrapper's parser, and a wrapper never warns on its own.
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
  Warning (b) is decided from the raw file value, before the effective-config
  diff. The runner keeps the previous accepted raw file values, separate from
  the effective config, and compares against them at the top of the reload
  handler. So file=A with env=B followed by file=C with the same env=B has an
  empty effective diff (`changedFields` returns early) and still warns. The
  stored raw values advance only on an accepted reload; a rejected reload
  warns about nothing and is not reported as applied.
- **Flags** (Q1, if migrated). `personaOptInSource(personaId, flag, list)`
  takes a string: only `"1"` enables globally and every other value defers to
  the persona list (the reviewer's probe: `"0"` and `"false"` both returned
  `persona_list` for a listed persona). A JSON boolean cannot carry that
  distinction, so the contract is: config `true` means "global opt-in" (the
  same as the variable being `"1"`); config `false` and absent are the same,
  "no global opt-in", and never override a persona-list opt-in. The wrapper
  builds the `flag` argument as: the variable if set and non-empty (passed
  through verbatim), else `"1"` when the config field is `true`, else
  undefined. The Codex backend gate (`backend === "app-server"`) is evaluated
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
  issue's "variable wins" rule and is part of Q1.

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

1. Common path (registry, `applyEnvOverrides`, relay parameter, exhaustive
   diff) with the four Claude scheduler keys. Closes issue #438.
2. Turn watchdogs (6) and `permission_timeout_ms`.
3. Antigravity `tool_timeout_ms`, `epoch_idle_ms`; `log_phoenix_heartbeats`.
4. The three flags (if Q1 says migrate).
5. Directories (`turn_trace_dir`, `ia_pending_dir`).
6. Default models (Q5).

### 2.7 Production compatibility

Existing `runner.env` keeps working unchanged. It currently sets
`KAOIRO_CODEX_APPROVAL_AXIS` and `KAOIRO_CODEX_OPERATOR_STEER`; once those
migrate (group 4) the runner logs the deprecation warning at each start until
the operator moves them. No file is rewritten by the runner. Behaviour
changes are listed in section 2.1 (Q7); the start-up one is that an invalid
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
| Environment grammar per setting | table-driven: `"1e3"`, `"0x10"`, `" 5 "`, empty, overflow, negative against each grammar in the 2.1 table, including an invalid override beside a valid file value (fails, never falls back) | swap two grammars; the test fails |
| Environment wins, warns once, shadow warning fires | per key: env set and file set differently; assert effective value, one deprecation line, one shadow line, no repeat on a second reload. Sequence file=A/env=B then file=C/env=B: effective diff empty, shadow warning still emitted. A rejected reload emits neither a warning nor an "applied" line | unset the variable: file value applies, no warning |
| Disabled-engine policy | invalid `KAOIRO_CODEX_*` with Codex absent from `capabilities` starts; the same value with Codex enabled exits non-zero naming the variable | enable Codex by reload with the bad value: reload skipped |
| Flag truth table | the table in section 2.4, run through the real `personaOptInSource` call sites in the Claude and Codex CLIs and read from their startup lines (`operator_steer=`, `approval_axis=`, `[claude phase2 delivery] source=`) | variable `"0"` with config `true`: result is the list outcome |
| Default-model provenance (group 6) | for each of the three engines: no default; file-only default; variable over file; explicit launch pick; stored explicit resume pair; each asserts value and `model_source` | drop the `config.default_model` term: file-only case fails |
| New top-level keys cannot miss the reload diff | compile-time `Record<keyof RunnerConfig, true>` iterated by `changedFields`, plus a test that mutates each key and expects it in the result | add a key to `RunnerConfig` without the entry: typecheck fails |
| Docs table matches the registry | test parses the table in `runner.md` and compares rows | add a registry row without a doc row: the test fails |
| Live heartbeat toggle | transport test flipping the getter mid-connection | none |
| Config-only setup works with the default composition (gate) | one test that injects nothing, below | below |

Default-composition gate. It starts the real runner entrypoint
(`runner-cli`, no substituted constructors, launcher or consumer) as a child
process with a config file that sets one relay key per engine and `KAOIRO_*`
scrubbed from its environment. `server_url` points at a test-owned local
endpoint that speaks just enough of the Phoenix v2 frame protocol to accept the
runner join and push a `spawn`. The runner then launches the built wrapper
entrypoint through the real `makeLauncher`. No model turn is requested. The
assertion is on consumption by the child: the wrapper's startup settings line
(section 2.2) must show each value with `source=config`, read from the runner's
inherited stderr. Cleanup stops each child through the `ManagedChild` or
`child_process` handle the test itself holds, never by pattern
(`rules/command-line.md`); the design reviewer measured that this works with
`makeLauncher` and a built Claude entrypoint.

Negative controls for the gate, each run through the same invocation and
required to fail it with the child process still started and cleaned up:
(a) break the relay (drop the spread in `resolveWrapperConfig`); (b) break one
consumer (stop `cli.ts` passing the config argument). Separately, deterministic
injected tests keep covering the semantics above; they are not a substitute
for the gate.

## 4. Questions for the operator

Recommendation first in each.

- **Q1 - the three flag variables** (`..._OPERATOR_STEER`, `..._APPROVAL_AXIS`,
  `..._PHASE2_DELIVERY`). Recommend migrating them here (group 4): the
  2026-10-01 restart incident was one of these flags, and the lists in issue
  #463 are what a dashboard switch replaces, not the global flags. Alternative:
  leave all six to #463, which keeps flag and list together but leaves the
  incident's cause unfixed until then. If migrated, the operator also approves
  the meaning in section 2.4: config `true` is a global opt-in, config `false`
  is the same as absent and does not override a persona-list opt-in, and a
  variable set to a non-`"1"` value such as `"0"` wins over config `true`
  (the list then decides).
- **Q2 - when the variable fallback is removed.** Recommend: not before the
  release after the one that ships the keys, and only once a production
  startup shows no deprecation warning. This follows the one-release-cycle
  precedent for legacy `personas` and `capabilities: "claude"` in
  `runner/src/config.ts`. Tracked as a separate follow-up issue.
- **Q3 - key layout.** Recommend section 2.1 (per host, per engine block,
  flat keys, no per-persona).
- **Q4 - `KAOIRO_RUNNER_SERVER_URL`.** It already has a config key. Following
  the decision literally, it would now warn on every start, and
  `scripts/dev.sh`, `scripts/dogfood.sh` and service units set it on purpose
  (issue #135). Recommend: no deprecation warning for this one variable, kept
  as a documented deployment override; the other variables warn.
- **Q5 - default models and `ext.model_source`.** `ModelSource` is
  `launch | env | config | default` and the `env` tier means "engine-specific
  environment". A runner-config default sits in that same tier. Recommend
  keeping the `env` label for both (value = variable if set, else
  `default_model`) and rewording the source-of-truth reference
  (`docs/reference/protocol/model-effort.md`) to "operator default tier",
  rather than adding a fifth source that the server and dashboard must learn.
  This is a meaning change for `env` and needs the operator's agreement. The
  default stays a fallback: launch picks and stored explicit resume pairs keep
  their priority (section 2.2). Done last (group 6).
- **Q6 - `ia_pending_dir`.** Settled by measurement; no operator choice is
  needed unless they prefer to defer. The pending directory holds only unbound
  journals. A new generation deletes the same agent's other-generation unbound
  journals (`IaSidecar.#collectOrphanJournals`, `ia_sidecar.ts:435-458`), and
  `bind` moves the current generation's records into the durable session
  sidecar, whose path comes from `resolveSessionPath` and does not depend on
  this directory. So no cross-generation pending recovery exists to lose (the
  design reviewer's filesystem probe: generation 2 in the same directory
  recovered zero records of generation 1; a bound session stayed readable after
  the next generation used a different pending directory). Changing the
  directory affects only where the current generation's unbound journal sits
  until `bind`, and the previous directory's leftover journals are no longer
  collected (small files the operator can delete). Recommend migrating it with
  the other directories (group 5). This plan adds no cross-generation recovery.
- **Q7 - intentional behaviour changes** (section 2.1), for the operator's
  judgment before implementation: (a) `epoch_idle_ms` gets the 2147483647
  ceiling, in the runner and in the wrapper reader (a direct launch is
  tightened too); (b) numeric settings in `runner.config.json` must be JSON
  numbers (strict), where the wrapper's own parser still coerces strings and
  booleans for direct launches; (c) an invalid override for an enabled engine
  stops the runner at start; (d) a shadow warning is logged when a file edit is
  hidden by a variable. Recommend accepting all four.
