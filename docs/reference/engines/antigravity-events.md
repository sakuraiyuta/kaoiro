---
title: Antigravity events
description: Current event, state, session, model, usage, and host contract for the Antigravity CLI adapter.
status: provisional
last_updated: 2026-10-09
related: [protocol, antigravity-adapter]
---

# Antigravity events

## Definition

### Main API and process model

```text
agy --print "" \
    --input-format stream-json \
    --output-format stream-json \
    --print-timeout <duration> \
    [--conversation <conversation_id>] \
    [--model <slug>] [--effort low|medium|high|xhigh|max] \
    --add-dir <agent cwd> --add-dir <per-agent customization dir> \
    [--dangerously-skip-permissions] --disable-slash-commands
```

- **One `agy` process per epoch, several turns each** *(measured; issue
  #377 Stage 2)* — an "epoch" spans every turn whose spec (conversation id,
  model, effort, `--add-dir` set) matches the live process's; a mismatch
  ends it and spawns fresh. The first turn of a fresh epoch creates a
  conversation (its id arrives in the `init` event, and the epoch adopts it
  as its own from that point on); a respawn passes `--conversation <id>`
  to continue the same logical conversation in a new process. Spawning from
  Node `child_process.spawn` with piped stdio works; running under `setsid`
  (no controlling tty) works *(measured)*. Only the `user` event is
  recognised on stdin; any other `event` value is ignored with a stderr
  warning (`warning: ignoring unsupported stream input message event "…"`),
  and `control_request` / `control_response` are rejected as unsupported,
  so there is no in-band interrupt, permission, or model-switch channel
  over stdin *(measured, [print-mode-background-tasks.md](../../evidence/antigravity/print-mode-background-tasks.md))*.
  Each turn still emits its own `result`, in order, including one
  `num_turns` incrementing across the epoch's turns *(measured)*.
