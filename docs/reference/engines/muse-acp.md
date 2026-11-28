---
title: Muse ACP engine
description: Resident ACP host for Muse Code's experimental `muse acp`, its capabilities and its declared limits.
status: draft
last_updated: 2026-11-25
---

# Muse ACP engine

The kaoiro Muse engine is experimental.
With workspace trust enabled, real-provider `tools/call`, approval enforcement
during tool execution, and MCP after cold resume are unmeasured. Recovery from
a runner-detected failure to the same session ID and persona retention after
compaction are also unmeasured. A runner restart or crash
before delivery is recorded may cause the persona to be sent again.

The `muse` engine requires Muse Code on `PATH`, logged in with
`muse login`. The wrapper launches `muse acp` once (plus `--model <id>`
when a launch pick names a model, `-c` for an explicit launch effort, and
`--trust-workspace` only on the
operator's explicit opt-in below), initializes one ACP session
(`session/new`, or `session/resume` for a cold resume) and uses
`session/prompt` for each queued turn. It does not launch `muse` per turn.

A failed turn shows its ACP error message and numeric code, when available,
in the operator timeline's collapsed error details. The wrapper masks
credential-shaped text, URLs, and path tokens and limits the detail to 256
UTF-8 bytes. This pattern-based masking cannot recognize every secret. ACP
error data and generic exception messages are not relayed. The shape of a
real provider's `no_allowance` error has not been measured.

`muse acp` is experimental upstream. It speaks ACP version 1 over stdio and
translates to the same Muse Code host as `muse serve`. The gate that
enables it is open by default upstream; the wrapper passes the operator's
environment through unchanged and never forces `MUSE_EXPERIMENTAL_ACP=on`,
because that would re-open a gate the operator (or a remote configuration)
deliberately closed. Approval flags are refused by `muse acp`, so none are
passed; the approval mode is chosen through ACP (see below).

`--trust-workspace` loads the workspace's own skills and rules. kaoiro's
cwd allowlist authorizes where an agent may launch; it does not imply
trusting the workspace contents, so the flag is **off by default** and is
passed only when the operator sets `KAOIRO_MUSE_TRUST_WORKSPACE` to a
truthy value (`1` / `true` / `yes` / `on`) in the wrapper's environment.
Muse does not start MCP servers in untrusted workspaces. To use kaoiro's
tools, opt in for a workspace you trust; this also loads its own skills and
rules. If configured in `runner.env`, restart the runner and affected wrappers.
See the [Muse Code changelog](https://dev.meta.ai/docs/muse-code/changelog).

Startup is bounded: `initialize` / `session/new` / `session/resume`
together get a 30-second deadline, and a shutdown landing mid-startup
aborts the remaining steps instead of letting the host and child be
created afterwards.

The ACP client is the shared one in `wrapper/agent-common/src/acp/`. Muse
Code sends plain ACP session updates and no vendor extensions are consumed,
so there is no `muse/wire.ts` injection surface: the mapping in
`wrapper/muse/src/muse/events.ts` is the protocol's own vocabulary
(message and thought chunks, tool call rows and completions, plan entries,
`usage_update`).

## Launch model and effort

The launch dialog starts with Default. After initial registration, a
Muse-enabled runner opens one short-lived `muse serve --disable-shell
--disable-write --no-session-log` process. It reads MSP `model/list` after
the handshake. This probe creates no session and sends no model prompt.
The runner gives the probe 10 seconds and aborts it during shutdown.
The Meta `providerCatalog` result provides model IDs and per-model effort
`variants`. Invalid or unavailable catalogs produce a runner warning.

Before the startup probe publishes a catalog, or when the probe fails,
only Default is published, so the fresh-spawn API rejects named
model/effort pairs as stale. Explicit effort with model Default is also a
spawn failure. In the dialog, Default model and Default effort leave the
respective overrides out so Muse keeps its own settings.

For a new launch with a named model, the wrapper passes `--model <id>`.
An explicit effort adds a separate `-c` argument containing
`model_reasoning_efforts={"<id>":"<tier>"}`. The runner validates the pair
against the published catalog. The wrapper logs the configured tier and
reports the ACP model. It does not report ACP `thought_level` as effective
effort. The selected effort does not carry into resume or restore,
including fresh restore.

On Muse Code 1.4.25, provider requests used the selected tier on Spark
1.3 and Spark 1.2 even when ACP reported a different effort. On the
measured account, Ember in contributor mode failed both with and without
an explicit effort. The adapter preserves Muse's contributor setting
and reports the native failure.

## Approval mode

Muse's approval behaviour is the ACP session mode selector. At session
start — fresh and resumed alike — the adapter requires the advertised
`promptUnmatched` mode, selects it with `session/set_mode` if needed, and
reports it in `ext.approval_mode`. Missing or inconsistent mode information
stops startup before the first prompt. A later mode change stops the host.

kaoiro's permission axes have no projection onto these modes: a launch
that carries `permission_mode`, `sandbox`, `approval` or `network_access`
is refused before start, and runtime `set_permission` /
`set_permission_mode` controls are returned as unsupported (the host
throws and the unchanged effective state is re-published, so the server
does not persist the pick as applied).

## Tools

The kaoiro tools are served by the wrapper's ToolHost as an HTTP MCP server
on `127.0.0.1` and passed as `mcpServers` in `session/new`, with the per-run
bearer token in a header, never in the URL (see the
[Grok tool transport](grok-acp.md#tool-transport) for the shared checks).
Startup fails closed when the agent does not report `mcpCapabilities.http`.

Advertising HTTP MCP support is not proof the tools arrived: upstream, a
session still opens when an MCP server fails to start, and Muse may only
connect its MCP servers when a turn starts. The wrapper therefore tracks
the ToolHost's first authenticated `tools/list` instead of assuming it,
and if no `tools/list` has arrived by the end of the first turn it
publishes a system log line saying the agent is running without the
kaoiro tools and explaining the trust opt-in. Other MCP failures can also
cause this warning.

## Personality prompt

Muse's ACP surface documents no `session/new` system-prompt metadata
(compare [personality injection](personality-injection.md), where Claude
Code, Codex, Antigravity and Grok each have a named injection point). Until
a Muse injection point is documented or measured, the wrapper delivers
the server-composed persona and footer at the head of a prompt under this
contract:

- **First turn of a fresh session:** the persona is prepended.
- **Retry:** it stays pending until a prompt carrying it ends with `end_turn`;
  a failed, refused or interrupted turn is retried with the persona attached.
- **Resume:** the persona is prepended unless the runner has a checkpoint
  confirming it was delivered to that session. An external session or an
  older checkpoint has no such confirmation, so the first new prompt carries it.
- **Compaction:** the persona is not re-supplied after agent-side compaction;
  retention after compaction has not been measured.

A persona-bearing prompt is recorded as delivered only after `end_turn`.
A crash after native receipt but before the checkpoint write can cause a
repeat. Runner restart or offline restore also loses the per-child checkpoint;
the next new prompt carries the current persona again. The original user
prompt is not replayed. A checkpoint records delivery of the persona at that
time; it does not track later changes to the server-composed text.

This is provisional: the text is visible in the session transcript.
Replacing this with a native injection point is the first follow-up when
upstream documents one.

## Session recovery

The wrapper runs the common `RecoveryReporter` (see
[runner control](../protocol/runner-control.md)): a fresh `session/new`
records the native id as a candidate, the first successful turn confirms
it `live`, a successful `session/resume` confirms the requested id, and a
resume failure retains the requested id when the cause is not identifiable.
A wrapper restart therefore relaunches with the stored resume id instead
of starting over.

## Capabilities

The adapter supports text turns, conversation continuity while the wrapper
is resident, cancellation (`session/cancel`), operator permission requests
(ACP `session/request_permission`, answered by the common PermissionBroker
with the `allow_once` / `reject_once` option; a pending request publishes
`waiting_permission` and pauses the turn watchdog until it is answered),
user questions through the kaoiro `ask_user_question` tool, normal peer
messages, and context usage from ACP `usage_update` (`ext.context`). See
[Launch model and effort](#launch-model-and-effort) for launch selection.
Cold resume is
supported when the agent advertises `sessionCapabilities.resume`.

Declared unsupported, each rejected explicitly rather than silently:

- Live model and effort switching.
- Permission-mode switching and the two-axis permission selector (see
  Approval mode above).
- Attachments (`supports_attachments: false`).
- Session reset (`supports_session_reset: false`).
- Dashboard history replay on resume: the wrapper registers no hydration
  replayer, so a resumed agent starts with an empty dashboard history.

Session enumeration for the resume picker is not one of the limits: the
runner probes a short-lived `muse acp` with ACP `session/list {cwd}`
(`runner/src/muse_sessions.ts`), the same contract the Grok discovery
uses, and the resume existence check answers from that listing. The
runner-side probes (Grok and Muse) share one tracking registry
(`runner/src/acp_probe.ts`), and runner shutdown waits for both before
exiting.

## Login and failure modes

A host that is not logged in cannot open a session: `session/new` fails
with the upstream "log in to Muse before opening a session" error and the
wrapper start fails with it. Run `muse login` on the runner host. A build
with the ACP gate closed exits with code 5 before `initialize`; the
wrapper reports the child exit as a launch failure.
