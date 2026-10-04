# Claude Agent SDK 0.3.289 review — 2026-10-04

Issue: [517](https://github.com/sakuraiyuta/kaoiro/issues/517). The wrapper's
range moves from `^0.3.284` to `^0.3.289` (`latest` and `next` on npm at about
10:20 UTC; bundled CLI 2.1.289). Probes and raw logs are in
[`issue-517/`](issue-517/) (`kogane-*` and `kohaku-*`); all of them drive
`query()` against a loopback Messages API with a placeholder key, so no
external model request was made.

## Changelog review

Sources: `CHANGELOG.md` of anthropics/claude-agent-sdk-typescript (0.3.285 to
0.3.289; 0.3.288 and 0.3.289 only state parity with Claude Code) and of
anthropics/claude-code (2.1.285 to 2.1.289).

| Change | Where kaoiro depends on it | Finding |
|---|---|---|
| 0.3.286: a person's priority `now` message moves running shell commands, agents and MCP calls to the background and joins the running turn; CC 2.1.287: it no longer cancels a running web fetch/search | yield `cut` pushes `priority: "now"` | measured below: no difference between 0.3.284 and 0.3.289 in the measured scenarios |
| 0.3.287 / CC 2.1.287: a WebFetch/WebSearch that steps aside returns `tool_use_result: {detachedToolCall: true}` and its result arrives in a later turn | `host.ts` `#toolNames` feeds only the log payload and is cleared at each result; the state machine ignores a tool_result outside `tool_running` and never clears pending ids on foreign ones; tasklist joins cover Task* tools only | read, not measured: the late result's log line has no tool name; state and task counting are unaffected |
| CC 2.1.288: a PreToolUse or PermissionRequest hook whose matching fails now blocks the call | kaoiro's SDK hooks | none has a matcher; user settings matchers are plain tool-name alternations; the repository has no project hooks |
| 0.3.286: an omitted `permissionMode` defers to the settings `defaultMode` | `host.ts` always passes it; `probe.ts` omits it but has `tools: []` and a never-yielding prompt | no effect |
| 0.3.287 `tool_use_result` shapes; 0.3.285 `getSessionMessages()` / `getSubagentMessages()` | — | not read or called by the wrapper or the runner |
| `systemPrompt.snapshot` | ADR-0065 | the option's doc block is identical in both `sdk.d.ts` files |
| CC: resume and compaction fixes, headless SIGTERM with SIGCONT, repeated model fallback | resume, compaction, runner stop | fixes; no contract change |
| 0.3.285 / CC 2.1.288: background commands in unattended sessions stop at 30 min (max 2 h) | Claude peers' own work | announced at rollout; evaluated in issue 520 |

## Mid-turn input (cut and fold)

Node 22.23.3, each case once. "cut" is a pushed user message with
`priority: "now"` and no `origin`, as the wrapper sends it.

| Scenario | 0.3.284 | 0.3.289 |
|---|---|---|
| Bash `sleep 4`, cut at +1 s | tool completes (`is_backgrounded: false`), `result ""` ends the turn, the message starts the next turn | same |
| Same, cut with `origin: {kind: "human"}` | same | same |
| Bash `sleep 20`, cut after `task_started` (Kohaku) | tool completes at 20.5 s; the turn ends; next turn | same |
| SDK MCP tool (10 s), cut at about 3 s (Kohaku) | the call is cut about 6 ms after the push ("interrupted before a result was received"); `result ""`; next turn; the handler runs on and its result is dropped | same |
| Bash `sleep 4`, fold at +1 s | tool completes; the next request carries the "new message while you were working" reminder; one turn | same |
| SDK MCP tool, fold (Kohaku) | waits for the tool; folded; one turn | same |

In these scenarios cut and fold behave the same on both versions. For Bash
the cut matches `delivery.md`; for an SDK MCP call it does not, on either
version (issue 521). Cuts during a subagent or a WebFetch/WebSearch were not
measured (issue 520).

## Model catalog

- The built `probe.ts`, run on this host: 0.3.284 and 0.3.289 both return
  `ok: true`, `source: "init"`, 12 rows. The only difference: 0.3.289 lists
  Fable 5.1 as `value: "fable"` (resolved `claude-fable-5-1`) where 0.3.284 used
  `value: "claude-fable-5-1"`. The wrapper's catalog lookup falls back from the
  exact value to `resolved_model`, so a persisted `claude-fable-5-1` pin still
  validates.
- `Options.model: "opus[1m]"` capture (`catalog-capture.mjs`, init only): on
  0.3.284 it reproduces the existing fixture byte for byte (`b1f649a2…`); on
  0.3.289 it returns the 12 rows with the same Fable change and no `opus[1m]`
  row. Recorded as `claude-agent-sdk-0.3.289-opus-1m.models.json`
  (`ed8f7da0…`).
- The offline fallback fixture (six rows, `e6417b97…`) could not be reproduced.
  An unreachable proxy and a no-network namespace both returned the cached
  12 rows; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` returned five rows,
  identical on both versions; a fresh config directory without network
  returned five rows that differ between the versions only by the Fable alias.
  The 0.3.284 offline fixture is kept as measured on 0.3.284.
- With an `opus[1m]` pick, `system/init` and `getContextUsage()` both report
  `claude-opus-5-5[1m]` on 0.3.284 and on 0.3.289 (`probe-commands.mjs`).

## Slash-command projection

Projected `initializationResult().commands` against live `system/init`
`slash_commands`, isolated config (skills and plugins linked, plugins enabled,
no hooks, no account-provided skills): 99 and 99 on 0.3.284, 100 and 100 on
0.3.289, equal in order on both. No row carried a colon alias, so that branch of
the projection was not exercised here.

## Gates

Node 22.23.3: the claude-code suite passes on 0.3.289 before and after the
fixture change (35 files, 794 tests, exit 0, no unhandled error); the whole
wrapper and runner results are in the
[Codex 0.160.0 record](../codex-app-server/pin-0.160.0-adoption-gates-2026-10-04.md#suites).

## Not measured on 0.3.289

The offline static catalog (condition not reproduced), the outgoing 1M beta
header, the canonical `claude-opus-5[1m]` pin, the `claude-fable-5-1[1m]` pin,
the SIGTERM/SIGKILL escalation timings and the AbortError on `close()`
(measured on 0.3.280), and cuts during a subagent or a WebFetch/WebSearch.
