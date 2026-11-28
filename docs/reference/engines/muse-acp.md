---
title: Muse ACP engine
description: Resident ACP host for Muse Code's experimental `muse acp`, its capabilities and its declared limits.
status: draft
last_updated: 2026-11-25
---

# Muse ACP engine

The kaoiro Muse engine is experimental. The effect of `--model` on a real
Muse build is unmeasured; the effective model and effort are reported only
from ACP responses, not verified as effective values.
With workspace trust enabled, real-provider `tools/call`, approval enforcement
during tool execution, and MCP after cold resume are unmeasured. Recovery from
a runner-detected failure to the same session ID is also unmeasured. Server
retention of the effort warning has not
been checked in a Muse-specific integration test.

The `muse` engine requires Muse Code on `PATH`, logged in with
`muse login`. The wrapper launches `muse acp` once (plus `--model <id>`
when a launch pick names a model, `-c run.system_prompt_append=...`, and
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

The wrapper passes the server-composed persona and footer at process launch
as JSON in `-c run.system_prompt_append=...`, and sends user text unchanged
in ACP prompts. A running process retains its launch value; each new process,
including cold resume, is supplied the current persona. Existing transcript
history is not rewritten. In one Muse Code 1.4.25 Meta provider run, the
append survived manual compaction, a changed append took effect on cold resume,
and a literal `${...}` inside the append remained literal.

Before spawning Muse, kaoiro checks `<XDG_CONFIG_HOME>/muse/settings.json`
when `XDG_CONFIG_HOME` is nonempty; otherwise it checks
`<HOME>/.config/muse/settings.json`. A relative `XDG_CONFIG_HOME` stops
startup, as does a missing, empty, or relative `HOME` when the fallback is
needed. This path selection was measured on Linux; other platforms have not
been measured. If nested
`run.system_prompt_append` or the top-level dotted key is present, startup
stops without reporting its value. Moving those instructions to
`run.developer_prompt` is one option; it changes their position from system to
developer instructions. The file is parsed in memory, but kaoiro does not
extract, use, or pass the developer prompt. Nonregular, unreadable, malformed,
or over-1-MiB files also stop startup, as do non-object settings or `run`.
A UTF-8 BOM causes the JSON parse to fail and stops startup. JSON
duplicate-member interpretation
can differ between parsers. Workspace and enterprise settings are not checked
and may be overridden; a user settings file may also change between the check
and Muse reading it. The persona and footer appear in the process argument
list and may appear in Muse's internal session log; do not put secrets in them.
Ordinary ACP transcript replay is distinct from that internal log.

The complete JSON-encoded argument is limited to 16,384 UTF-8 bytes; an
oversized argument stops startup and reports its size and limit. The limit
leaves about 1.84 times the measured 8,890-byte maximum of bundled personas
and the system footer, but user footers and overlays are not bounded by
[ADR-0045](../../adr/0045-footer-file-externalization.md). Other OS command
line limits may still prevent startup. Muse 1.4.21 is the supported minimum;
1.4.25 was measured. Older builds may reject the key, causing an early child
exit without a `MuseLaunchError` log,
or ignore it and run without the persona; neither outcome was measured.
The 1.4.25 echo provider rejected turns using this setting; Meta succeeded.

## Session recovery

The wrapper runs the common `RecoveryReporter` (see
[runner control](../protocol/runner-control.md)): a fresh `session/new`
records the native id as a candidate, the first successful turn confirms
it `live`, a successful `session/resume` confirms the requested id, and a
resume failure retains the requested id when the cause is not identifiable.
A wrapper restart therefore relaunches with the stored resume id instead
of starting over.
The legacy persona-delivery checkpoint stays compatible with older wrappers;
new sessions leave it false so a rollback re-sends the persona.

## Capabilities

The adapter supports text turns, conversation continuity while the wrapper
is resident, cancellation (`session/cancel`), operator permission requests
(ACP `session/request_permission`, answered by the common PermissionBroker
with the `allow_once` / `reject_once` option; a pending request publishes
`waiting_permission` and pauses the turn watchdog until it is answered),
user questions through the kaoiro `ask_user_question` tool, normal peer
messages, and context usage from ACP `usage_update` (`ext.context`). The
model can be selected only at launch; Muse ignores a non-empty configured
effort and logs a warning. Effort uses Muse's default. A snapshot effort
discarded by the runner does not reach the wrapper and produces no warning.
Reported model and effort values come from the `session/new` or
`session/resume` response, not later notifications,
and are not a claim about the agent's effective values. Cold resume is
supported when the agent advertises `sessionCapabilities.resume`.

Declared unsupported, each rejected explicitly rather than silently:

- Live model and effort switching.
- Permission-mode switching and the two-axis permission selector (see
  Approval mode above).
- Attachments (`supports_attachments: false`).
- Session reset (`supports_session_reset: false`).
- Dashboard history replay on resume: the wrapper registers no hydration
  replayer, so a resumed agent starts with an empty dashboard history.
- The launch catalog probe: the runner offers only the account `default`
  model entry; an explicitly provided launch model is passed with `--model`.

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
