---
title: "Codex app-server settings and permission evidence"
status: recorded
last_updated: 2026-09-18
---

# Codex app-server settings and permission evidence

Historical excerpts from [ADR-0058](../../adr/0058-codex-app-server-turn-steer.md). Each increment
retains its original scope and tense; “now”, “above” and “remaining” describe that
record, not a new claim of present implementation or release.

The artifact, binary/schema hashes, reference SDK and initial procedure cited as
“above” are in the [compatibility record](stage1-compatibility.md).

Scratch paths and hashes below identify the recorded experiments, not a promise
that temporary files remain available. Measurement dates are retained per record;
`last_updated` refers to the source text, not a new measurement.

### Increment (5a): internal turn control and settings

The transport accepts per-turn settings and a synchronous pre-dispatch admission
callback. Host token/client message id are captured separately from the RPC
request id and returned app-server turn id. Interrupts are host-token fenced:
a request before the start reply waits for the actual turn id, a buffered
terminal retires it, and repeated requests share one RPC. RPC acknowledgement
neither closes the event stream nor permits another turn. `CodexHost`, its IA
queue/lease/watchdog, and normal launch remain unconnected in this increment.

Pre-implementation measurement used the same pinned 0.153.4 binary and isolated
unauthenticated loopback provider as earlier increments. Five terminal turns
exposed their matching `turn_context` while the child stayed alive, without an
intervening history RPC. The first direct file read succeeded in each case;
this does not establish a universal flush deadline. Same-thread read-only,
workspace-write/network-off, workspace-write/network-on, then read-only policies
were observed with `never/user` throughout.

Effort is sticky: high followed by a changed model plus null or omitted effort
remained high in both provider requests and rollout. Exec with no explicit
effort used the config's medium value. Resuming the running thread with a
`model_reasoning_effort` override also retained high, even though the RPC
succeeded. Thread id/path and prior history were preserved, the next turn had a
new id, and the rollout retained its previous bytes. No MCP restart claim is
made for that probe, which configured no MCP server.

The accepted restricted contract samples `config/read(cwd)` at model-switch
submission, preferring explicit `model_reasoning_effort`, otherwise finding the
target model's `model/list.defaultReasoningEffort`, and sends a concrete effort.
It neither treats null as reset nor resumes to reset. Missing/malformed defaults,
RPC rejection, or exhausted/non-progressing catalog pages fail before dispatch
with the closed `default_effort_unavailable` reason; connection failures remain
connection errors. Host pending/rollback and operator switch-error projection
are deferred to the next increments. The exec path remains unchanged.

| Real CLI comparison | Resolved app-server effort | Fresh exec effort |
| --- | --- | --- |
| Config changed from medium to low before resolution | low | low |
| No configured effort, gpt-5.6-sol catalog default | low | low |
| Base medium; exec selects probe profile containing low | medium (base only) | low |
| Config changed medium to low after resolution | medium (sampled value) | low |

This is deliberately not universal exec equivalence. The pin rejects
`--profile` for app-server, and rejects legacy `profile`/`profiles` configuration;
its runtime profile option layers `<name>.config.toml`. Current CodexHost/SDK and
AppServerRpc do not expose/send that option, so the restricted contract removes
no current Host selection. **Profile support remains unsupported** and must be
addressed separately before exposing profile selection. The sampling-time
race in the final row is part of the contract, not an implicit reset guarantee.
The model/auth/account matrix beyond these local cases was not measured.

