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

- `makeLauncher` (`runner/src/spawn.ts:130`) gives every wrapper a copy of the
  runner's own `process.env`, captured when the runner started. So an
  environment value reaches a wrapper only after a runner restart, and a
  wrapper reads it once at its own startup.
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
| `KAOIRO_IA_PENDING_DIR` | wrapper (`agent-common/ia_sidecar.ts:111`) | behaviour (directory; see Q6) | `ia_pending_dir` (top level) | next lifetime |
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

Observation to settle during the epoch-idle group: `readEpochIdleMs` checks a
minimum only. A value above 2,147,483,647 would reach `setTimeout`, which Node
clamps to 1 ms. The runner-side parser should apply the same maximum the
watchdog readers use; this tightens an input that is currently unbounded.

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

Types and ranges are exactly the current wrapper-side ranges (positive
integers; the four Claude keys 1..60000 / 1..64; watchdog inactivity
60000..2147483647 and abort grace 1..2147483647; `tool_timeout_ms` >= 1000;
`default_model` a non-empty string of at most 256 characters; directories
absolute paths without NUL). An unknown key inside a known block is ignored,
as today; a wrongly typed or out-of-range value throws `ConfigError`, which
the existing reload path turns into "skip the reload, keep the last valid
configuration".

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

### 2.3 `changedFields` cannot lag the schema

Replace the hand-written field list with a `Record<keyof RunnerConfig, true>`
so adding a key to `RunnerConfig` without adding it to the reload diff is a
compile error, and add the registry's top-level keys. This closes the silent
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
- **Flags** (Q1, if migrated): the variable counts only when set and non-empty,
  with today's rule (`"1"` enables, anything else defers to the persona list);
  otherwise the config boolean applies. `personaOptInSource` is unchanged.

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
5. Directories (`turn_trace_dir`, `ia_pending_dir`; Q6).
6. Default models (Q5).

### 2.7 Production compatibility

Existing `runner.env` keeps working unchanged. It currently sets
`KAOIRO_CODEX_APPROVAL_AXIS` and `KAOIRO_CODEX_OPERATOR_STEER`; once those
migrate (group 4) the runner logs the deprecation warning at each start until
the operator moves them. No file is rewritten by the runner. The one behaviour
change: an invalid value for a migrated variable now stops the runner at start
instead of failing each later wrapper launch. No current production value is
affected (the migrated names set there are `"1"` flags).

### 2.8 Documentation

`docs/reference/configuration/runner.md` gains the table the acceptance
criteria require (variable, config key, type, range, default, reader,
precedence), pinned to the registry. `wrapper.md` replaces "Runner-generated
wrapper configs do not relay these fields" and the "no per-peer env override
or config relay" paragraph. `runner.env.example` marks migrated variables as
deprecated. Closing issue #438 follows group 1.

## 3. Verification plan

Evidence tier per `rules/verification.md`: committed repository code, so the
normal review flow.

| Claim | Test | Negative control |
| --- | --- | --- |
| Each key reaches the wrapper from the next launch after a reload | supervisor test: set via `updateRuntimeConfig`, spawn, read the `WrapperConfig` handed to the launcher; a running child's config is unchanged | remove the row from the registry; the test fails |
| An invalid value rejects the reload and the last valid config stays | extend the `watchRunnerConfig` tests for one value per range edge (min, max, min-1, max+1, wrong type) | none needed beyond the edges |
| Runner and wrapper accept and reject the same values | contract test feeding every range edge to the runner parser and to the wrapper's `parseConfig` / `readTurnWatchdogSettings` / `readEpochIdleMs` and asserting agreement; bounds are exported from the engine packages, not retyped | change one bound in one place; the test fails |
| Environment wins and warns once; shadow warning fires | per key: env set and file set to a different value; assert effective value, one deprecation line, one shadow line, no repeat on a second reload | unset the variable; file value applies, no warning |
| Invalid environment value fails fast | startup with a bad value exits non-zero naming the variable; reload with it skipped | none |
| New top-level keys cannot miss the reload diff | compile-time `Record<keyof RunnerConfig, true>`, plus a test that mutates each key and expects it in `changedFields` | add a key to `RunnerConfig` without the diff entry; typecheck fails |
| Docs table matches the registry | test parses the table in `runner.md` and compares rows | add a registry row without a doc row; the test fails |
| Config-only setup starts with the default composition | one contract test that injects nothing: real supervisor and real `makeLauncher`, a config file with relay keys, `KAOIRO_*` removed from the environment, run to the first spawn and assert the 0600 wrapper config the launcher wrote carries the keys and parses with the real wrapper `parseConfig` | put the same key in the environment only and confirm the contract test distinguishes the source |
| Live heartbeat toggle | transport test flipping the getter mid-connection | none |

The default-composition test needs a way to stop the real child (a wrapper
launched against an unreachable server); stop it through its own
`ManagedChild` handle, never by pattern (`rules/command-line.md`). Whether to
use the built `dist/cli.js` or a stub entry is a design-review question.

## 4. Questions for the operator

Recommendation first in each.

- **Q1 - the three flag variables** (`..._OPERATOR_STEER`, `..._APPROVAL_AXIS`,
  `..._PHASE2_DELIVERY`). Recommend migrating them here (group 4): the
  2026-10-01 restart incident was one of these flags, and the lists in issue
  #463 are what a dashboard switch replaces, not the global flags. Alternative:
  leave all six to #463, which keeps flag and list together but leaves the
  incident's cause unfixed until then.
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
  `default_model`) and rewording the reference to "operator default tier",
  rather than adding a fifth source that the server and dashboard must learn.
  Done last (group 6) because it touches the provenance reference.
- **Q6 - `ia_pending_dir`.** The sidecar recovers pending entries for an agent
  by listing this directory, so changing it while an agent has entries loses
  them for the next generation. Recommend migrating it with a documented
  caution (change only while the agent is stopped), or leaving it in the
  environment as a store location like the server's `*_PATH` family (issue
  #470). Operator choice.
