---
title: Add a Google Antigravity adapter as the third engine, driving the agy CLI headless with a hook-based permission gate
status: accepted
date: 2026-09-04
opened: 2026-09-04
supersedes: []
superseded_by: null
related_specs: [antigravity-adapter, antigravity-events, antigravity-tools-permissions, antigravity-cli-contract, plugin-model, protocol, codex-exec-events, security-threat-model]
related_adrs: [14, 17, 23, 32, 33, 34, 35, 36, 39]
---

# ADR-0057 — Add a Google Antigravity adapter as the third engine, driving the agy CLI headless with a hook-based permission gate

## Status

Accepted (issue #181). Implementation is
[phase-34-antigravity-adapter](../plans/phase-34-antigravity-adapter.md).
Revised 2026-09-04 after design review (kuroe): version pin corrected to
1.1.26, gate self-verification (F4b), bridge argv validation (F5), advisory
sandbox and `network_access` (F4), tool-class source of truth (F4), and
axes fixed at spawn in Stage A (F4c). Q1–Q3 are closed by measurement.
Revised 2026-09-10 for inbound inter-agent turn delivery (F5a).
Accepted 2026-09-18 after Stage A dogfood and F4c Stage B0 (mid-session
approval/sandbox/network switching under a host-local launch ceiling,
issue #359).
Revised 2026-09-23 for F4c reset-refusal diagnosability (`permission_ceiling_conflict`
plus a per-axis detail, issue #397); the trust-model gap it surfaced is
tracked separately as issue #400.
Revised 2026-09-19 for `run_command` Cwd containment (F4 addendum, issue #370).
Revised 2026-09-19 for operator-interrupt turn settlement (F4 addendum, issue #371).
Revised 2026-09-21 to note the close()-race `onTurnEnd` shape (F4 addendum, issue #380).
Revised 2026-09-21 for the stdin prompt transport, the delivery-ack point,
and the gate step-correlation ledger's move to `GateServer` (F2 / F4b /
F5a, issue #377 Stage 1).
Revised 2026-09-21 for the epoch lifetime model -- one `agy` process per
several turns, spec-change respawn, mid-epoch permission switching,
`epoch_ended` / `out_of_turn_event`, and the idle-epoch TTL (F2 / F3 / F4b
/ F5a, issue #377 Stage 2).
Revised 2026-09-23 to add the agent-facing `request_session_reset` tool
and the `onTurnEnd` `terminal` field it required (F5, issue #396).
Revised 2026-09-26 for the setup wizard's `agy` presence check and the
register-time `agy --version` report (F6 addendum, issue #387).

## Context

Issue #181 asks for Google Antigravity as a third kaoiro engine next to
`claude-code` and `codex`, premised on the Antigravity SDK. Investigation on
2026-09-04 ([Antigravity CLI contract evidence](../evidence/antigravity/cli-contract.md))
established:

- The SDK is Python-only; there is no Node/TS SDK. Hosting it would need a
  Python child process and a bespoke event bridge, against
  [ADR-0023](0023-host-runner-architecture.md) D3.
- The CLI `agy` (1.1.26, self-updating) has a headless print mode with a
  single NDJSON event stream (`init` / `step_update` / `result`),
  conversation resume by id, per-directory customization discovery
  (`--add-dir`), and lifecycle hooks whose PreToolUse decision can allow or
  deny any tool call.
- Headless `agy` auto-denies every tool that would need a prompt; hooks
  cannot lift that denial, but with prompts disabled
  (`--dangerously-skip-permissions`, measured per process) the hook becomes the sole gate — which gives kaoiro a **real
  approval round trip**, something the Codex adapter never had
  ([ADR-0033](0033-permission-model-dual-axis.md) Context). A hook that
  blocked 100 s was honoured, and a 70 s tool call held the turn.
- MCP servers are not mounted in headless mode (measured three ways), so the
  Codex MCP bridge pattern ([ADR-0032](0032-codex-adapter.md) F5) cannot be
  reused as-is.
- `--sandbox` had no observable effect (writes outside cwd and network both
  succeeded), so there is no OS-level sandbox to lean on.

Correspondence to the two existing engines:

| Concept | Claude Agent SDK | Codex SDK | Antigravity CLI (this ADR) |
|---|---|---|---|
| Main API | `query()` resident | `codex exec` per turn | `agy --print` per turn, stream-json |
| Resume | `resume: sessionId` | `exec resume <id>` | `--conversation <id>` |
| Approval to caller | `canUseTool` | none (fixed at spawn) | PreToolUse hook → wrapper socket |
| Sandbox | none (tool allowlist) | OS sandbox | **advisory** (wrapper argument inspection) |
| System prompt | `systemPrompt.append` | `developer_instructions` | `.agents/rules/AGENTS.md` via `--add-dir` |
| kaoiro tools | in-process MCP | MCP bridge (stdio) | CLI bridge via `run_command` |
| Model | `claude-*` | account default / curated | `agy models` slugs + account default, `--model` |
| Auth | env / subscription | env / ChatGPT login | OAuth in `~/.gemini`, env inherited |
| Usage / limits | SDK events | none | `-p /usage --output-format json` (quota-free) |

## Decision

### F1 — Engine id, package, wiring

Engine id `antigravity` (capabilities value, `SpawnMessage.engine`,
`ext.engine`, `EngineKind`). New package `wrapper/antigravity`
(`@kaoiro/antigravity`) built on `@kaoiro/wrapper-core` +
`@kaoiro/agent-common`, copying the `wrapper/codex` skeleton
(`cli.ts` composition root, `host.ts` EngineAdapter, `adapter.ts` pure event
translation, `catalog.ts`, `toolhost.ts`, `bridge.ts`, `hook.ts`,
`gate.ts`, `history.ts`). Wiring checklist = ADR-0032 F1/F4a applied a third
time (protocol union, runner `ENGINE_PACKAGES` / `BUNDLED_ENGINES` /
`P0_FIELDS_BY_ENGINE` / sessions / setup wizard, server `@engine_values` /
`wrapper_channel` engine guard, release manifest and verifier sentinels,
`wrapper/package.json` fan-out, `pnpm-workspace.yaml`) **plus** the schema
additions of F4c (`approval` on spawn / snapshot / P0).

### F2 — Process model: one `agy` process per epoch, prompt over stdin, SIGTERM to end it

An **epoch** is one `agy` process spanning several turns (issue #377 Stage
2). The first `send()` after no epoch is live lazily spawns one: `agy
--print "" --input-format stream-json --output-format stream-json
--print-timeout 0 --disable-slash-commands [--conversation <id>] [--model]
[--effort] --add-dir <agent cwd> --add-dir <agent dir>`. `--print-timeout 0`
is the CLI's own documented "no timeout" value (`agy --help`; measured not
to change promotion or error behaviour,
[print-mode-background-tasks.md](../evidence/antigravity/print-mode-background-tasks.md)),
so a promoted background task outliving several turns is bounded by the
wrapper's own `TurnWatchdog`, not this flag. Both `--add-dir` values are
mandatory: in print mode the cwd is not a workspace root on its own
(measured), and with only the customization dir added the model operates
inside it. `--disable-slash-commands` keeps operator text out of the CLI
control plane ([ADR-0036](0036-session-lifecycle-commands.md) only filters
literal `/new` / `/clear`).

**Reuse vs. respawn.** Each turn computes an `EpochSpec`
(`{conversationId, model, effort, addDirs}`); a live epoch is reused only
when the next turn's spec matches its recorded one. A mismatch (a model or
effort switch, a different conversation) ends the live epoch first
(`epoch_ended{reason:"spec_change"}`) and spawns fresh. A fresh epoch's
`conversationId` starts `null`; the epoch adopts the engine-confirmed id
from its OWN `init` event (the only writer of a live epoch's recorded
spec), so a later turn's freshly computed spec — which reads that now-
confirmed id — matches instead of forcing a spurious respawn on turn 2.
`ToolHost` / `GateServer` / the gate-registration probe / rewriting the
customization dir happen once per epoch spawn, not per turn; the
customization tamper check (`verify()`) still runs every turn, actively
ending the epoch on failure (`epoch_ended{reason:"tamper"}`) since the
process would otherwise keep running.

**Turn completion.** A turn's own completion signal is its `result` event
on the epoch's shared, continuous stdout stream — not the process exiting.
One continuous reader (attached once per epoch spawn) routes `result` to
whichever turn is currently in flight and folds every other event into
that turn's state (gate correlation, tool ACTIVE/DONE, assistant text),
exactly mirroring the per-turn logic Stage 1 ran per process. A stream
event arriving while no turn is in flight is logged as `out_of_turn_event`
(bounded: event kind and, for `step_update`/`result`, one coarse detail
field) and never projected onto a turn — including a stray tool completion
arriving just after a turn's own `result`; only a gate-correlation failure
DURING a turn (before its `result`) still ends the epoch
(`reason:"gate_broken"`). The next line is written to stdin only after the
CURRENT turn's own `result` (a host-side queue; the CLI's own stream-input
queue is never relied on) — the ack-point semantics are unchanged from
Stage 1 below, just without ending stdin.

**Ending an epoch.** `epoch_ended{reason, code, signal, turns}` is logged
for every explicit end: `interrupt` (operator `interrupt()` — now ends the
WHOLE epoch, including an idle one with no active turn, unlike Stage 1
where idle meant no process existed), `watchdog` (a `TurnWatchdog`
interrupt/fail-stop), `tamper`, `gate_broken`, `spec_change`, `close`
(host `close()`), and `idle_ttl` (below). A spontaneous exit while idle is
`epoch_ended{reason:"idle_exit"}`; the same exit while a turn is in flight
is that turn's own error (`agy_exit_without_result` /
`epoch_exit_before_turn`), not a separate lifecycle event, matching Stage
1's per-turn error kinds. No end is auto-retried; the next `send()`
lazily respawns.

**Idle-epoch lifetime bound.** `KAOIRO_ANTIGRAVITY_EPOCH_IDLE_MS` (default
30 min, minimum 1 s) ends an epoch that sits idle (no in-flight turn) that
long (`reason:"idle_ttl"`). The timer clears at turn DEQUEUE — before spec
comparison or a possible respawn — and re-arms only once that turn's own
result/error has settled, so it can never fire mid-spawn or mid-delivery-
ack.

**Prompt transport: one NDJSON line on stdin, kept open across turns.**
`agy --print`'s argv-prompt mode clamps `WaitMsBeforeAsync` at 10s and
terminates any `run_command` the CLI promoted to a background task 5s
after the model's last text — measured
([print-mode-background-tasks.md](../evidence/antigravity/print-mode-background-tasks.md))
to silently lose any tool call longer than ~10s, including routine
`pnpm lint` / `pnpm check` / build commands. `--input-format stream-json`
instead waits for a promoted task before emitting `result`, so the
wrapper's own `DEFAULT_TOOL_TIMEOUT_MS` (10 min) becomes the bound that
actually governs a promoted step, as intended. The host writes exactly one
line, `{"event":"user","message":{"role":"user","content":<text>}}\n`, to
the epoch's stdin per turn; Stage 1 additionally called `end()` (one
process per turn), Stage 2 does not (the process outlives its first
turn). The delivery ack (`onTurnStart`, and the `TurnWatchdog`'s clock
with it) fires only once the write callback has resolved without error on
an epoch that has not already ended, never on the bare return of
`write()`, since a pipe write can still succeed into the kernel buffer on
a process that is already dying. A write-callback error or the epoch
ending racing the write settles the turn as an error
(`epoch_exit_before_turn`) with the usual inter-agent failure notice and no
ack; the host never re-sends the line on a fresh process by itself, since
the model may already have read it and a duplicate turn is worse than a
visible failure. This precedence sits below `close()` / a stale generation
(an operator `interrupt()` racing the same write settles as `interrupted`,
not `epoch_exit_before_turn`) and above every other terminal outcome. The
CLI's in-band control channel (`control_request` / `control_response`)
is rejected as unsupported (measured) and there is no interrupt over
stdin; `interrupt()` ends the epoch via F2a's subtree kill.

### F2a — Subtree termination: own process group, grace, timer ownership (issue #379)

The production default spawn (`#defaultSpawn`) starts `agy` with `detached:
true`, making it its own process-group leader. Every path that stops the
active agy (`interrupt()`, `close()`, and a gate-correlation-failure kill)
routes through `subtree_termination.ts`'s `terminateWithGrace`: it sends
SIGTERM via `signalSubtree` (`process.kill(-pid, signal)` when the group is
known, falling back to a single-process `kill()` otherwise — Linux is the
verified platform; elsewhere the fallback applies and a `run_command`
grandchild may be left behind, a documented gap, not a silent claim of
coverage) and arms a SIGKILL escalation after a grace period. The escalation
re-checks `exitCode` / `signalCode` immediately before signalling: a pid can
be reused once its process has actually exited, so "the target already
looked dead when we cancelled" is not trusted — liveness is confirmed again
at the moment of signalling. Turns are strictly sequential (a new child only
spawns after the previous one's `close`/`exit` cancelled its own escalation),
so at most one escalation is ever outstanding and no cross-turn timer can
target a different turn's child.

Two grace values, not one: `abortGraceMs` (default: the CLI's resolved
`TurnWatchdog` abort grace, ~60s) bounds `interrupt()` and the
correlation-failure kill; `close()` uses its own much shorter
`closeGraceMs` (default 2s) instead, and if an `interrupt()`-armed
`abortGraceMs` escalation is already pending, `close()` SHORTENS it down
to `closeGraceMs` rather than trusting the longer one (never lengthens an
already-shorter deadline; never re-sends SIGTERM, already sent once by the
`interrupt()` call). This matters because `close()` can run while the
*wrapper process itself* is a live target of an outer supervisor's own
timeout: the runner's reset-relaunch grace (`RESET_TERMINATION_GRACE_MS` =
5s) or systemd's `TimeoutStopSec` (30s) can SIGKILL this process before a
60s abort grace would ever fire, orphaning the agy subtree with only the
initial SIGTERM delivered. `closeGraceMs` must stay below the tightest of
those outer bounds; if either changes, revisit this default together with
it.

The watchdog's own two calls (`requestInterruptForTurn`,
`failStopTurnForWatchdog`) do NOT arm a grace of their own: `TurnWatchdog`
(`turn_watchdog.ts`) already owns that timing externally (it calls
`requestInterrupt`, arms its own `abortGraceMs` timer, then calls
`failStop` only after that elapses), so `requestInterruptForTurn` sends a
bare SIGTERM and `failStopTurnForWatchdog` escalates straight to SIGKILL —
stacking a second grace window here would double the effective wait before
an unresponsive watchdog-flagged turn actually dies. An operator
`interrupt()` landing after a watchdog SIGTERM has already gone out is a
harmless duplicate signal to an already-terminating process.

`runAntigravityCli` also registers a SIGTERM handler on the wrapper process
itself (mirroring the existing SIGINT handler, but calling `close()`
directly rather than `interrupt().finally(close)` — SIGTERM is an external
"stop now", not an operator action, and should not manufacture an
`interrupt_requested` / `interrupted` settlement record for something the
operator never asked to interrupt). Without it, Node's default SIGTERM
behavior kills the process immediately: no `close()`, no group signal, no
escalation — and the runner's stop / delete / restart / reset paths all
rely on exactly that signal (`entry.child.kill()`, runner/src/spawn.ts).
Registering the handler also suppresses that default so the process stays
alive — via the child's stdio pipes and the pending escalation timer
holding the event loop open — until the escalation actually finishes the
subtree; no explicit `process.exit()` is used or needed. Codex and Claude
Code have the same missing-SIGTERM-handler gap; fixing it there is tracked
separately, out of scope here. One residual gap this cannot close: if an
outer supervisor SIGKILLs the WRAPPER process itself (uncatchable), no
handler runs at all and the subtree can still be orphaned — this is a
smaller window than before issue #379 (bounded by `closeGraceMs` /
`abortGraceMs` instead of being unconditional), not a claim that it is
eliminated.

`terminateWithGrace` is deliberately generic (`{ child, group } -> grace ->
SIGKILL`, not `interrupt()`-specific) — issue #377 Stage 2 (epoch
termination) is expected to reuse it for the same operation.

### F3 — Persona injection through an always-on rules file in a per-agent customization dir

The wrapper owns a per-agent directory (`mkdtemp`, 0700) passed with
`--add-dir`, containing `.agents/rules/AGENTS.md` = kaoiro preamble
(working directory pinned to the agent cwd, bridge contract, "never touch
this directory") + server-pushed personality + footer. Persona packs stay
engine-independent (ADR-0032 F3). The wrapper rewrites the files before
**every epoch spawn** (issue #377 Stage 2: once per several turns, not per
turn as under Stage 1) from in-memory content, verifies their SHA-256 after
writing, and verifies them again after every turn: a mismatch marks the
session `error` (`antigravity_customization_tampered`) and actively ends
the epoch (`epoch_ended{reason:"tamper"}`) before refusing further turns.
This is **tamper detection, not prevention** — the agent runs as the same
uid and a shell can rewrite the directory; the per-epoch regeneration
bounds the damage to the remainder of one epoch. It deletes the directory
on close and on startup sweeps stale
`kaoiro-agy-*` directories left by a SIGKILL (content is persona text and
the gate config, low sensitivity, but the sweep keeps `/tmp` bounded).

(N5, issue #377 Stage 2) A persona change has no live mechanism today
(`appendSystemPrompt` is read once at construction; there is no setter),
but if one is added it must END the epoch rather than rewrite this
directory's content in place while the epoch's process is still reading
it — the same treatment `EpochSpec` already gives a model/effort/
conversation change, not a special case.

### F4 — Permission: prompts disabled at the CLI, wrapper gate decides

`.agents/hooks.json` registers one PreToolUse handler (matcher `*`,
`timeout` = gate deadline + margin) running `node <pkg>/dist/hook.js`. The
hook forwards `toolCall` to the wrapper's unix socket and prints the
decision; on any failure (socket, deadline, malformed payload) it prints
`deny` with a reason the model can read. The wrapper's `gate.ts` applies:

**Tool classes** — the classification table in the spec is the source of
truth (read / write / shell / network / subagent / agent-internal). Every
`init` event's `tools` list is diffed against it; unknown names are logged
loudly (vendor drift detector) and treated as *unclassified*:
`never` → `deny`, otherwise → ask. Agent-internal tools are always denied
(they need the TUI or MCP). `command_status` is read-class.

**Axes** (ADR-0033 vocabulary, `sandbox` × `approval`, plus
`network_access` with the effective-value normalisation of ADR-0033 F3
addendum — `danger-full-access` → always true, `read-only` → always false,
`workspace-write` → the toggle — shared with Codex through the same helper
so `ext.effective.network_access` means one thing across engines; resume
re-applies all three per [ADR-0014](0014-session-resume-and-restore.md)
F1 addendum). The sandbox axis is **advisory** on this engine: it is
enforced by argument inspection (`AbsolutePath` / `DirectoryPath` /
`TargetFile` / `Cwd` resolved and compared with the agent cwd), never by the
OS. The envelope stamps `ext.permission.enforcement`, a field every engine
fills so the dashboard never branches on its absence: `"os"` for Codex
(OS sandbox), `"mode"` for Claude (the sandbox value is a projection of
`permissionMode`, ADR-0033 F2), `"advisory"` for this engine. Only
`"advisory"` renders a permanent badge next to the sandbox value, the same
device ADR-0033 F4 addendum uses for Codex's host-fixed approval.

Rows are ordered strict → permissive, columns likewise:

| sandbox \ approval | `untrusted` | `on-request` | `local` | `never` |
|---|---|---|---|---|
| `read-only` | read allowed; everything else denied | same | same | same |
| `workspace-write` | read allowed; write in-cwd, shell, subagent ask; write out-of-cwd denied | read and in-cwd write allowed; shell and subagent ask; out-of-cwd write denied | same, except `.git` writes ask while restricted read-only and observational Git command shapes are allowed | read, in-cwd write, shell, subagent allowed (shell is not sandboxed — badge) |
| `danger-full-access` | read allowed; every other class asks | read and write allowed; shell and subagent ask | read and write allowed except `.git` writes ask; restricted read-only and observational Git command shapes allowed; other shell and subagent ask | everything allowed |

`network` class: denied when the *effective* `network_access` is false;
when true it follows the shell column of the row (`browser_subagent` sits
in the network class rather than subagent because it exists to reach the
network, so the toggle must be able to switch it off). `on-failure` is rejected at spawn for
this engine (LaunchDialog offers four values). The gate also denies,
regardless of cell, any file-tool call whose resolved path (every
path-bearing key, realpath of the longest existing ancestor) lies inside
the customization dir; for `run_command` the string check is best-effort
only (a bash command line cannot be canonicalised), and the real protection
is the post-turn SHA verification of F3. A
**F4 addendum — `run_command` Cwd containment (issue #370).** A canonical
`Cwd` equal to or inside the agent cwd follows its ordinary shell policy.
For an outside, absent, malformed, or uncanonicalizable `Cwd`,
`workspace-write` asks except that `never` denies without a prompt;
`danger-full-access` retains its ordinary advisory-shell policy; and
`read-only` denies regardless of Cwd location. The prior gate returned `ask`
for outside or missing Cwd before reaching the read-only shell denial; that
would make an outside Cwd less restricted than an inside Cwd and is no longer
permitted. The Cwd boundary is checked before the `local` command allowlist.
Operator decisions reuse `PermissionBroker` (`waiting_permission`,
`ext.pending_permission`).

**F4 addendum — operator-interrupt turn settlement (issue #371, Design v2).**
`interrupt()` kills the `agy` child and every `PermissionBroker` /
`QuestionBroker` / gate-socket resource, but the child's death is not itself
a state transition. `#runTurn` decides no terminal outcome by itself: it
returns a discriminated `TurnOutcome` —  `stale` (a generation mismatch,
`close()`, or fail-stop), `error` (customization tampering, an unobserved
tool, a tool timeout, a spawn/child error, `agy_exit_without_result`, or a
converted throw), or `result` (agy's raw terminal event, unprocessed) — and
`#drainTurns`'s `finally` is the single place that projects an outcome into
every callback that carries terminal meaning: `onState` / `onLog` (via
`#terminalError` / `#publishTerminalResult`), the rate-limit update, model
promote/rollback, `onInterruptSettled`, `onTurnBoundary`, `onTurnEnd`.

**Invariant:** `#currentTurnToken !== null` iff this turn's outcome has not
yet been projected. No terminal-meaning callback may fire while any identity
field (`#currentTurnToken`, `#currentAttemptedModel`, `#activeTurnToken`,
`#activeTurnConversationIds`, `#interruptRecord`) still names the turn — the
`finally` clears them, unconditionally and token-matched, before projecting.
**Exception:** `onWatchdogFailStop` deliberately fires while identity is
still live (it reads `#activeTurnToken`); the queued turns it also settles
never held identity at all. **Boundary:** identity begins at dequeue, so a
re-entrant `interrupt()` from inside the `onState("sending")` that `send()`
itself emits sees no current turn yet and is an idle interrupt — documented,
not fixed, since no production caller re-enters from there.

`interrupt()` records a one-shot `{turnToken, generation, at}` marker,
synchronously and only on the FIRST press per turn (a second press repeats
the kill routine without a duplicate lifecycle event), before it bumps the
lifecycle generation, binding to the turn `#drainTurns` established as
inflight the moment it dequeued it — before the child ever spawns, not only
after. In the `finally`, a `stale` outcome converts to `interrupted` only
when the marker matches this turn AND the host is still in normal admission
(not `close()`d); `close()` and fail-stop also produce `stale`, but with no
matching marker, so they keep their PRE-#371 termination semantics exactly
(no fabricated result, no interrupt lifecycle event, no queue resume beyond
what `#drainTurns`'s own top-of-function guard already withholds). A turn
whose child produces a real error after an interrupt keeps that error, not
`interrupted` — customization tampering outranks a stale generation, since a
broken gate is a heavier fact than the interrupt; a terminal event the child
emits while dying (e.g. `CANCELED`, which the adapter maps to success) is
still discarded as `stale` once the generation has moved, and is therefore
projected as `interrupted` instead of a fabricated success.

An at-rest state is deliberately never used as a proxy for "this turn
already settled": `session_init` can emit `idle` for a queued turn
(`state.ts:57-66`), and a queued turn dequeues already at rest from the
PRIOR turn's own result — an at-rest check cannot tell "already settled" from
"never got the chance to move." The outcome union replaces that check
structurally: four generation-mismatch early returns inside `#runTurn`
(after `ToolHost.listen`, after `waitForPermissionSync`, after
`GateServer.listen`, after gate registration success) plus the throw path
(gate registration failure, folded into `#drainTurns`'s `catch`) are `stale`
by construction, not by reading machine state. The `catch` reads the
generation before it builds an `error` outcome, so a `#runTurn` throw that
races `close()` is `stale` too and ends the turn with no `error` on
`onTurnEnd`; before 3d73a50d the `catch` kept `error: { detail }` for a
stale generation, which produced an `api_error` notice for a planned close.
The close race is now consistent with the close-race early returns, and
its notices come from the disconnect path (issues #351 / #360). Review checklist for this
file: no terminal `#apply` / `#terminalError` / `#publishTerminalResult`
outside `#drainTurns`'s `finally` — a new terminal path added to `#runTurn`
must return a `TurnOutcome` member to typecheck, so the class this addendum
closes has no site left to reopen on.

An interrupt on an idle host (no turn in flight) records no marker and
produces neither a result nor a lifecycle event; the next `send()` simply
starts under the new generation. A turn interrupted before its own child
ever spawns — including one still queued behind another turn — settles the
same way: `interrupt_requested` (turn token, pending permission / question
flags, child pid) and `interrupt_settled` (exit code, signal, elapsed ms)
are logged once each to the `[antigravity-lifecycle]` stream. Separately,
`send()`'s three silent non-start paths (closed / gate-broken / watchdog
fail-stopped) and an unattached `attachments_unsupported` no-op — none of
which throw, so a caller's `.catch()` never observes them — are all logged
to the same stream (`send_not_started`, turn token and delivery seqs only,
never inbound text) before classification, so the next unattributed
incident is diagnosable from the journal. Escalating `SIGTERM` to `SIGKILL`
on a wedged `agy` child is tracked separately (issue #379); this addendum
does not change what `interrupt()` kills, only what settles afterward.

`local` recognizes only a deliberately small shell grammar. It rejects shell
expansion, environment assignment, redirection, subshells, `eval`, unknown
executables/options, and Git repository relocation/config overrides. A `|` or
`&&` composition is allowed only when every segment independently matches the
allowlist. Remote Git subcommands, network clients, package installation,
commit, merge, and destructive commands ask. Git observation path operands
must resolve inside the agent cwd, including through existing symlinks;
nonexistent in-cwd paths are accepted because the command will fail with
`ENOENT`. The classifier recognizes only `HEAD`, `HEAD~n`, branch-like names,
two-dot/three-dot ranges, and `<revision>:<path>` as revision syntax; the path
part of the last form is checked separately, and ambiguous syntax asks. Writes
to `.git`, whether it is a directory or a worktree metadata
file, ask so the model cannot install a Git execution path and then invoke it
without approval. Pre-existing repository or global configuration can still
name helpers such as `diff.external`, `core.fsmonitor`, or a clean filter used
by `git add`; trusting those is an operator responsibility. This is an advisory
classification, not an OS safety guarantee. `git add` is included because it
updates the index without running hooks. Its effects are repository-relative:
`git add -A` or `git add .` invoked from a repository subdirectory can stage
paths beyond the agent cwd.

Default launch axes: `workspace-write` (the Codex sandbox default) ×
`on-request` (approval is selectable for the first time on this engine) ×
`network_access = false`.

### F4b — Gate self-verification on the production path

Because the hook is the only enforcement point and a hook that silently
does not fire means unlimited execution, the wrapper verifies the gate
before and during every session. F4b is a **detector of vendor-mechanism
failure**, not a defence against an adversarial model (the nonce and the
correlation map are readable by any shell the agent runs); it detects, it
does not prevent — a tool that ran without a gate request has already run.

1. Smoke test (not an execution gate): before the first turn of each epoch
   (issue #377 Stage 2: once per several turns, not per turn), and after
   every `agy` version change or customization-dir regeneration,
   `agy -p /hooks --add-dir <cwd> --add-dir <dir> --output-format json`
   (quota-free, measured) must list exactly the kaoiro gate with the
   expected `source`; otherwise the spawn fails with `error`
   (`antigravity_gate_not_registered`). It runs on a different invocation
   path from `--print`, so passing it never excuses item 2.
2. Correlation invariant (the gate): a `step_update` with `step_type =
   "tool"` reaching `DONE` or `ERROR` must have a gate request observed
   for the same `stepIdx` (measured equal to `step_index`, 9 of 9 tool
   calls across 4 conversations). `ACTIVE` arrives before the hook
   decision returns (a 100 s hook showed `ACTIVE` first and `DONE` 110 s
   later), so the check is order-independent and keyed on completion. A
   completed tool step without a gate request -- while a turn is in
   flight for it, the only case this can arise for (Stage 2: an unowned
   stream event is `out_of_turn_event`, never gate-checked) -- ends the
   epoch (`epoch_ended{reason:"gate_broken"}`) and marks the turn `error`
   with `antigravity_gate_unobserved_tool` carrying the tool name; the
   host refuses further turns until item 1 passes again on the next
   epoch. Scope: tool names in classes where hook firing is measured
   (write, read, shell, subagent, network — `write_to_file`, `view_file`,
   `list_dir`, `run_command`, `define_subagent`, `manage_task`,
   `search_web` fired; `wait_5_seconds` and `finish` did not appear as
   tool steps at all); an unmeasured name only logs loudly. Optional
   tightening (Stage B, needs a measured Δ): `ACTIVE` without a gate
   request after Δ → kill before completion. **Ledger ownership (issue
   #377 Stage 1 M3, used by Stage 2):** the correlation set (`stepIdx`s
   with an observed gate request) lives on `GateServer`, not on
   `AntigravityGate` -- the server is the socket owner and, since Stage
   2, the one object a turn boundary keeps across a `setGate()` policy
   swap (a new `AntigravityGate` built fresh every turn from the
   turn-boundary config, swapped in via `GateServer.setGate()`), so the
   ledger survives a swap unchanged while `AntigravityGate` stays pure
   policy over its readonly axes. `GateServer` is now one per EPOCH, not
   one per turn.
3. The gate socket is **separate** from the `ToolHost` socket of F5 (two
   unix sockets, two nonces, two protocols): a gate decision and a tool
   execution must never share a trust role, and a shell reaching the
   `ToolHost` socket must not thereby be able to answer gate questions.
   A gate request without its nonce is answered `deny`. The nonce only
   rejects unrelated same-uid processes that guessed the socket path.
4. Gate socket lifecycle: if the hook connection closes before the wrapper
   answers (the CLI killed the hook on `timeout`, measured; interrupt;
   crash), the pending `PermissionBroker` entry is resolved as deny and
   `waiting_permission` is cleared — the Codex `ToolHost` habit of
   ignoring socket errors is not inherited on the gate path. issue #377
   Stage 2: `interrupt()` closes `GateServer` / `ToolHost` synchronously,
   before the SIGTERM/SIGKILL grace (up to `abortGraceMs`, ~60s) elapses —
   if the still-alive `agy` process tries to call the hook or the bridge
   during that window, it finds no socket and fails closed, same as any
   other socket loss above.

### F4c — Stage A fixes both axes at spawn; mid-session change is Stage B

`approval` is added next to `sandbox` in `SpawnRequest` / `SpawnMessage`,
`ResolvedSnapshotExt`, and `P0_FIELDS_BY_ENGINE["antigravity"] =
["sandbox", "approval", "networkAccess"]`; `ext.permission.enforcement`
(F4) is added to `PermissionAxesExt` (resume re-applies them; the
phase-15 D8 rule of dropping a stale `danger-full-access` to the safe
default applies to `approval = never` as well). `setPermissionMode` and
`set_permission` reject in Stage A, where this engine does not advertise
`supports_permission_switch`. Stage B0 (issue #359) enables the shared
`set_permission` control end to end: after negotiation the wrapper advertises
`supports_permission_switch` and `permission_switch_axes`, applies a switch by
mutating its per-turn advisory gate between turns, and the dashboard offers the
three controls. Each picker mirrors its advertised axis ceiling: sandbox and
approval options above `max` are disabled and labelled, while a false network
ceiling disables enabling network but still permits narrowing from true to
false. If the whole `permission_switch_axes` field is absent, the legacy
sandbox/network controls remain available; if the field is present but an axis
arm is absent or malformed, that axis is launch-fixed and its picker is hidden.
The dashboard clamp is advisory: the server and wrapper still enforce every
axis as the authoritative gates.
Precondition for B0: the threat-model MUST that the server cannot widen a
wrapper's execution ceiling still holds — on this engine the cell matrix
*is* the ceiling — so B0 adds wrapper-config clamps (`max_sandbox`,
`max_approval`, `max_network_access`), and both the server and the wrapper
(fail-closed) reject a switch outside the narrowing direction from the launch
values with `exceeds_launch_ceiling`.

**Reset diagnosability, not new semantics (issue #397).** `reset_session`
runs the same ceiling check as `switch_session` against
`entry.permissionCeiling` — a conflict there used to collapse into the
generic `spawn_failed`, with the offending axis visible only in the runner
journal (`runner/src/supervisor.ts`). It now reports its own
`SessionResetErrorReason` value, `permission_ceiling_conflict`, plus a
structured per-axis detail (`PermissionCeilingConflictAxis[]`: axis,
current value, ceiling value) carried through `SessionResetResult` /
`SessionResetFailed` to the dashboard, which names the axis and the value
to narrow. Reset semantics are unchanged: no clamp-on-reset. The escape is
the existing `set_permission` narrowing path (accepted unconditionally,
`clamp_advertised_axis` §agents_channel.ex), after which an ordinary reset
passes because the pointer's snapshot is back within the ceiling.

**Trust model for the reset-time comparison.** The check compares
`resume_snapshot` — the server's `SessionPointers` pointer — against the
immutable per-agent `permissionCeiling` pinned at spawn/restore
(`Supervisor#start`). The pointer's sandbox / approval / network fields
are written only from the control the server judged `:applied`
(`record_confirmed_permission_snapshot`, `wrapper_channel.ex`), not
necessarily from the CURRENT wrapper generation: a stale prior
generation's `:applied` control can be re-published to the pointer across
a restart, transiently reintroducing a snapshot wider than the ceiling —
filed separately as issue #400 (deferred, medium priority) rather than
folded into #397's scope. #397 leaves this trust model and #400 untouched;
it only makes whichever refusal results diagnosable instead of a blank
`spawn_failed`.

### F5 — kaoiro tools through a CLI bridge, not MCP

`ToolHost` (Codex, unix socket NDJSON) is reused; `dist/bridge.js` becomes
a CLI (`list` / `call <tool> <json>`). `inter_agent` descriptors and
`ask_user_question` are served exactly as on Codex; a pending question
blocks the bridge process, which holds the turn (measured: long tool calls
hold). The rules file and a skill teach the invocation form.

The gate's automatic allow for bridge calls is a **whole-string match on
a metacharacter-free alphabet**, not a parse. `run_command` executes
through `bash` (measured: `$0` = bash), so any tokenizer of our own would
be betting on parity with bash's grammar. Instead the bridge accepts only
`node <abs> <bridge abs> list` or `node <abs> <bridge abs> call <tool>
<base64url payload>` and the gate auto-allows a `CommandLine` only when
it full-matches

```text
^<node abs path> <bridge abs path> (list|call [a-z_]{1,64} [A-Za-z0-9_-]{1,N})$
```

with N = 87 KiB (64 KiB of JSON, base64url-encoded), the tool name known
to the `ToolHost`, `Cwd` equal to the agent cwd, `WaitMsBeforeAsync` at
or above the wrapper's floor, and no unknown keys in `toolCall.args`.
Anything else falls through to the normal cell decision (cost of a false
negative = one operator approval). The bridge decodes and validates the
payload itself. The `ToolHost` socket carries no authentication beyond
the per-spawn nonce; a shell the agent runs can reach it directly, which is
inside the agent's own privilege — the bridge rule is a convenience, not a
security boundary, and the whole-string match is what protects the
*auto-allow*.

**`request_session_reset` (issue #396, ADR-0043 Neutral amendment).** Added
to the same `toolDescriptors` array, wrapped in `operatorApprovalGated`
(engine-neutral, `wrapper/agent-common/src/approval_gate.ts`) against this
adapter's existing `PermissionBroker` — Codex parity, since this engine has
no `canUseTool` hook either. The reservation dispatches only at its owning
turn's AUTHORITATIVE end; `AntigravityHostOptions.onTurnEnd` gained a
`terminal: boolean` field (true iff agy itself produced a `result` stream
event, independent of `is_error`) because the pre-existing payload could
not otherwise distinguish a real result from `outcome.kind === "stale"`
(a turn ended by `close()` or a superseded generation) — both looked
identical (no `error`, no `cancellation`) before this field existed.

### F5a — Inbound inter-agent messages are agy turns

`ServerLink.onInterAgentMessage` is handled in the Antigravity package. The
handler gives `InterAgentTool.receiveInbound()` first refusal: a consumed
reply, terminal closure, or stale delivery is not injected; each of those
non-injected dispositions completes delivery acknowledgement immediately.
Only a reply-owed or close-proposal message enters an `agy --print` turn.

`AntigravityInterAgentTurnCoordinator` is local to this adapter, rather than
an agent-common promotion. It owns same-peer FIFO batching, immutable turn
tokens, and delivery-sequence ownership. The coordinator records pending
injections immediately before dispatch to `AntigravityHost`; a host completion
settles only its matching token before a successor batch is released.

The delivery acknowledgement runtime observes the server watermark, immediate
non-injection acknowledgements, and host `onTurnStart`. For injected work,
`onTurnStart` occurs only after gate registration, a live epoch (issue
#377 Stage 2: freshly spawned, or already running from a prior turn --
either way, "the agy process this turn's line will reach" exists), AND
(issue #377 Stage 1 M4) a confirmed stdin delivery of the turn's prompt
line -- queue admission, a live epoch existing, or a bare `write()` return
alone is not a start; see F2's ack-point paragraph for the exact condition
and the `epoch_exit_before_turn` failure it guards against. The token and
all coalesced conversation ids stay with the host turn so tool calls and
failure notices cannot settle a later reuse of the same conversation id.

Antigravity has an adapter-local `TurnWatchdog`, configured by
`KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_INACTIVITY_MS` and
`KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_ABORT_GRACE_MS`. Parsed agy stream records
reset inactivity. Timeout requests SIGTERM only for the active token; expiry
of the grace period freezes new coordinator work and leaves the uncertain
active delivery for supervisor recovery. The same watchdog also owns the
absolute per-tool deadline `KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS` (issue
#350): a tool step still `ACTIVE` after it is terminated through the same
interrupt / grace path and the turn ends as `tool_timeout`
([Antigravity tools and permissions](../reference/engines/antigravity-tools-permissions.md)).

### F6 — Catalog: `agy models` at runner register, static snapshot fallback, account default entry

The runner runs `agy models` (quota-free) when `antigravity` is in
capabilities and publishes the slugs plus one explicit entry
`{ value: "", display_name: "account default" }` meaning "pass no
`--model`" (the measured account default `gemini-3.8-flash-high` was
absent from the list). On failure it publishes the 1.1.26 snapshot and
warns. Effort is hidden in Stage A; `ext.model_source` follows the phase-15
precedence with env `KAOIRO_ANTIGRAVITY_DEFAULT_MODEL`. No entry in
`LIVE_PROBE_ENGINES`. Stage A advertises `supports_effort_switch: false`; a
generic `set_effort` relay is logged and absorbed so unsupported control
traffic cannot terminate the wrapper.

The setup wizard presence-checks `agy` (via `resolveAgyExecutable`) as soon
as antigravity is enabled, printing the resolved path and `agy --version`
on success or failing with an install hint otherwise -- surfacing a missing
CLI at config time instead of only at first runner startup, where this
probe already degrades silently to the pinned snapshot. The runner also
reports `agy --version` alongside this probe on every register/reload,
warning when it changes since the last value THIS runner process observed
(in-memory only; no on-disk state file). This is reporting only: it does
NOT force a fresh `agy` epoch. F4b's gate registration smoke test already
re-runs on every new epoch spawn regardless of cause (`#verifyGateRegistration`,
called from `#spawnEpoch`, `host.ts`; no caching), so a version change is
covered the next time an epoch actually spawns on the new binary. A
long-lived epoch keeps running its already-verified old binary until
then -- not a gap, since that binary's gate registration was already
confirmed before this epoch started (issue #387, director-approved design).
Issue #410 carries the validated `agy --version` value as the optional
`antigravity_cli_version` field on runner `register`, including register
updates after config reload and catalog refresh. The server keeps it with the
live host entry and includes it in the operator-only `hosts` snapshot; it is
not persisted across server restarts. The dashboard validates the UTF-8 byte
limit and shows the selected Antigravity host's value or “not reported”.
Invalid optional values are dropped without rejecting an otherwise valid
register.

### F7 — Session capabilities in Stage A

`supports_attachments: false`, `supports_model_switch: true`,
`supports_context_usage: false`; `rate_limits` (Stage B1) via `-p /usage` mapped to the
`seven_day` window (`utilization = 1 - remaining_fraction`); the group is
"Claude and GPT models" when the active slug starts with `claude-` or
`gpt-`, otherwise "Gemini Models" (unknown slugs and the account default
fall into the Gemini group, which is where the account default lives).
Session enumeration
(Stage B3) reads `~/.gemini/antigravity-cli/conversations/*.db`; history
replay is Stage B2. Stage A ships with enumeration returning an empty list.

`supports_session_reset: true` / `session_reset_modes: ["new", "clear"]`
(issue #381): the agy CLI surface has no primitive that distinguishes the
two, so both modes drive the same fresh-relaunch operation the runner
already provides for every engine (`--conversation` dropped, a genuinely
new agy conversation on the next turn). The visible difference between
`new` and `clear` is entirely server-owned: `commit_connection`
(`session_resets.ex`) runs `ClearWatermarks.record` +
`AgentStates.clear_history_with_boundary` only for `clear`, and appends a
plain boundary for `new`. Consequence: ADR-0036 F3's "resume the old
session from the picker after `/clear`" does not hold for this engine in
Stage A, since session enumeration returns an empty list (above); the
underlying agy conversation db is not deleted, so this recovers once
Stage B3 ships enumeration.

### F8 — Documents that change with the trust story

threat-model.md gains a section for this engine (engine prompts disabled
per process, wrapper as sole enforcement point, tamper detection rather
than prevention for the customization dir, advisory sandbox, bridge
auto-allow rule); auth-and-authz.md gets the new boundary (hook → unix
socket with nonce). No host-wide setting is written (Q1), so deployment.md
is unchanged. These are acceptance items of phase-34, not follow-ups.

## Open questions

- **Q1 — closed 2026-09-04 (operator measurement)**:
  `--dangerously-skip-permissions` yields `init.permission_mode =
  "always-proceed"` for that process only, and the PreToolUse gate still
  fires for every tool step. F4 uses the flag; no host-wide setting is
  written and the setup wizard fallback is dropped.
- **Q2 — closed 2026-09-04**: the cwd is not a workspace root in print
  mode; passing `--add-dir <cwd>` as well restores it as the model's `Cwd`
  (F2). The gate's `Cwd` pin and the customization-dir deny stay as
  defence in depth.
- **Q3 — closed 2026-09-04**: environment variables reach both the hook
  and `run_command`; a hook exceeding its `timeout` is killed and the tool
  step fails without running (fail-closed on the CLI side too).
- **Q4 (Stage B)** — transcript format for history replay; conversation db
  schema; per-model context window table.

## Consequences

- Third engine with better approval fidelity than Codex and no new language
  in the codebase.
- The wrapper is the only enforcement point; F4b makes its absence
  detectable on every tool call instead of trusting the vendor mechanism.
- Vendor drift is expected (the binary self-updated mid-measurement); the
  `init.tools` diff runs on every spawn, and version reporting with
  re-triggered checks is Stage B4.
- Tool calls cost one extra `node` process each (hook) plus one per bridge
  call; acceptable at kaoiro's turn rate.

## Alternatives considered

| Alternative | Reason for rejection |
|---|---|
| Python SDK hosted as a child process with a custom event bridge | Second language and a bespoke protocol; the CLI already provides an event stream and resume |
| Python wrapper speaking the kaoiro protocol directly | Violates ADR-0023 type sharing; duplicates the whole agent-common layer |
| Resident `--input-format stream-json` process | No interrupt / control channel; would still need kill-and-resume |
| `settings.json` `permissions.allow` rules per command | Host-wide, static, exact-match only; no operator round trip |
| Prefix match for the bridge auto-allow | Trivially bypassed by shell chaining (`; curl … \| sh`) |
| `--sandbox` as the sandbox axis | Measured ineffective; would present a guarantee that does not exist |
| Custom agent (`--agent`) for persona | Unknown whether it replaces default scaffolding; rules file is sufficient and measured |
