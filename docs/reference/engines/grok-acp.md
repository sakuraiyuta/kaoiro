---
title: Grok Build ACP engine
description: Resident ACP host, tools, permissions and unsupported operations.
status: accepted
last_updated: 2026-10-18
---

# Grok Build ACP engine

The `grok` engine requires Grok Build on `PATH`. The wrapper launches
`grok --no-auto-update agent --no-leader stdio` once, initializes one ACP session
(`session/new`, or `session/resume` for a cold resume) and
uses `session/prompt` for each queued turn. It does not launch `grok -p`
per turn. The ACP SDK is pinned to 1.8.0.

`--no-leader` overrides `cli.use_leader`: the wrapper must own the backend
whose sandbox environment it sets and whose process group it terminates.
Connecting to a shared leader would break those ownership assumptions.

The server-composed persona and common footer are sent in `session/new`
`_meta.rules`. The kaoiro tools are served by the wrapper's ToolHost as an
HTTP MCP server on `127.0.0.1` and passed as `mcpServers` with a per-run
bearer token (see [Tool transport](#tool-transport)). Grok discovers tools
through its `search_tool` and `use_tool` interfaces.

## Tool transport

`ToolHost` listens on `127.0.0.1` at a free port, one host per `run()`, and
serves the MCP Streamable HTTP protocol statelessly (a fresh MCP server per
request, JSON responses). The `mcpServers` entry is
`{ type: "http", name: "kaoiro", url: "http://127.0.0.1:<port>/mcp",
headers: [{ name: "Authorization", value: "Bearer <token>" }] }`. Grok
connects from its own process, so a sandbox profile that blocks `connect(2)`
on `AF_UNIX` for its child processes (`read-only`) does not stop it; the
earlier stdio bridge was such a child and could not reach the ToolHost under
that profile.

Every request passes these checks in order, using only its request line and
headers, so a rejected request has its body unread. The first failing check
decides the response:

1. `Host` must equal the listener's authority, `127.0.0.1:<port>`, exactly
   (so `localhost` and any other port are refused): 403.
2. A request that carries an `Origin` header, with any value including `null`,
   gets 403. Grok's MCP client sends none.
3. `Authorization: Bearer <token>` must match the token of this ToolHost,
   compared as a constant-time comparison of SHA-256 digests: 401, with
   `WWW-Authenticate: Bearer`.
4. Only `POST /mcp`: 404 for another path, 405 for another method.
5. A `Content-Length` over 1 MiB gets 413 before the body is read; a body
   that passes 1 MiB while it is read (chunked) also gets 413.

The token is 32 random bytes (base64url), created when the ToolHost starts,
held in memory, and used only for that host. It travels in the ACP request's
`headers`, never in the URL: Grok stores MCP server URLs in its session files
(measured), so the URL must not carry a secret. The token is not in the
child's argv or environment, the diagnostic records, status or envelopes.
Closing the ToolHost stops listening, severs every connection and aborts every
call in flight.

Startup fails closed with a reason. After `initialize` the agent must report
`mcpCapabilities.http` ("grok does not support HTTP MCP servers" otherwise).
After `session/new` the host waits until Grok has made one authenticated
`tools/list` call, because on a transport or token fault Grok carries on
without the server and reports nothing ("kaoiro MCP server did not
connect" after 15 s). `waiting_input` is reported only after both.

## ACP module boundary

`wrapper/grok/src/acp/` is engine-neutral so that it can move to
`agent-common` when a second ACP engine arrives. It refers only to ACP
methods and `@agentclientprotocol/sdk` types. Vendor behaviour reaches it
through injection points; Grok's side of each lives in `src/grok/wire.ts`
and `src/grok/events.ts`.

| Injection point | Where | Grok's value |
|---|---|---|
| `session/new` `_meta` | third argument of `AcpSession.open`, passed by value (the host already holds everything it needs; no builder function) | `grokSessionMeta(rules)`, that is `{ rules }` |
| Extra notifications | `AcpExtension.notifications` of `connectAcp`: method, parser and handler per entry. The method must start with `_` (ACP's extension-name convention); any other name, including every ACP method, makes `connectAcp` throw | `_x.ai/session_notification`, handled by the host's turn-completion match |
| Wire-metadata fields | `AcpExtension.wireFields` of `connectAcp` and `metadataTee`: a function from one parsed JSON-RPC line to extra fields, merged after `variant` | `grokWireFields`: `vendor_kind`, `prompt_id`, `request_id`, `hook_event`; the host adds `loading_lines_dropped` |

`acp/` itself records `direction`, `method`, `variant`, `sdk_diagnostic` and
`oversized_lines`. With no extension it registers ACP methods only and adds
no vendor fields: an unknown notification is dropped by the SDK. The
extractor must not throw; if it does, that line's metadata is dropped and
the transport is not interrupted. Grok's reads of a prompt result `_meta`
(`promptId`, `cancellationCategory`) are the pure functions `promptIdOf` and
`cancellationKind` in `grok/events.ts`, called by the host, so `acp/` never
sees them.

`test/acp-boundary.test.ts` fails when any file under `src/acp/` names
`_x.ai`, `GROK_`, `grok`, a Grok `_meta` or wire-metadata key
(`promptId`, `requestId`, `prompt_id`, `request_id`, `cancellationCategory`,
`vendor_kind`, `hook_event`), uses `rules` as code, or has a module specifier
that resolves outside `acp/`. The specifiers read are those of imports,
re-exports, `import x = require()`, import types, and `import()` and
`require()` calls; each relative one is resolved from its own file's
directory, and one that is not a string literal counts as outside.

## Capabilities

The adapter supports text turns, conversation continuity while the wrapper
is resident, cancellation, operator permission requests, user questions,
normal peer messages and dispatch confirmation. Early and yield delivery
are explicitly `none`. Reply-basis v1 is not negotiated: Grok MCP calls do
not carry turn-origin identity, so the MCP server cannot prove it.

The runner's launch catalog is read from a short-lived `initialize` (see
[Launch catalog](#launch-catalog)). A launch pick or a resumed pair is
applied when the session starts (see
[Start selection and restore hold](#start-selection-and-restore-hold)). Cold
resume and the session picker are supported (see
[Cold resume and session discovery](#cold-resume-and-session-discovery)).
Live model and effort switching and context usage are supported when Grok
lists its configuration options (see
[Model and effort switching](#model-and-effort-switching) and
[Context usage](#context-usage)). The dashboard history of a resumed session
is replayed from Grok's log (see
[Dashboard history on resume](#dashboard-history-on-resume)). Attachments are
unsupported. Weekly account allowance reporting is available through
`rate_limits` (see [Account rate limits](#account-rate-limits)). Unsupported
controls reject explicitly.

Session reset is unsupported in both directions. The adapter advertises
`supports_session_reset: false`, so operator, self and director-requested
resets of a Grok agent are refused with `unsupported_session_reset`, and its
tool list does not register `request_session_reset`. Separately, the adapter
does not negotiate `work_control` on join and does not register the director
tool `request_peer_session_reset`
([ADR-0068](../../adr/0068-director-requested-peer-session-reset.md)). Both are tracked by
[issue #658](https://github.com/sakuraiyuta/kaoiro/issues/658).

## Cold resume and session discovery

The runner discovers sessions with a short-lived
`grok --no-auto-update agent --no-leader stdio` in its own process group: it
sends `initialize`, pages `session/list {cwd}` and kills the group. A probe
has a 10 s deadline and reads at most 20 pages. Its teardown is bounded and
covers the whole group, even when Grok itself exited first: SIGTERM, then
SIGKILL after 1 s to whatever is left, then up to 1 s more; a group still
present after that does not keep the probe from settling. Any failure, a
malformed response included, gives an empty list and a failed existence check
(`session_not_found`); a partial list is never returned. Every supervisor
caller that starts a probe owns its abort: a pending resume spawn, a pending
`switch_session` check, the latest session enumeration and `stopAll`. A stop,
a newer request or shutdown aborts the probe and kills its process group. Grok
writes a new session to disk a moment after `session/new`, so a session
created a moment ago may not be listed yet.

The wrapper's first lane attaches with `session/resume` (session id, launch
cwd, the fresh MCP server) instead of `session/new`. Resume replays no
history. Grok answers `-32603` for an unknown id and for a session bound to
another cwd; the start then fails with `grok could not resume the session`.
Without `sessionCapabilities.resume` the start fails too. Persona rules are not
sent again: the rules given at creation stay with the session. A later
permission switch still uses `session/load`. Every status carries `ext.cwd`.

The runner's same-session lock (F4) covers the agents it manages. Grok itself
lets a second process resume a session another process holds, so a Grok TUI or
another host on the same session is outside that lock.

## Dashboard history on resume

`session/resume` replays nothing, so a resumed agent's dashboard history is
rebuilt from Grok's own conversation log. When the server asks for a replay
(the join verdict, on startup and on every later reconnect) or, for a server
that sends no verdict, once at startup of a resumed session, the wrapper reads
the session's `updates.jsonl` and sends the newest 200 entries between the
history reset and the replay completion. A session with no readable file, and
a fresh session, still get the reset and the completion with no entries.

Where the file is. The session directory is
`<GROK_HOME or ~/.grok>/sessions/<group>/<session id>/`. The group is the cwd
in RFC 3986 percent-encoding: `encodeURIComponent` leaves `! ' ( ) *` alone and
Grok escapes them as `%21 %27 %28 %29 %2A`. When the encoded name would exceed
255 bytes, Grok names the group `<hex>-<hex>` and writes the cwd, with no
newline, to a `.cwd` file in it; the wrapper then finds the group whose `.cwd`
equals the cwd exactly. A session id other than letters, digits and hyphens
(at most 128) finds nothing.

What is read. The last 8 MiB of the file, starting at the first line boundary
inside that window, and each line up to 1 MiB; a longer line is skipped. A
line counts only when it is a JSON object with a string `method`, an object
`params` and a `timestamp` that is an integer number of epoch seconds
(`1e9 <= t < 1e11`). Seconds become an ISO time; a string, a float or a
millisecond-sized value skips the line and the reader never falls back to the
current time. Only `session/update` with a string `sessionUpdate` is mapped.

| Record | Entry |
|---|---|
| `user_message_chunk` (text) | `user`, built with `clipText`; chunks with the same `_meta.promptIndex` are joined. A formatted inter-agent turn is dropped, because the structured inter-agent envelope shows it |
| `agent_message_chunk` (text) | `assistant`, consecutive chunks joined |
| `tool_call` | `tool_use` with `tool_use_id` (the `toolCallId`), `tool_name` (the `title`, as the live path names it) and `input` (`rawInput`, `{}` when absent; an oversized input is dropped as live) |
| `tool_call_update` with `status` `completed` or `failed` | `tool_result` with the same id; its text content items joined with a newline, and the tool name taken from the `tool_use` |
| every other `session/update` variant, `_x.ai/session/update` and any other method | skipped |

A join ends only at a recognized record of another kind, never at a skipped
line, and takes the time of its first chunk. A join stops taking text once it
holds more than 16 KiB and is then clipped, so a huge reply costs bounded
memory. Each line is handled on its own: a line that fails is skipped and
counted by reason (`invalid_json`, `invalid_shape`, `bad_timestamp`,
`oversize_line`, `invalid_chunk`, `invalid_tool`) and never fails the file. The
counts go to stderr in one line with no content. A tool call whose result is
empty still gets an empty `tool_result`.

The live log path publishes a `tool_use` without its id or input and no
`tool_result`, so the replayed history shows more than the live log did. See
the [dated evidence](../../evidence/grok/2026-10-15-history-replay.md).

## Launch catalog

The runner reads the launch catalog with the same short-lived Grok as session
discovery, sending `initialize` only, which creates no session. The probe
starts once the runner's server link and shutdown path exist. Until it
answers, the catalog is the last good reading, else the `default` entry
alone, so for a few seconds after the runner starts the launch dialog offers
`default` only. A success re-broadcasts the register. A config reload aborts
the probe in flight and starts another, a Claude catalog refresh keeps the
Grok catalog, and shutdown aborts the probe before it stops the agents.

The reading is `_meta.modelState`, validated whole: every `modelId` matches
`[A-Za-z0-9._:-]{1,128}`, is unique and is not `default`; every model has a
name; a description, when present, is text; reasoning efforts, when present,
are a list of entries with a value; and `currentModelId` is listed. The
catalog is `default` followed by one entry per model with its effort levels
and default effort. Any failure (spawn, the 10 s deadline, a JSON-RPC error,
an invalid reading) keeps the last good catalog, else `default`, and is
logged.

Limit: when Grok cannot fetch its model list and has no fresh cache, it
answers with a built-in list, and nothing in the answer marks it. The runner
shows that list as Grok reports it, as the running agent does.

Quota: the committed tests pin what the probes send.
`runner/test/grok-catalog.test.ts` checks that the catalog probe sends
`initialize` and nothing else, and that the session-list probes send
`initialize` and `session/list` only. That these requests attempt no model
request is a dated measurement of Grok 1.0.52, not a committed test (see the
[catalog evidence](../../evidence/grok/2026-10-15-catalog-and-quota.md)).
Grok ran in a network namespace with loopback only, next to a recorder, and a
prompt first showed its model requests (`POST /v1/responses`) there. For the
catalog and list probes, the recorder then saw only the GETs `/`,
`/v1/models`, `/v1/settings`, `/v1/feedback/config`, `/v1/bundle/archive`
and `/v1/subagents/bundle`; the evidence page lists what it could not see.
The measurement says nothing about billed quota or other Grok versions, and
it has to be repeated when Grok is upgraded.

## Start selection and restore hold

The launch pick, or the model and effort pair the runner relays with a resume
(its 5-case source rule), is the start selection. A model of `default` counts
as no request. It is pending from the first status: `ext.pending_model` and
`ext.pending_effort` show it, and the server stores no snapshot while they do.
After the session starts, a value Grok already holds needs no request and
takes its requested source; a differing one goes through the switch path below
before the first prompt and keeps its relayed source (`launch`, `env` or
`config`). Model and effort keep separate sources: an operator switch stamps
`config` on the axis it changes only.

A start axis that cannot be applied is held: the model is not in the catalog,
Grok rejects the request, the session offers no usable `configOptions`, or the
effort was not sent because the model request failed. `switch_error` is still
published once. While an axis is held, `ext.effective` keeps the requested
value and source, so every status persists it and the next spawn request
(resume, restart) retries it. The top-level fields and whoami show what Grok
runs: the model as `displayed_model` with `model_source: "fallback"` (`default`
when Grok offers no selection), the effort with `effort_source: "default"`. A
successful switch of that axis, or a load that finds the requested value,
releases the hold. A crash restart relays the original start pair from the
runner's last spawn, as for every engine.

Limits: while an effort is held the dashboard's effort row shows the requested
effort (it reads `effective.effort`), so the dashboard does not reveal an
effort hold; whoami and the top-level `effort_source` do. The dashboard's text
for a `fallback` model is worded for Claude's safety mechanism (issue #649).

## Permission projection

Approval decisions are made by grok from the Claude settings it loads;
kaoiro receives the requests grok sends. The launch-fixed approval axis is
projected as `on-request`, as with Claude Code auto mode. This is a declared
projection, not a promise that every call asks the operator.

On Linux, read-only maps to `read-only` and always has effective network
access false, regardless of the raw toggle. Workspace-write with network on
maps to `workspace`; network off is unsupported. Danger-full-access maps to
`off` with effective network true, regardless of the raw toggle. Restrictive
profiles report enforcement `os`; `off` omits the observation's enforcement.
Only `off` is accepted off Linux, where permission switching is unavailable.

Grok's profiles grant temporary directories and Grok state storage writes;
read-only launch rejects a cwd under `/tmp`, `/var/tmp` or the Grok home,
including aliases. The sandbox axis does not promise every system directory
is immutable. See the [dated evidence](../../evidence/grok/2026-10-14-premises.md).

`ext.permission_policy` carries only spawn observations and the selected
profile. A successful inspect carries source names, managed-settings state,
loaded/skipped rule counts and Grok's Claude hooks compatibility cell. Failed,
timed-out or unfamiliar inspect output carries `inspect: unavailable` without
inventing empty sources, zero rules or disabled hooks. This metadata is
operator-only and does not participate in permission decisions.

The wrapper strips inherited `GROK_CLAUDE_*_ENABLED` variables and does not
change HOME or Grok config files. The user's Grok configuration owns Claude
compatibility, including hooks. Hooks can block tools or turn completion;
individual hook verification belongs to the settings repository.

## Permission switching

After the server accepts permission-sync negotiation, the Linux adapter
advertises sandbox and network axes bounded by its initial **raw** launch
pair. Approval remains `on-request`, and permission-mode switching rejects.
The raw ceiling is not widened by normalization: an `off` launch with the
network toggle false cannot switch to workspace-write with the toggle true.

`latest` is the newest operator control; `next` is the server-authorized
selection for the next execution. A turn captures `next` before any restart,
and publishes `applying` only immediately before sending its prompt. A newer
selection cannot relabel a captured execution. The result's native `promptId`
is the `permission_applied.turn_id`; a missing id yields `unknown` and blocks
later dispatch when that submission is still `next`.

When the profile changes, a serialized lane retires the current generation,
closes its ACP connection and HTTP ToolHost, and awaits its owned process
group's exit. It inspects the new policy, starts a loading generation, calls
`initialize` and `session/load` with the same session id and a fresh MCP URL
and bearer token, and waits for authenticated `tools/list`. The new generation
becomes current only after a synchronous failure/abort check. Load replay and
retired-generation callbacks cannot affect turns or permission observations.
Close aborts the lane and waits for every generation it created.

Grok sends the `session_start` hook execution after the `session/new` or
`session/load` response, often while the generation is loading
([evidence](../../evidence/grok/2026-10-15-session-start-hook.md)). A loading
generation's wire metadata is therefore held, up to 256 records, and
published in order when the generation is promoted. The load replay is not
held: `session/update` and Grok's `_x.ai/session/update`, which replays past
hook executions. Records beyond the bound are reported as one
`loading_lines_dropped` count. A generation that is never promoted is retired
with its held metadata dropped, so nothing it saw is attributed to the
session.

A pre-prompt lane failure leaves the head turn queued and unsent. If its
selection is still `next`, the adapter stops until a valid server relay or
sync supplies `next`; it never guesses a fallback or originates `rolled_back_to`.
It may echo that field as part of a server control adopted through sync.
A persisted unsupported pair is rejected before stopping the resident child,
with `unsupported_permission_pair`. Dispatch waits for an authoritative next
selection while the existing child remains alive.
A refused relay changes `latest` without replacing the previous `next`.
`ext.permission_gate` makes the stop visible. Blocked queued input expires
after 30 seconds with `permission_gate_blocked` and is not resent. A missing
observation requires a newer revision; rejoining with the same revision does
not lift that block.

Every Linux control, including an `off` baseline, has fixed constraints
`{approval: "on-request", enforcement: "os"}`. These constraints describe the
adapter, not an observed execution's badge. Off Linux, the adapter requests
no permission sync and retains its legacy permission/effective display.
Before the first observation, the running generation's profile supplies the
same permission/effective projection as at launch, including after sync
negotiation. This projection does not mark the control applied or create an
observation. After an observation is lost, it does not replace the unknown
execution with a launch projection.

The restart deadline is 30 seconds; authenticated MCP readiness also retains
its 15-second limit. Grok's stored session summary still names the creation
profile after load. The wrapper reports the current generation's profile
instead. Session rules are retained by load and are not resent.

## Model and effort switching

The catalog and the selection are read from Grok, once per generation.
`initialize` `_meta.modelState.availableModels` gives each model's id, name,
description, reasoning-effort levels with the default one, and context window
(the window stays private). `session/new` and `session/load` `configOptions`
give the current `model` and `reasoning_effort`. `ext.models`, `ext.model` and
`ext.effort` mirror them. Each axis carries its own source: `default` until a
start selection or an operator switch sets it (see
[Start selection and restore hold](#start-selection-and-restore-hold)).
`ext.effective` carries the model and effort with their sources, next to the
permission pair when it is known; the server persists it as the resume
snapshot.

`supports_model_switch`, `supports_effort_switch` and `supports_context_usage`
are `true` only when both options are `select` options and every model they
list has a catalog entry. Otherwise the capabilities stay `false`, the
catalog stays the account default and `setModel` and `setEffort` reject.

`setModel` and `setEffort` never talk to Grok. They check the value against
the catalog (an effort against the levels of the pending model, else of the
current one), record it, stamp `ext.pending_model` or `ext.pending_effort`
and wake the drain loop. A value outside the catalog sends nothing and
publishes `switch_error` with `reason: "control_rejected"`.

Grok applies a switch made during a turn to that turn's later model calls, so
the host sends `session/set_config_option` only at a boundary: right before
the next `session/prompt`, and whenever the queue is empty (a switch asked
while idle, the end of a turn with no successor). The drain loop is the only
sender and runs one request at a time. A request that gets no answer within
15 seconds fails the host, like an unexpected ACP closure.

The target values are decided when the pending values are applied. The target
model is the pending model or the current one. The target effort is the
pending effort, else the current effort if the model Grok then holds lists it,
else that model's default effort. Grok keeps a stale effort on a model switch,
so the host sends the model request and then the effort request. When it
substituted the default, it stamps `effort_reset: true` once and the effort
takes source `config`, whether or not Grok already held that default and no
effort request was needed. Each response's `configOptions` is adopted as the
truth; an axis the request did not set that comes back changed takes source
`default`, and the change is logged to stderr.

A request Grok rejects (JSON-RPC `-32602`) changes nothing it did not apply:

- The model request fails: nothing is applied, a pending effort is dropped,
  and `switch_error` is `{ kind: "model", requested, reason:
  "control_rejected", rolled_back_to: <current model> }`.
- The model request succeeds and the effort request fails: the model stays
  switched, because Grok applied it. `ext.effort` reports what Grok still
  holds, which can be outside the new model's `effort_levels`.
  `switch_error` is `{ kind: "effort", requested, reason, rolled_back_to:
  <the held effort> }` with `reason: "effort_reset_failed"` when the default
  was being substituted and `"control_rejected"` otherwise, and no
  `effort_reset` is stamped. A later `setEffort` repairs it.

A pending value is not queued again after a failure. `switch_error` and
`effort_reset` are published once each.

The selection lives in the Grok session, not in the process. A permission
switch loads the same session into a new process; the new generation adopts
the `configOptions` of its load response at promotion and nothing is sent
again. `model_changed` and `config_option_update` only confirm: a value that
disagrees with the last returned one is logged to stderr and the returned
value stays.

## Context usage

`ext.context` is `{ used_tokens, max_tokens, used_percentage }` where
`used_tokens` is the prompt size of the last model call of the last finished
turn (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
of its last `_x.ai/session_notification` `response_completed`), `max_tokens`
is the `totalContextTokens` of the model the turn ran on and the percentage is
`100 * used / max`. This is the headline of Grok's own `/context`; the turn's
summed usage is not the context size. It is published with the next
`state_change` and rides every later one.

A cancelled turn that made a call publishes the same way. A turn that made no
call (a slash command, a rejected permission before the first call) keeps the
last reading. A model change withdraws the reading until a turn has finished
on the new model, and an effort change keeps it. The reading is also
withdrawn, with a stderr line, when the prompt result's `_meta.modelId`
differs from the selected model.

Limit: the TUI's `/context-window` can change the window of a session's model
and ACP does not expose it, so such a session shows the default window.

## Account rate limits

On Grok Build 1.0.52 with ACP SDK 1.8.0, the wrapper reads the measured
`_x.ai/billing` extension with empty parameters on the current generation's
ACP connection. The wire method carries ACP's underscore prefix; the request
uses that name literally. The exact upstream layer that removes the prefix is
not part of this adapter's contract.

The wrapper publishes only the allowlisted weekly window on both
`state_change.ext` and `whoami`:

```json
{
  "rate_limits": {
    "seven_day": {
      "utilization": 0.125,
      "resets_at": 4102358400
    }
  }
}
```

`utilization` is the finite `creditUsagePercent` divided by 100;
`resets_at` is the current weekly period's RFC 3339 end converted to integer
epoch seconds. No status or `five_hour` window is inferred. Other Grok
products can consume the same weekly pool. A value of `1.0` means the included
allowance is used; extra or on-demand credits may still allow execution, so
the omitted `status` remains unknown.

After the initial state publication, a fresh or restored session reads once
when it has no initial prompt. A supplied initial prompt skips that read and
uses turn finalization instead. Every successful, failed or cancelled turn
requests a refresh without delaying turn dispatch. A permission replacement
retires the old reading while a turn is queued; that turn's finalization
supplies the replacement generation's first refresh. There is no idle polling.
The wrapper coalesces
concurrent triggers, allows one outstanding RPC per generation,
waits at most 20 seconds, waits at least 60 seconds between successful
readings, and retries a settled transient failure no sooner than five
minutes. These are local load limits, not Grok quotas.

Only a validated weekly response is projected. Malformed or unsupported
successful responses clear the cached window. `-32601` disables reads for
that generation. Transport and authentication failures keep the last valid
window, even after its reset time; after an authentication failure that
retained window may be stale and is replaced by the next successful reading.
Generation replacement clears it. The wrapper preserves expired windows and
does not synthesize zero utilization; consumers must stop trusting the value
after `resets_at`. Diagnostics are static, emitted at most once per outcome
and generation, and never contain billing fields or error bodies.

The field semantics were measured against Grok Build 1.0.52 and ACP SDK
1.8.0. Recheck the native response and percentage meaning when either version
is upgraded; range checks alone cannot detect a change in vendor units.
See the [dated rate-limit evidence](../../evidence/grok/2026-10-15-rate-limits.md).

## Upstream gaps and limits

- Claude permission import has no compat switch. Command-text deny matching
  does not cover paths or commands constructed at runtime.
- Generic ACP clients cannot declare permission-prompt capability. Grok's
  classifier can return a denial without asking the client. Escalation
  thresholds seen in older source are not verified against this CLI version.
- `session/set_mode` returned success for an unknown mode in the measured CLI;
  it cannot verify a permission-mode change and is never sent by the adapter.
- Rules supplied on session/load did not replace the original session rules.
- `/context` in the Grok TUI floors its percentage to two decimals, and in a
  session whose only model call is its first one it shows a far smaller
  number than that call's prompt. From the second model call of a session it
  matches the last call's prompt size. `ext.context` always follows the
  prompt size the model received. See the
  [dated evidence](../../evidence/grok/2026-10-15-unit4-premises.md).

These are reference notes; no upstream report is part of this work.

## Cancellation and background tasks

On Grok Build 1.0.52, `session/cancel` ends the turn with `cancelled` and
returns the wrapper to `waiting_input`. A foreground shell tool with actual
`block_until_ms: 120000` disappeared after cancel in all six controlled
trials, with and without `--no-leader`. Native acceptance verifies the actual
arguments and asserts foreground-child termination.

A tool moved to the background (`_x.ai/task_backgrounded`) can remain alive
after cancel. Close and wrapper SIGTERM remove active tool children.
The wrapper preserves the resident session and does not discover or kill
tool PGIDs. Background survival is recorded as a vendor behavior; tests do
not assert it because the model chooses whether to background a task.
Per-task cancellation through `_x.ai/task/kill` is tracked in
[issue #594](https://github.com/sakuraiyuta/kaoiro/issues/594).
See the [dated evidence](../../evidence/grok/2026-10-14-premises.md).

## Result text

A successful or interrupted turn's `result.text` is all message text of the
turn, clipped by `clipText` to the `MAX_LOG_BYTES` budget (16,384 bytes), as
Claude Code and Codex clip theirs; how a multi-byte character at the cut is
handled is `clipText`'s contract. A failed or permission-rejected turn has an
empty `result.text`, even when its text already reached the assistant logs.
The result payload has no `truncated` field, so the clip is silent. The
server rejects an envelope over 65,536 bytes without a reply the wrapper reads,
which would lose the whole result envelope. Nothing reads `result.text`; the
reply text reaches the dashboard through the assistant logs.

## State publication

The host sends a `state_change` envelope only when it differs from the last
one it sent in anything but `ts`: the state, the `ext` or the header fields
such as `display_name`. Streamed message and thought chunks keep updating the
machine state but no longer repeat the same `thinking` envelope. The first
`waiting_input` at startup is always sent. The server keeps the latest
`state_change` per agent and the transport re-sends the last one after a
rejoin, so the latest state is unchanged; only the repeats are gone.

## Diagnostics and shutdown

ACP diagnostic records contain bounded method, variant and identifier
metadata, never prompt or tool-result content. SDK diagnostics that include
raw messages are filtered. Unknown variants are counted without emitting
their bodies. Lines above the 4 MiB diagnostic-reader limit pass through
without parsing; only their count is recorded. The SDK owns the protocol
message limit. Normal protocol logs/results still carry display content.

Unexpected ACP closure fails the host and closes its owned child, allowing
the runner to recover the peer. Close aborts ToolHost handlers, closes ACP and stdin, sends SIGTERM to the
owned process group and escalates after 3000 ms, below the runner's 5000 ms
reset grace. Process-signal tests run in an isolated namespace.

For permission synchronization deadlines and failed-input recovery, see
[permission state](../protocol/permission-state.md#synchronization-failure-visibility).

## Wrapper-exit recovery

The runner's [launch-owned recovery checkpoint](../protocol/runner-control.md#wrapper-exit-session-recovery)
records native candidates before first-turn completion and distinguishes confirmed
live/explicit attach from candidate fallback. The engine boundary and refusal
exceptions in that contract apply independently of display history replay.
