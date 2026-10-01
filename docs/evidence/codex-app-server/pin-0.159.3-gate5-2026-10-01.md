# Codex 0.159.3 model availability: gate 5

Date: 2026-10-01. Issue: [468](https://github.com/sakuraiyuta/kaoiro/issues/468).
This record covers gate 5 only; it is not approval to adopt or deploy the pin.

## Observations

All four authorized attempts completed, each returning `GATE5_OK`. Each rollout
contains exactly one `task_started` and one `turn_context`; the latter records
the requested model and `effort: low`. No tool calls were observed. All four
probe processes exited 0. No model rejection, authentication failure, refresh
failure or unhandled error was observed. There was no retry or model fallback
in the probe.

| Backend | Model | Native start observed (UTC) | Terminal | Exit |
| --- | --- | --- | --- | --- |
| exec | gpt-6-sol | 2026-10-01T03:53:31.508Z | turn.completed | 0 |
| exec | gpt-6.1-sol | 2026-10-01T03:53:49.813Z | turn.completed | 0 |
| app-server | gpt-6-sol | 2026-10-01T03:54:08.850Z | turn.completed | 0 |
| app-server | gpt-6.1-sol | 2026-10-01T03:54:22.801Z | turn.completed | 0 |

These are observer receipt timestamps: exec emits `turn.started`; app-server
emits `turn/started`. The manifest also preserves the app-server native
`startedAt` / `emittedAtMs` and rollout `task_started` timestamps. A start alone
is not evidence of model acceptance; the completed answer supplies that check.

Each attempt emitted the same wrapper warning:
`codex: warn — auth mode is unknown; model catalog is empty`.
The injected launch config omitted catalog-only `codex_auth_mode`; the actual
CLI used the independently authenticated ChatGPT home. Explicit model and effort
still reached the native turn, as recorded in `turn_context`. This experiment
does not verify dashboard catalog advertising or auth-mode discovery.

## Composition and isolation

The disposable tool calls the built production `runCodexCli`, with the real
`CodexHost`, SDK, app-server runtime, startup and bridge composition. Its config
and server endpoint are injected through existing seams. The existing
`test/fixtures/phoenix_loopback.ts` provides only a local kaoiro connection and
persona prompt; it does not emulate the model provider. Host observations
forward existing callbacks unchanged. The observer closes the host only after
`onTurnFinalized`, and records native stdout start/terminal events independently.

Both backends resolve the installed native binary to an absolute path. The
observer asserts the real path and explicit `CODEX_HOME` on each Codex spawn.
The candidate binary SHA-256 is
`8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`.
The home is `<scratch-home>/codex-468-v1593` (mode 0700), with isolated ordinary
`HOME=<evaluation-scratch>/operator-home-v1593`. The director reported a
successful `login status` using this same binary and homes before authorization.
The evaluator did not read or copy `auth.json`, nor access the production home.

Every invocation uses an empty inherited environment (`env -i`), adding only
PATH, HOME, CODEX_HOME and LANG. Launch config explicitly selects the backend,
model, low effort, `danger-full-access`, network access, and disables internal
subagents. The single prompt is `Do not use tools. Reply with exactly GATE5_OK.`
Operator steer and approval-axis environment opt-ins are absent; their behavior
belongs to the remaining acceptance gates. No live production server is contacted.

The built code is commit `0aa961238e8411e9b8161a11ba26ae1d3d950ea9`, with
HEAD `65b6bff269590e8acfe83ca73afcfa9abd2e2f37` at measurement. Only the backup
design differs between those commits. The SDK newline patch is present. The
preparation manifest and relevant built artifact hashes are bound in the
[gate manifest](pin-0.159.3-gate5-2026-10-01.json).

## Controls and retained evidence

The `gpt-6-sol` attempts are positive account/transport controls, one per backend.
The disposable acceptance checker requires a completed terminal, no turn error,
and the expected response. Before live execution its terminal-failure and
missing-response negative controls passed (checker self-test exit 0). Each
attempt writes an exclusive marker to prevent an accidental repeated invocation.
No extra live negative model turn was used. Total budget: 4 authorized, 4 used,
0 remaining.

The manifest records every rollout's path relative to the authenticated home,
its SHA-256, raw observation and process log hashes, and the disposable tool and
reused fixture hashes. Full logs remain under
`<evaluation-scratch>/logs/gate5-*.log` and
`<evaluation-scratch>/gate5/<backend>-<model>/` for review; the observer excludes
account RPC responses. `text` in the scratch result combines the assistant log
and result log, so `GATE5_OKGATE5_OK` there represents one answer observed twice,
not two turns. Native events and rollout counts distinguish these.

## Interpretation and limits

Gate 5 passes for this candidate, account and measurement time: both backends
can use `gpt-6.1-sol / low`. This does not establish that the client version alone
caused the earlier rejection on 0.156.1. The account, login context and service
state were not controlled in a simultaneous old/new experiment. No additional
server-resolved model identity was observed beyond the native `turn_context`;
its service-tier field was null.

The remaining adoption gates, backup design review, migration/rollback evidence
and implementation review remain open. No deployment is performed. Retain the
candidate authentication home and evaluator-owned scratch for those authorized
follow-up steps and review; cleanup requires the director's disposition.