- **Prompt over stdin, not argv** (issue #377 Stage 1, adapted for Stage
  2's epoch reuse): the wrapper writes exactly one NDJSON line,
  `{"event":"user","message":{"role":"user","content":"<turn text>"}}\n`, to
  the epoch's stdin per turn -- kept OPEN across turns (Stage 1 additionally
  closed it after the turn's only line; Stage 2 does not, since the process
  outlives its first turn); an unrecognised message shape (missing the
  `event` key) is rejected with `result.status = "ERROR"` *(measured)*.
  This replaces the earlier argv-positional prompt: `agy --print`'s argv
  mode clamps `WaitMsBeforeAsync` at 10s and terminates any `run_command`
  the CLI promoted to a background task 5s after the model's last text,
  silently losing any tool call longer than ~10s
  ([print-mode-background-tasks.md](../../evidence/antigravity/print-mode-background-tasks.md));
  `--input-format stream-json` instead waits for a promoted task before
  emitting `result` *(measured)*, so the wrapper's own tool deadline governs
  it as intended. The delivery ack fires only once this write is confirmed,
  never merely once `write()` returns; see
  [ADR-0057 F2](../../adr/0057-antigravity-adapter.md#f2--process-model-one-agy-process-per-epoch-prompt-over-stdin-sigterm-to-end-it)
  for the exact ack point, the `EpochSpec`/respawn model, and the epoch-end
  reasons.
- **`--disable-slash-commands`** *(flag present in 1.1.26)*: print mode
  otherwise expands slash commands and skills found in the prompt text, so an
  operator instruction starting with `/` would enter the CLI control plane.
  Every instruction turn passes the flag; the wrapper's registration probe
  (`-p /hooks`) runs without it.
- **Interrupt** = end the epoch (SIGTERM, then a grace-bounded SIGKILL). The
  conversation remains resumable by id afterwards *(measured after
  ERROR-terminated turns)*; the next turn respawns with `--conversation
  <id>`. What the child prints on receiving a signal mid-stream is
  *(unverified)*; the adapter must treat epoch exit without a `result` as
  end of turn.
- **Ordinary interrupt preserves queued turns** (issue #358). Interrupt aborts
  only the active turn; turns already queued behind it are kept, and the drain
  loop runs each afterwards under the new lifecycle generation with its own
  delivery token. A queued inter-agent turn is an already-accepted delivery, so
  dropping it silently would strand the sender's ledger with no ack and no
  notice; preserving it lets the normal `onTurnStart` ack and `onTurnEnd`
  settlement close it. Antigravity rejects attachments at `send()`, so the
  queue never holds a temp turn to discard (unlike Codex's `#dropQueuedTempTurns`,
  which keeps text turns and drops attachment turns). The active turn's own
  attribution is unchanged, and any interrupted-notice for it is out of scope
  here (a separate #351-class question). Queue retirement on close / fail-stop
  (`reason: interrupted`) is issue #354's explicit path, at the coordinator
  level, and is independent of the host queue.
- **`--print-timeout`** is a Go duration; `0` is the CLI's own documented
  default ("waits until the turn completes", `agy --help` *(measured)*) and
  is what the wrapper passes (issue #377 Stage 2; Stage 1 used the shorter
  `24h`, measured not to change promotion or error behaviour either way --
  [print-mode-background-tasks.md](../../evidence/antigravity/print-mode-background-tasks.md)).
  A turn can legitimately block on an operator decision (permission gate,
  ask_user_question) or a promoted background task; the wrapper's own
  `TurnWatchdog` is what actually bounds a turn, not this flag.
- `--mode accept-edits|plan` is accepted but does not change
  `init.permission_mode` *(measured)*; its runtime effect is *(unverified)*
  and not used by the adapter. `--sandbox` is likewise accepted and had no
  observable effect (see Permission).

### stream-json events (actual 1.1.26 shapes)

Three top-level `event` kinds, one JSON object per line *(measured)*:

```jsonc
{"event":"init","conversation_id":"<uuid>",
 "init":{"cwd":"/abs/path","permission_mode":"request-review",
         "tools":["ask_permission","ask_question","call_mcp_tool","run_command", "..."],
         "model":"gemini-3.6-flash-low",   // present only when --model was given
         "agent":"kaoiro"}}                // present only when --agent was given

{"event":"step_update","step_update":{
  "conversation_id":"<uuid>","step_index":1,
  "state":"ACTIVE|DONE|ERROR",
  "step_type":"user_input|agent_response|tool|system_message",
  "text_delta":"PONG",                       // agent_response only (may be absent)
  "tool_name":"run_command",                 // tool only
  "tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -1"},
               "output":"a.txt\r\n",         // DONE, some tools
               "error":{"type":"TOOL_ERROR","message":"…"}},   // ERROR
  "duration_seconds":4.8,
  "usage":{"input_tokens":5718,"output_tokens":34,"thinking_tokens":32,
           "cache_read_tokens":8130,"total_tokens":5752}}}     // DONE agent_response

{"event":"result","result":{
  "conversation_id":"<uuid>","status":"SUCCESS|ERROR|CANCELED",
  "response":"PONG\n","error":"…",           // error present on ERROR
  "duration_seconds":4.9,"num_turns":1,
  "usage":{…},
  "denied_actions":[{"action":"command","display_name":"RunCommand"}]}}  // optional
```

Observed details:

- `permission_mode` values seen: `request-review` (default) and
  `always-proceed` (when `settings.json` `toolPermission` is
  `always-proceed`). `init.tools` is the full tool inventory (57 names in
  1.1.26); it is not filtered by permission.
- `agent_response` steps stream `text_delta` fragments while `ACTIVE` and
  close with `DONE` + `usage`. A thinking-only step emits `DONE` with
  `thinking_tokens > 0` and no `text_delta`.
- `tool` steps go `ACTIVE` → `DONE|ERROR`; `tool_info.parameters` carries
  the raw tool arguments (`CommandLine`, `AbsolutePath`, `DirectoryPath`,
  `Query`, …). `output` is present on `DONE` for `run_command`, `grep_search`,
  `find_by_name`, `view_file` (summary), not guaranteed for every tool.
- `system_message` steps appear on resumed conversations.
- `result.status = "CANCELED"` was observed once together with
  `denied_actions` after a permission auto-deny; treat it as a normal end of
  turn, not an error.
- Non-ASCII in `text_delta` is passed through *(changelog fix, unverified)*.
- Per-turn baseline is ~5.7k `input_tokens` (system prompt) *(measured)*.

### State derivation

| Observation | kaoiro state / envelope |
|---|---|
| child spawned | `thinking` |
| `step_update` `agent_response` `ACTIVE` (+`text_delta`) | `thinking`; `text_delta` accumulates into the assistant text (log payload) |
| `step_update` `tool` `ACTIVE` | `tool_running`, `ext.tool_name = tool_name`, input = `tool_info.parameters` |
| `step_update` `tool` `DONE` / `ERROR` | back to `thinking`; ERROR logs `tool_info.error.message` |
| hook gate awaiting operator (see Permission) | `waiting_permission` with `ext.pending_permission` (ADR-0022) |
| bridge `ask_user_question` pending (see Tool definition) | `waiting_input` with `ext.pending_question` (ADR-0027) |
| `result` `SUCCESS` / `CANCELED` | `done`; `response` is the final text |
| `result` `ERROR` | `error` with `result.error` |
| epoch exit without this turn's own `result` | `error` (`agy_exit_without_result`) |
| `init` (first turn) | session id = `conversation_id` (SessionPointers) |

The transcript reports the two observed pre-execution argument rejections as
`INVALID`; the live stream reports tool `step_update` events with
`state: ERROR`, `tool_info.error.type: TOOL_ERROR`, and either
`invalid arguments:\n- additional properties 'Action' not allowed` or
`invalid arguments:\n- missing property 'toolSummary'`. These are the only
allowlisted forms, and only when the gate server has no matching request. See
[Antigravity tools and permissions](antigravity-tools-permissions.md#gate-fault-and-recovery-adr-0057-f4b)
for fixture provenance and evidence limits; a live logging stub is not the
production `GateServer`.

An ADR-0057 F4b gate fault also exposes `error` and ends the epoch. Queued
peer batches are settled and retired without acknowledgement as model input.
The first eligible model-bound input may be held as the sole recovery
candidate; if the gate smoke test or replacement-child start fails, that input is rejected
and not replayed. A successful recovery clears the visible error before
`user_send`, but remains probationary until one dispatched turn returns a
normal successful result. See
[Antigravity tools and permissions](antigravity-tools-permissions.md#gate-fault-and-recovery-adr-0057-f4b)
for candidate sources and notice timing.

### Session / conversation resume and enumeration

- Resume: `--conversation <id>` *(measured)*; `--continue` resumes the most
  recent conversation (not used: ambiguous across agents on one host).
- Store: `~/.gemini/antigravity-cli/conversations/<id>.db` (sqlite, one per
  conversation) and `conversation_summaries.db` *(paths measured; schema
  unverified)*.
- Transcript for history replay:
  `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`
  *(path from the hook payload; format unverified — Stage B)*.
- A conversation opened in two processes at once is only advised against
  by a banner *(changelog)*; the wrapper serialises turns anyway.

### Models, effort, usage, rate limits

- `agy models` prints one model per line as `<slug><TAB><display name>`
  on stdout (progress goes to stderr) *(measured 2026-09-04 evening via a
  pipe and via `execFile`: 14 lines, e.g. `gemini-3.8-flash-high\tGemini
  3.8 Flash (High)`; 1.1.26 rejects `--output-format` on this subcommand)*.
  An earlier run the same day printed bare slugs without the 3.8 family, so
  the format and the list both drift with the vendor; the parser takes the
  first tab-separated column as the slug, the second as display name,
  accepts a bare-slug line, and falls back to the static snapshot on
  anything else. `--model` must receive the slug only (a value containing
  the display name fails with exit 1, measured by the reviewer).
- `--model <slug>` echoes into `init.model` *(measured)*; `--effort
  low|medium|high|xhigh|max` is accepted *(measured in 1.3.1; effect not separately
  observable — gemini slugs already encode the tier)*.
- Slash commands answered without a model turn or quota spend
  *(measured; see [usage-rate-limits evidence](../../evidence/antigravity/usage-rate-limits.md))*:
  `agy -p /usage --output-format json` →
  `command.data.groups[].buckets[]` with bucket ids in `gemini-*` and `3p-*`
  families and `window` values `5h` / `weekly`; `-p /model` → current model/effort;
  `-p /permissions`, `-p /hooks`, `-p /help`.
- **Wrapper rate-limit state:** a terminal `result.error` containing a
  `RESOURCE_EXHAUSTED` / HTTP 429 marker with a positive parsed reset delay
  creates the usual blocked `seven_day` overlay with that future `resets_at`.
  It remains a peer-facing `rate_limit`; it does not start a stale-error
  confirmation or change the stale-confirmation count. An expired reset remains
  published until a successful terminal turn, while it makes an ordinary
  probe eligible at a later turn boundary.
- A terminal 429 whose reset delay is zero or unreadable creates a blocked
  overlay and immediately settles the peer turn as `rate_limit`. If the
  attempted and committed model both have the same classified family, one
  same-family `/usage` confirmation may later clear only this terminal-derived
  overlay when both expected buckets are present and positive. That state
  update does not rewrite the completed peer error. The measured sanitized
  stream and `/usage` response used by the host test are in
  [issue-393-terminal-stream.json](../../evidence/antigravity/issue-393-terminal-stream.json)
  and [issue-393-usage-output.json](../../evidence/antigravity/issue-393-usage-output.json).
  The one-turn production-composition check is recorded in
  [issue-393-live-acceptance-2026-10-03.md](../../evidence/antigravity/issue-393-live-acceptance-2026-10-03.md);
  the follow-up live envelope record is in
  [issue-393-live-acceptance-r2-2026-10-03.md](../../evidence/antigravity/issue-393-live-acceptance-r2-2026-10-03.md).
- The host counts confirmed stale terminal 429s per committed family. After
  two positive same-family confirmations, another zero-delay or unreadable
  terminal 429 for that family is reported as `api_error`, without an overlay
  or another confirmation probe. The wrapper emits one operator-visible
  `system` log prefixed `antigravity_terminal_429_unconfirmed:` explaining
  that the conversation may be repeating an old error and suggesting a
  session reset. The threshold log states that the last two same-family
  confirmations showed quota remaining. A successful terminal turn, a complete
  same-family usage snapshot with any expected bucket at zero, a committed
  family change, or a changed session id resets the count. The count is held
  in memory, so a wrapper restart can allow up to two additional conservative
  `rate_limit` responses.
- The stale-error path is terminal-only. Non-terminal 429 event shapes are not
  interpreted until a real runtime-shaped event is captured. Positive usage
  from an ordinary same-family probe started after an ambiguous terminal
  overlay can also clear it and count once; a pre-existing probe, a partial
  snapshot, an empty bucket, another family, or a positive-delay overlay cannot.
- `/usage` snapshots are tied to the committed model family. A model change
  within the same family retains the snapshot; a family change or an
  unclassified committed model invalidates it. A pending `setModel` does not
  change the family. Cache and 429 overlay are composed on every state publish;
  for an unclassified model, only the independent overlay can appear.
- An agent with no configured model uses agy's default model but remains
  unclassified, so it publishes no `/usage` rate limits.
- Usage probes start only at an idle turn boundary. There is no general idle
  refresh timer. A pending stale-terminal confirmation that is blocked only by
  the #496 retry floor schedules one unref'd timer for the floor deadline; it
  rechecks the ordinary gates once when it fires. The timer is cancelled by
  host close, admission of a new turn, a committed family change, successful
  terminal reset, or when the confirmation starts. Valid snapshots are throttled
  for five minutes from capture. After a failed `/usage` attempt, further
  attempts wait five minutes from that attempt's start (including spawn throws,
  timeouts, nonzero exits, and unusable output), including across successful
  turns and model-family changes; a later successful probe clears this failure
  floor. An interrupt abort still counts as a stopped probe for warnings and
  consecutive-failure suppression, but does not start the retry floor. Three
  consecutive current-family failures independently
  suppress retries until a successful turn clears the failure count, but that
  turn does not clear an active floor. An ordinary retry waits for a later
  terminal boundary after the floor; only the retained stale-terminal
  confirmation uses its single timer. A family change after a successful probe
  can still trigger an immediate probe. The register-time catalog probe is
  independent of these rules.
- A timeout, interrupt, family change, or host close sends one checked PID
  `SIGKILL` and waits up to two seconds for the probe child's `close` event.
  If the wait expires, the child stays held in `stop_timed_out` and blocks new
  probes until a late `close`; a late close while open releases it and counts
  one failed attempt. On host close, probe stop and epoch shutdown run in
  parallel within the runner's five-second outer bound. See the
  [stop measurement](../../evidence/antigravity/issue-384-probe-stop-2026-10-03.md).
- Context window sizes are not exposed; `usage.input_tokens` of the last
  `agent_response` step approximates context in use.

### Authentication and host requirements

- OAuth personal login stored under `~/.gemini/` (`selectedAuthType:
  "oauth-personal"`); the child inherits the wrapper's environment and HOME,
  so no credential handling in kaoiro (ADR-0032 F7 convention).
  `GEMINI_API_KEY` is the API-key alternative *(docs, unverified)*.
- Requires `agy` on `PATH`. The runner probes `agy models` at register
  time (quota-free); reporting `agy --version` and re-triggering checks on
  a version change is Stage B4. This spec was measured against 1.1.26, and
  a version change is the trigger to re-run the measurements marked
  *(measured)* here, because the binary self-updates.

## Constraints

- No attachments in Stage A (`--print` takes text only).

- No context-usage capability until a per-model window table exists.
