---
title: Antigravity events
description: Current event, state, session, model, usage, and host contract for the Antigravity CLI adapter.
status: provisional
last_updated: 2026-09-18
related: [protocol, antigravity-adapter]
---

# Antigravity events

## Definition

### Main API and process model

```text
agy --print "<turn text>" \
    --output-format stream-json \
    --print-timeout <duration> \
    [--conversation <conversation_id>] \
    [--model <slug>] [--effort low|medium|high] \
    --add-dir <agent cwd> --add-dir <per-agent customization dir> \
    [--dangerously-skip-permissions] --disable-slash-commands \
    </dev/null
```

- **One `agy` process per turn** *(measured)*, the same spawn-per-turn model
  as `codex exec`. The first turn creates a conversation (its id arrives in
  the `init` event); every later turn passes `--conversation <id>`.
  Spawning from Node `child_process.spawn` with piped stdio works; running
  under `setsid` (no controlling tty) works *(measured)*.
- **stdin must be closed** *(measured)*: with stdin left open the run ends
  after ~3 s with `result.status = "ERROR"`, `error: "timeout waiting for
  response"`, and no assistant output. The conversation still persists.
- **Resident alternative** *(measured, not adopted for Stage A)*:
  `agy --print='' --input-format stream-json --output-format stream-json`
  keeps one process open and runs one turn per stdin line
  `{"event":"user","message":{"content":"<text>"}}`. Only the `user` event
  is recognised; any other `event` value is ignored with a stderr warning
  (`warning: ignoring unsupported stream input message event "…"`), so there
  is no in-band interrupt, permission, or model-switch channel. Each turn
  emits its own `result`.
- **`--disable-slash-commands`** *(flag present in 1.1.26)*: print mode
  otherwise expands slash commands and skills found in the prompt text, so an
  operator instruction starting with `/` would enter the CLI control plane.
  Every instruction turn passes the flag; the wrapper's registration probe
  (`-p /hooks`) runs without it.
- **Interrupt** = terminate the child (SIGTERM). The conversation remains
  resumable by id afterwards *(measured after ERROR-terminated turns)*. What
  the child prints on receiving a signal mid-stream is *(unverified)*; the
  adapter must treat child exit without a `result` as end of turn.
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
- **`--print-timeout`** is a Go duration; `24h` is accepted *(measured)*.
  Set it long because a turn can legitimately block on an operator decision
  (permission gate, ask_user_question) — see below.
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
| child exit without `result` | `error` (`agy_exit_without_result`) |
| `init` (first turn) | session id = `conversation_id` (SessionPointers) |

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
  low|medium|high` is accepted *(measured; effect not separately
  observable — gemini slugs already encode the tier)*.
- Slash commands answered without a model turn or quota spend
  *(measured)*: `agy -p /usage --output-format json` →
  `command.data.groups[].buckets[]` with `window: "weekly"`,
  `remaining_fraction`, `reset_time` (two groups: "Gemini Models" and
  "Claude and GPT models"); `-p /model` → current model/effort;
  `-p /permissions`, `-p /hooks`, `-p /help`.
- **Wrapper quota projection:** a terminal `result.error` that contains a
  `RESOURCE_EXHAUSTED` / HTTP 429 marker and a compact `Resets in <NhNmNs>`
  duration is fail-soft mapped to `peer_error.code = "rate_limit"` and
  `rate_limits.seven_day = {status: "blocked", utilization: 1, resets_at}`.
  The parser accepts only the observed compact duration grammar; an
  unrecognised terminal error remains the ordinary API error. The actual CLI
  `result.error` terminal shape has not yet been measured; this mapping is
  inferred from the internal-log string shape.
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
