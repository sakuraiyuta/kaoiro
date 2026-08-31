---
title: Phase 28 — Self-awareness of context fatigue and agent-initiated session operations (issue #158)
description: Enable an agent to recognize its own context usage and initiate recovery operations equivalent to /compact, /new, and /clear. This plan reduces Phase A (visualization) and the spike to implementation detail. Phase B (agent-initiated compact) / C (agent-initiated new and clear) are supplements based on the spike and Phase A results.
status: done
phase: 28
depends_on: [21, 27]
last_updated: 2026-08-21
---

# Phase 28 — Self-awareness of context fatigue and agent-initiated session operations

## Goal

Implement [issue #158](https://github.com/sakuraiyuta/kaoiro/issues/158).
The design decisions have been approved by マスター
([#158 issuecomment-5384365227](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365227)).
This plan reduces those decisions to an implementable level of detail; it does
not change the decisions themselves.

## Confirmed premises (do not change)

| # | Decision | Source |
|---|---|---|
| P1 | The SDK has no `compact()` control API. Trigger it with the `/compact` prompt string (slash-command interpretation). Detect completion with `SDKCompactBoundaryMessage` | #158 comment-5384365227 (1) |
| P2 | Do not use a two-axis permission mapping. The initial form is “compact = light / new and clear = heavy; permission_broker approves every request” | same (2) |
| P3 | Fatigue detection is hybrid (the wrapper sends a notice only when its mechanical threshold is exceeded → the agent decides). Do not display context continuously (context anxiety). Set the threshold from measurements after Phase A | same (3) |
| P4 | Agent-initiated new/clear is a deferred reset (fires at the turn boundary). Retain ADR-0036 F6's automatic-interrupt / queue rejection | same (4) |
| P5 | Do not define a permanent director role. Use an operator instruction each time + permission_broker approval each time | same (5) |
| P6 | Do not mechanize a handoff summary. Compact includes summarization; for new/clear, the operating guideline is that the agent externalizes it beforehand | same (6) |

## Track structure

| Track | Content | Owner | Status |
|---|---|---|---|
| S | spike: measure whether `/compact` is interpreted as a slash command on the Claude wrapper path (SDK streaming input) | もも | completed (it is interpreted — see “Track S measurement results”) |
| A1 | Compact visualization: process `compact_boundary` / `status(compacting, compact_result)` / `conversation_reset` in the wrapper and show them to the operator | あお | completed (6941f3e + 1c57045 + ae2c3b5, review passed) |
| A2 | Add `context` to whoami (minimum self-awareness implementation) | あお | completed (same) |
| R | Design review (this plan + decision record) / A1+A2 diff review | ふじ | completed (MF1 detected as one must-fix → confirmed fixed by ae2c3b5, approved for push) |
| B | Agent-initiated compact (threshold notice + agent decision + trigger path) | unassigned | Detail after Phase A |
| C | Agent-initiated new/clear (ADR-0036 F1/F6 revision + new control event + deferred reset) | unassigned | Detail after Phase B |

## Track S — /compact spike (もも)

ADR-0036 Context says “does not go through the CLI native slash-command
parser” based only on Codex measurements, while the official SDK guide clearly
says that `query({prompt: "/compact"})` runs as a slash command (a conflict).
Measure the Claude side.

- Procedure: use a scratch script (outside the repository or in an untracked
  area) to start `query()` from `@anthropic-ai/claude-agent-sdk` in streaming
  input mode, build context through several ordinary message round trips, and
  then send `/compact` on the same stream.
- Observation points: whether `SDKCompactBoundaryMessage` (`type:"system"`,
  `subtype:"compact_boundary"`) arrives; actual values of
  `compact_metadata.trigger` / `pre_tokens`; whether `SDKStatusMessage` has
  `compacting` / `compact_result`; and whether `/compact` is passed to the model
  as an ordinary user turn (determine from the response).
- Additional observation (if time permits): call `getContextUsage()` before and
  after compact and see whether used_tokens decreases.
- Deliverable: report the measurement log + judgment (interpreted / not
  interpreted / conditional) to me. Do not commit the code.

## Track A1 — compact visualization (あお)

Currently `wrapper/claude-code/src/adapter.ts:91-93` handles only `init` among
system messages, and status reading around `:321` is limited to permissionMode /
fast_mode. Compaction therefore produces nothing in kaoiro.

- When `SDKCompactBoundaryMessage` (`subtype:"compact_boundary"`,
  `compact_metadata.trigger/pre_tokens`) arrives, emit a log event visible to
  the operator (follow the existing log-emission pattern; update
  `docs/specs/protocol.md` if a wire change is needed).
- **Decision (2026-07-28, confirmed after あお's proposal):** Because `LogKind`
  is a closed set of 4 values, add log kind `"system"` to
  `protocol/src/index.ts` and the dashboard (option C). Reusing an existing kind
  (pretending to be assistant/tool_result) was rejected because it would amplify
  semantic errors when the same path is used in Phase B. The server passes kinds
  through without validation, so it needs no change. Split commits into (i)
  protocol/dashboard vocabulary and (ii) wrapper visualization + A2.
- Put actual boundary metadata (pre_tokens / post_tokens) on the log event. The
  boundary metadata is authoritative for compact success and reduction amount
  (Track S measurement: `getContextUsage()` immediately afterward does not
  reflect the reduction).
  **However, `post_tokens` is optional in the SDK type (`post_tokens?: number`)
  and is not guaranteed to be present. Do not assume “before N → after M” in the
  display; construct it conditionally from fields that exist** (when absent,
  degrade to only `前 N tokens`). In the 2026-07-28 live acceptance,
  `post_tokens` was present on the in-process `SDKCompactBoundaryMessage`, and
  the dashboard displayed `前 293221 tokens → 後 9187 tokens`. The missing case
  itself was not observed (see the artifact difference in “Live acceptance
  results” below).
- **Log convention (ふじ suggestion adopted):** For success, treat
  `compact_boundary` as authoritative and emit one line (`trigger`, `pre_tokens`,
  optionally `post_tokens` / `duration_ms`). Do not emit a second success line
  for `compact_result:'success'`. For failure, clip `compact_error` using the
  existing log limit. Include `new_conversation_id` in an operator-only log for
  `conversation_reset`. Do not include unknown internal metadata such as
  `preserved_*`.
- Log `compact_result: 'failed'` + `compact_error` from `SDKStatusMessage` as an
  error. Reflecting `SDKStatus = 'compacting'` in state is optional (if adding a
  state vocabulary is required, defer it and use logs only for now).
- After receiving compact_boundary, kick `#refreshContextUsage()` so the
  `ext.context` meter updates to the post-compact value (follow the existing
  guard conventions — inflight / generation / dedup).
- Process `SDKConversationResetMessage` (`type:'conversation_reset'`) into logs
  as well (do not drop it even though it is rare).

## Track A2 — add context to whoami (あお)

Currently `WhoamiSnapshot` (`wrapper/agent-common/src/inter_agent.ts:40-55`)
has no `context`, so an agent cannot see its own context (the peer's is visible
through `list_agents`, creating an asymmetry).

- Add `context?: {used_tokens, max_tokens,
  used_percentage}` to `WhoamiSnapshot` (the 3 wire fields remain as in ADR-0040
  D4).
- In snapshot generation on the claude-code host
  (`claude-code/src/host.ts:487-497` vicinity), include the retained `#context`.
  Omit it when null (retain the absent = unknown vocabulary).
- Do not include it on the codex host (supports_context_usage=false, so keep
  omitting it).
- Add an explanation of the context field to `WHOAMI_DESCRIPTION` (the tool
  description). Do not encourage constant checking (P3: avoid context anxiety;
  say roughly to inspect it when needed for delegation decisions or operator
  reports).
- **(ふじ suggestion adopted):** State in the description and spec that the
  returned value is the last successful snapshot and whoami itself does not
  refresh it ("cached last successful measurement; whoami itself does not
  refresh"). This prevents false precision. Do not add on-demand refresh.
- Update the whoami section of `docs/specs/protocol-inter-agent.md`.

## Common Track A completion conditions

- `cd wrapper && pnpm test && pnpm typecheck` is green (add tests alongside the
  existing suite).
- **(ふじ must-fix, 2026-07-28)** Since option C touches protocol/dashboard,
  also make `protocol`: `pnpm typecheck` and `dashboard`: `pnpm check && pnpm test`
  green (including a render test for the system kind).
- Limit changes to the scope above (threshold notice, MCP tool addition, and
  server changes belong to Phase B/C; no scope creep).
- Use Japanese conventional commits and add explicit paths. クロエ instructs the
  push after Track R review passes.

## Track R — review (ふじ)

- First: read this plan and the decision record in #158 comment-5384365227, and
  identify design gaps (especially P3's anxiety avoidance, A2's disclosure
  scope, and A1's log granularity).
- Second: review the A1+A2 diff (small scope), distinguishing must-fixes from
  suggestions, and report to クロエ.

## Track S measurement results (もも, 2026-07-28)

Environment: SDK 0.3.220 / Claude Code CLI 2.1.220, streaming input mode
(`persistSession:false`, model haiku, tools empty). After 3 ordinary turns, send
the string `/compact` on the same stream. The script was outside the repository
(uncommitted).

- **`/compact` is interpreted as a slash command** (also in streaming input).
  There was no sign that it was passed to the model as an ordinary user turn.
- Event order: `system/status {status:'compacting'}` →
  `system/status {status:null, compact_result:'success'}` →
  `system/compact_boundary` → an empty `result (success)`.
- Actual `compact_metadata`: `{trigger:'manual', pre_tokens:22315,
  post_tokens:882, cumulative_dropped_tokens:21433, duration_ms:13692}` (more
  fields than the SDK type definition). Manual compact took about 13.7 seconds.
  **Duration depends on context size; this 13.7 seconds was for the small
  context of about 22k tokens** (the live acceptance below used about 293k
  tokens and took 168.8 seconds).
- **Caveat:** immediately after compact, `getContextUsage()` returned totalTokens
  23,247/200,000 and did not reflect the reduction (the boundary reported
  post_tokens 882). **Use boundary metadata as the authority for compact success
  and reduction; do not depend on the immediate `getContextUsage()` value** —
  A1's refresh kick is for eventual meter update.
- `compact_result:'failed'` / `compact_error` were not reproduced (the
  implementation should defend according to the type definition).
- Consequence: revise ADR-0036 Context's “does not go through the CLI native
  slash-command parser” to a Codex-only statement (add an ADR supplement when
  starting Phase B).

## Phase B — agent-initiated compact (detailed 2026-07-28, クロエ ruling)

Design direction: **keep it within wrapper + docs** (no server / protocol-wire
change).

| Track | Content | Owner |
|---|---|---|
| B1 | Threshold notice: when `#context` updates, the wrapper mechanically detects it and injects one notice to the agent above the default 70% threshold | あお (completed: f772277, not pushed) |
| B2 | MCP tool `request_compact`: permission_broker approval each time → after approval the wrapper puts `/compact` into the instruction queue | あお (completed: 7748a2f, not pushed) |
| B3 | Supplement ADR-0036 Context's “does not go through the CLI native slash-command parser” as Codex-only, based on Track S measurement | もも (completed: 879db29, not pushed) |
| BR | B1–B3 diff review | ふじ (completed: 3 groups of must-fixes + 2 suggestions → see “BR findings and fixes” below) |

Confirmed implementation decisions (2026-07-28, クロエ approval):

- Place the descriptor in `claude-code/src/request_compact.ts` (co-location with
  inter_agent.ts would expose it to the codex stdio bridge; structure, rather
  than a Claude-only conditional, enforces the engine boundary).
- Use the tool's `reason` only in the approval dialog / tool result; do not
  concatenate it into the injected text (only the fixed literal `/compact`;
  block input-stream injection from the model; pin this in tests).
- Use the canUseTool path (`READ_ONLY_TOOLS` is not registered) with the existing
  permission_broker. Do not create a new path that calls the broker directly.
- Make the threshold a constant + TODO (configuration wiring touches
  `WrapperConfig` = protocol wire, so defer it).
- Known limitation: the “approve → execute / reject → do not execute” branch
  itself depends on the SDK calling canUseTool and cannot be exercised by unit
  tests (the same existing limitation as send_to_agent). Confirm it in live
  acceptance.

### BR findings and fixes (ふじ, 2026-07-28; decision: do not push → adopt all)

- **MF1 — false notice from a stale value immediately after the boundary.** A
  refresh immediately after `#invalidateContextEpoch()` can return a pre-compact
  value (Track S measurement). That value reached the new epoch's threshold
  decision, allowing a second notice immediately after compact. Existing tests
  had **pinned this incorrect behavior**, so the tests were rewritten too.
  Response: redesign in MF1-R below (the initial “use the previous epoch's final
  reading as baseline” response was invalid).
- **MF2 — the B1 notice bypassed serialization.** Operator / inter-agent / B2 use
  cli.ts's instruction chain, but B1 called `host.send` directly. Response: add
  `AgentHostOptions.enqueueInjection` and inject through cli.ts's single chain
  (`enqueueInstruction`). Recheck the epoch when the chain arrives and drop it;
  re-arm only on failure in **the same generation** (a delayed rejection from an
  old epoch must not roll back the new epoch's budget).
- **MF3 — wording contradicted measurement.** Remove promises of “about a dozen
  seconds” and “before/after token counts” from `request_compact`'s description /
  tool result, and say that it may take minutes depending on context size and
  completion is observed in the boundary log. Also change
  `protocol-inter-agent.md`'s “measured ~13.7 seconds” to context-dependent
  wording and fix its broken ADR-0036 link.
- **S1** — Move `READ_ONLY_TOOLS` to `read_only_tools.ts` (importing cli.ts runs
  `main()` and prevents tests from reading it), and directly pin that
  `REQUEST_COMPACT_TOOL_FQN` is absent. The actual approval gate is precisely
  absence from the auto-allow default, so pin that absence in a test.
- **S2** — Replace the live-acceptance wording “using only the whoami value” with
  the fact that B1 also reads the same cached context measurement as whoami.

#### MF1-R — baseline-gate redesign (ふじ re-review, 2026-07-28)

The initial response, “use the previous epoch's final `used_tokens` as baseline
and confirm with a reading below it,” satisfied neither **safety nor liveness**.
ふじ demonstrated two counterexample sequences:

1. **False notice with a null baseline** — if there was no successful reading in
   the previous epoch, baseline is null and treated as confirmed, but a fresh call
   immediately after the boundary can still return a stale pre-boundary high
   value. There is no gate.
2. **Permanent mute by jumping over the baseline** — observations are discrete,
   so a sequence where no post-boundary reading ever falls below baseline is
   ordinary (a large turn / attachment may intervene, or initial context after a
   reset may be at least baseline). The initial claim that it must fall below
   baseline before it can rise again was wrong. A valid notice in that epoch would
   be muted forever.

Redesign (`#contextEpochGate`). **Do not make a magnitude comparison alone the
confirmation condition**:

- The basis is boundary metadata, not a cached reading. If `post_tokens` exists,
  use it (it is the exact total for the new epoch, so confirm with `<=`); otherwise
  use `pre_tokens - 1` (a value at least pre cannot be distinguished from stale).
  Use null for events with neither, such as `conversation_reset`.
- Even without the above, confirm when the epoch reaches its
  `CONTEXT_EPOCH_SETTLE_READINGS` (= 3rd) reading. This provides liveness and
  closes counterexample 2. Three adds one turn of slack to Track S's “one stale
  reading immediately after the boundary.” False notices are bounded to one at a
  one-turn delay, favoring one approval dialog.
- Establish the gate only in `#invalidateContextEpoch()`. Do not mute again after
  confirmation.

Mutation check: reverting to the initial semantics makes both counterexample
tests fail; disabling the metadata fast path makes the post_tokens test fail.

### B1 — threshold notice

- Decision point: where `#context` is updated (after a successful refresh).
  Default threshold 60% (`used_percentage >= 60`). The Phase B 70% value was
  withdrawn by the マスター ruling for issue #162 P4 (2026-07-29). Make it
  configurable if override wiring is light; otherwise a constant + TODO is fine.
- Inject **once per epoch** (dedup; release it in `#invalidateContextEpoch`).
  Prohibit reinjection on every turn and continuous display (P3: avoid context
  anxiety).
- Use neutral wording such as “Context reached N%. You can use request_compact
  for recovery; decide at a natural stopping point.” Do not create urgency.
- Use the existing instruction queue and preserve serialization without colliding
  with operator instructions. **BR MF2 corrected this to cli.ts's single chain
  (`enqueueInjection`).**
- **BR MF1 / MF1-R:** do not decide from an unconfirmed reading immediately after
  an epoch boundary. Confirm based on boundary metadata (`post_tokens`, or
  `pre_tokens` when absent), or upon the third reading after the boundary. A
  magnitude comparison alone can cause permanent mute.

### B2 — request_compact tool

- A wrapper-local MCP tool (co-located with the 3 tools in `inter_agent.ts`). No
  input, or an optional reason string.
- Flow: tool call → request operator approval through permission_broker (the
  ADR-0028 D4 pattern, P2-compliant) → on approval, put `/compact` into the
  instruction queue (the queue naturally guarantees the turn boundary and does
  not conflict with ADR-0036 F6) → return “reservation accepted” in the tool
  result (observe completion in the boundary log).
- On rejection, say so in the tool result. Follow the existing
  permission_broker convention for timeout (wait indefinitely if unset).
- Do not implement an 85% automatic fallback on the kaoiro side. Use the SDK
  native autoCompact as the final defense (without contradicting P2's all-request
  approval principle).
- Do not expose the tool on the codex wrapper (no compact path; assume engine-side
  auto-compaction).
- Add the tool specification to `docs/specs/protocol-inter-agent.md` (do this in
  B2; avoid overlapping files with B3's ADR).

### Common Phase B completion conditions

- Wrapper tests/typecheck are green (test B1 dedup and B2 approval / rejection /
  injection).
- Manual compact duration depends on context size (measurements: 13.7 seconds @
  ~22k tokens / 168.8 seconds @ ~293k tokens). In production-sized contexts it
  may take several minutes. During execution it is observable through the
  existing `status:compacting` log (Phase A), so do not introduce new state
  vocabulary. `request_compact`'s tool description also makes no duration promise
  (only “runs at the next turn boundary”); retain that wording.
- Push after BR passes. The 2026-07-28 BR decision was **do not push** (3 groups
  of must-fixes). Keep it unpushed until the fix delta passes re-review.

## Live acceptance results (あお, 2026-07-28)

The end-to-end B2 “approval → execute / rejection → do not execute” branch was
performed in あお's production session because unit tests cannot exercise it (the
“known limitation” above).

- **All B2 stages succeeded:** `mcp__kaoiro__request_compact` call → canUseTool →
  permission_broker → operator (マスター) approval → handler puts `/compact` into
  the instruction queue → returns reservation accepted in the tool result →
  compact executes at the next turn boundary → completes. `reason` was echoed in
  the tool result but was not concatenated into injected text (as designed).
- **Measured context:** whoami showed 269,858 / 1,000,000 (27%) before compact,
  and **52,887 / 1,000,000 (5%)** after. The cached snapshot was updated rather
  than retaining the old value = **MF1 epoch invalidation + refresh kick worked
  in live acceptance**.
- **A1 display (マスター visually checked the dashboard and screenshot):** one line
  `手動コンテキスト圧縮が完了しました（前 293221 tokens → 後 9187 tokens）
  168.8 秒`. The meter update from 27%→5% was also confirmed.
- **B1 did not fire** (27% < 70% threshold), as expected.
- **Duration: 168.8 seconds** (~293k tokens). This is 12 times Track S's 13.7
  seconds (~22k tokens), supporting the context-size dependence of duration (P-b).
- **Artifact metadata representation differed:** the in-process SDK message had
  `post_tokens`, while the same event in the CLI session jsonl (a separate
  on-disk artifact) had no `postTokens`, only `preTokens` / `durationMs`. Field
  names also differed as snake_case / camelCase. Record only the observation —
  jsonl is a persistent representation separately written by the CLI for resume,
  and its generation path is separate from the in-process SDK message delivered
  to the consumer; that is the likely explanation but is unconfirmed. **The
  wrapper must read the in-process message, not jsonl** (the same applies when
  handling reset events in Phase C).
- **whoami lag was quantified:** whoami's pre-compact value was 269,858, while
  boundary `pre_tokens` was 293,221, a gap of 23,363. A2's “cached last
  successful measurement; whoami itself does not refresh” was supported by live
  measurement. B1's threshold decision also reads the same cached context
  measurement as whoami, so it can be underestimated by the same amount. The 70%
  threshold provides enough margin and caused no practical harm.

## Phase C — agent-initiated new/clear (detailed 2026-07-28, クロエ ruling)

Design direction: a tool path of the same type as B2 (`request_compact`) + a new
wrapper→server event. Reset execution (kill + relaunch) uses the existing
ADR-0036 F2 mechanism completely; do not change the runner / execution flow.

| Track | Content | Owner |
|---|---|---|
| C1 | Draft revised ADR (new ADR revising ADR-0036 F1/F6) | もも (completed: ADR-0043, 5b24a6f) |
| C2 | wrapper: `request_session_reset` tool + send the request to the server at the turn boundary | あお (completed: 040145e + 678a1c6 + CR fix group) |
| C3 | server: accept `session_reset_request` + add origin + update threat-model / protocol.md | もも (completed: 416c2da + 9f6b7ca) |
| CR | C2+C3 diff review | ふじ (completed: 4 groups of must-fixes + CR-MF2-R detected → all resolved, approved for push 2026-07-28) |

### Design decisions (content to record in C1's ADR)

- **F1 revision:** add “the agent itself (self-initiated)” as a session_reset
  origin. Trigger it through an MCP tool and retain the rule that “the wrapper
  does not reparse user text” (do not add text parsing). Retain reserved-command
  protection (reject `/new` `/clear` instructions).
- Do not provide an agent-initiated path for another agent (P5). The operator
  names a director each time, and the instructed agent requests through its own
  tool → operator approval, so a dedicated mechanism is unnecessary.
- **F6 supplement:** agent-initiated reset fires at the turn boundary (deferred).
  At tool-call time return “reservation accepted”; after that turn completes,
  the wrapper sends the request to the server. Retain all operator-origin reset
  behavior: busy rejection, automatic-interrupt rejection, and queue rejection.
- **Permission:** `request_session_reset` is “heavy” under P2 —
  permission_broker approval each time (canUseTool path, same as B2). Approval is
  at tool-call time and execution is at the turn boundary; this time gap is the
  intended P4 (deferred) behavior.
- **Handoff:** do not mechanize it as P6 requires. State in the tool description
  that the agent should externalize the handoff to WORKLOG or similar before
  execution and then call the tool.

### C2 — wrapper (あお)

- `request_session_reset` tool: input `mode: "new" | "clear"` + optional `reason`.
  Same structure as B2 (Claude-only placement / canUseTool approval / put reason
  only in the server request payload and concatenate it nowhere).
- After approval, retain a “reservation” and, **after processing the result of
  that turn** (when the wrapper can establish its own turn boundary), send the
  new `session_reset_request {mode, reason?}` event to WrapperChannel.
- When the server rejects it (agent_busy / cooldown, etc.), resend once after a
  short delay; if it still fails, notify the agent of failure on the next turn
  (also log it).
- Observe only in-process SDK messages / server replies (session jsonl
  prohibited — established by live acceptance).
- Do not expose it to codex.

Confirmed implementation decisions (2026-07-28):

- Extract reservation retention and turn-boundary sending into
  `SessionResetCoordinator`, called from cli.ts's `onTurnEnd`. Importing cli.ts
  runs `main()` and prevents testing, so keep the decision logic outside (same
  reason as S1).
- Change the second argument of `buildKaoiroMcpServer` /
  `kaoiroToolDescriptors` to an array of “Claude-only tools
  (`{descriptor, inputShape}`)”. B2's optional-single-descriptor form breaks as
  soon as there is a second tool and would keep appending Zod shapes to this
  file. Each tool owns its shape.
- Retry once after 2.5 seconds (`SESSION_RESET_RETRY_DELAY_MS`). The server's
  dispatch cooldown is 2 seconds, so this resolves the most likely
  `agent_busy` immediately after a turn boundary. **Retry only `agent_busy`** (see
  CR-MF2 below).
- The server's error reason is a closed vocabulary (ADR-0036 F7), but the wrapper
  must not echo unknown values; collapse them to `unknown_error`. The reason is
  included in the operator log and the injected turn for the agent.

### CR findings and fixes (ふじ, 2026-07-28; decision: do not push → adopt all)

Three and a half groups, excluding the server side handled by もも.

- **MF1-R2 — the settle counter counted “value changes”.** Equality dedup returned
  first, so with a sequence stuck at the same high usage after compression, the
  counter never advanced and the liveness bound added by MF1-R did not hold.
  Response: dedup only in `#emitState`; count freshness and evaluate the
  threshold for every successful reading. The counter is a **measurement count**,
  not a value-change count.
- **CR-MF1 — collapse to `unknown_error` was not implemented.** Although it was
  stated in the report, plan, and comment, `sessionResetErrorReason()` passed
  through arbitrary strings. Response: explicitly whitelist this endpoint's four
  agreed values (`agent_busy` / `session_reset_pending` /
  `unsupported_session_reset` / `runner_unavailable`; the server side was also
  normalized to those 4 by もも's 9f6b7ca), and map everything else to
  `unknown_error`. `timeout` is produced by the transport, not a payload value,
  so it is not in the whitelist. Pin it in a transport test.
- **CR-MF2 — timeout / pending was asserted to mean “not executed”.** A Phoenix
  push timeout does not mean rejection. Counterexample: first request accepted +
  reply lost → retry returns `session_reset_pending` → report “it did not run”,
  while reset is in progress. Classify rejection reasons into three groups:
  `retryable` (`agent_busy` only — retry) / `refused` (capability, format,
  authorization, runner unavailable — do not retry but may assert) /
  `unconfirmed` (timeout, `session_reset_pending`, `spawn_failed`,
  `unknown_error`, etc. — do not retry and do not assert). Default to
  `unconfirmed`. The cost of honest wording is agent caution; the cost of an
  assertion is action based on a false premise.
- **CR-MF2-R — a timed assertion remained in the unconfirmed notice.** It said
  “if nothing happens by the end of the next turn, it was not executed,” but the
  server reset transaction uses `SessionResets.@timeout_ms` = 60 seconds and is
  independent of the wrapper's turn boundary. A sequence where an accepted reset
  replaces the process immediately after a short turn is normal. Response: remove
  the timed wording; establish completion only from process replacement / an
  operator lifecycle event. Keep the notice to “do not request again” and “keep
  durable state safe for either outcome”; pin negatively that it contains no
  assertion such as `was not carried
  out` / `it did not run` / `next turn`.
- **Three suggestions (all adopted):** synchronize `requestSessionReset`'s JSDoc
  with the 4-value contract / pin the known reasons in a 4-value transport-test
  table / remove 3 unreachable values from `DETERMINED_REFUSALS` and organize it
  around the 4-value contract.
- **CR-MF3 — `SessionResetStarted`'s TS type was out of sync with the wire.** Add
  `origin: "operator" | "agent_self"` and `reason?` to the protocol and
  dashboard parser. It is not displayed yet, but the parser retains it.
  **Degrade an invalid origin to `operator` rather than dropping the event** —
  dropping it leaves the composer disabled while waiting for the corresponding
  Completed event. Old servers have no origin in the payload, and there every
  reset is operator-originated.

### C3 — server (もも)

- Add `WrapperChannel.handle_in("session_reset_request")`, pass capability
  validation and the existing `SessionResets.check_and_acquire` gate (pending
  lock / state / cooldown), and merge into the existing runner-push path.
  **Do not change the execution path.**
- Add origin (`:operator` / `:agent_self`) to `SessionResets` and include it in
  the `session_reset_started` broadcast (dashboard display can be minimal or
  absent — choose the lighter implementation).
- Align the six-layer defense in `docs/specs/threat-model.md` and the
  “operator-only” wording in `docs/specs/protocol.md` with the revised ADR.
- Keep the information boundary for viewers (ADR-0021) unchanged.

### Common Phase C completion conditions

- Wrapper: tests/typecheck green. Server: `mix test` green + `mix format` done.
- Keep all existing reserved-command protection and operator-path tests green (no
  regression).
- Push after CR passes. マスター live acceptance is the final gate.
- C consists of a new wrapper→server control event + new MCP tool + deferred
  reset (turn-boundary trigger), with revisions to ADR-0036 F1 (operator-only) /
  F6 (busy rejection). Begin with all-request approval (P2).

## Phase C live acceptance results (あお + マスター, 2026-07-28)

After a dogfood restart, every stage of
`request_session_reset (mode:"new", reason:"phase-28
実機受け入れ")` succeeded.

- Tool call → reservation accepted (the non-assertive wording from CR-MF2-R was
  confirmed live) → turn ends → `session_reset_request` → server accepts → kill
  + fresh relaunch.
- The pre-reset context of 311,986 tokens (31%) disappeared completely after
  relaunch (no stale value remained). agent_id / persona / model / effort were
  restored from the snapshot (ADR-0036 F2). マスター visually confirmed the
  pane boundary marker and composer recovery.
- D5's externalized handoff (WORKLOG) was also performed as operated.

### Approval semantics confirmed (マスター ruling, 2026-07-28)

During acceptance it was discovered that the approval dialog did not appear for
the operator. The cause was that the dogfood Claude persona started with
`permission_mode=auto`; the SDK automatically approves tools under that mode's
semantics, so the canUseTool → permission_broker path did not fire. The wrapper's
gate implementation itself is correct (the dialog appears in default modes).

マスター ruling: **approval depends on the agent's permission mode** is now formal
specification (auto modes include approval in the mode / default modes show a
dialog each time). Apply this to `request_compact` / `request_session_reset` /
`send_to_agent`. The source of truth is the ADR-0043 supplement; see the note in
  protocol-inter-agent.md for the spec. Interpret P2's “permission_broker
approves every request” in this sense.