| Evidence / generated stable v2 schema | SHA-256 |
| --- | --- |
| Permission/sticky-effort trace | `e765a6a2695e8e85ebb02fb2ce1b3195324489896dd6f765f3c31af0b3956675` |
| Reset alternatives trace | `9c683566e3b44f736afd9137c74596fabdabd004bfca40cd6b12158768116d8c` |
| Reset probe | `c3c119a6bf49e89b9a2cb0ee3b75f2470e31e6c8011bf3fca80ea53263d1d980` |
| Reset checker | `9c3830b240eb69d37c492ed2a766c12d422499824bca9cf3f27a173bf8bea866` |
| TurnStartParams.json | `a3835e8c1e942e4b358e1a670939b89918b16c4d13105a579899892b7ade6dea` |
| TurnInterruptParams.json | `6dff382dae73d1dbc58406ed045605f647e7a49660e2540fbd2c6c24d60c5f2b` |
| TurnInterruptResponse.json | `531de6be06fe979b5963f249bab82498a175e614bf65ac12fb2e849dfe60bcf1` |
| ConfigReadParams.json | `257c54a423b47c1d209ff1076765a1564d82322fd5161670fd489a2874de1bac` |
| ConfigReadResponse.json | `bd72c94e2c7d49ead6a20bcf54afedc8db11044bf8cadb387e42135dd5d1e342` |
| ModelListParams.json | `de29a536c00a5b8f46f34dba417dabd93365305571a8ed200e33bea85db68b5a` |
| ModelListResponse.json | `c7b58b332f6cf18fd64235409a6daf27bb9e6c09d12dcd0daa2f3dc628b55f6f` |

The capture checker exited zero; replacing the observed resolved low effort
with high made it fail. The production-default session integration separately
exercises settings, rollout observation, interrupt, and subsequent turns on the
real CLI. Schema/error/race boundaries use fixtures. Shared HistoryReplayer,
protocol, capabilities, server/dashboard, and ADR status are unchanged.

### Increment (5b): permission and settings preparation

The accepted effort precedence retains an operator's explicit effort (including
compatible config effort) across model changes. The restricted default-resolution
contract above applies only to reset intent or model changes under default
intent. Successful reset records the concrete resolved receipt rather than the
catalog display default. A failed switch leaves the successful baseline intact;
rollback resends that model/effort, resolving default intent again. Initial
baseline comes from `thread/start` or `thread/resume` response model and
reasoningEffort. Unavailable baseline/default produces the existing closed switch
failure reason, never an implicit reuse of the thread's sticky settings.

Transport admission now permits asynchronous permission synchronization after
effort resolution, followed by a failure check and synchronous dispatch callback.
The latter captures the rollout cursor and independent execution id only if the
selected revision/requested axes still match `next` and the gate is unblocked.
`permission_superseded` occurs before RPC submission. The later Host integration
must prepare the same unstarted queued turn again, not retry a sent turn.
Close/EOF releases an outstanding synchronization wait.

App-server observation requires the terminal's turn id, thread id and Host token,
and fences the result against the current submission's revision/requested axes
and execution id, including after a delayed flush. Newer pending selections do
not erase valid current-execution evidence. Assessment and diagnostic strings
are shared with exec; exec's optional expected-turn-id behavior and existing
permission transitions/audit payload remain unchanged. No RPC success is
promoted to applied policy.

The production-default local-provider test observes terminal policy while the
same real child remains alive, switches workspace-write network access between
turns, rejects a prior turn id, retains explicit high effort despite a changed
config default, then restores model/effort after a provider-rejected switch. It
also resets to a changed config and re-resolves default intent on rollback.
The initial thread/start response can precede creation of the rollout file:
only the first dispatch of an explicitly fresh thread uses a fresh boundary.
The existing missing-resume-baseline rejection is retained and fixture-tested.
Fixtures additionally cover asynchronous synchronization, obsolete execution
completion, malformed/missing settings, conflicting/partial rollout records,
close/EOF, and response metadata for resume. No external model/auth/profile
behavior is claimed. Host app-server execution, queue, watchdog, history replay,
and normal launch selection are still deferred; protocol and ADR status stay
unchanged.

## Wrapper test coverage and limits

The following coverage notes were retained from the package README at migration
baseline `81570847`. They do not extend the dated measurements above.

The default-session control integration exercises live rollout visibility before
child shutdown, sequential policy changes, both effort resolution paths,
unresolvable defaults, interruption, and a following turn in the same session.
Pre-response interruption, dispatch rejection, catalog faults/cursor bounds,
and connection/close races have deterministic fixture coverage.
