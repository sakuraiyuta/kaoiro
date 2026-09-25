---
title: Pre-turn account rate-limit snapshots
status: approved
last_updated: 2026-09-26
---

# Pre-turn account rate-limit snapshots

## Problem and evidence

Fresh idle wrappers emit their first `state_change` before either engine's
current rate-limit refresh runs. Codex's rollout resolver needs a session ID;
Claude's current refresh needs the first production `Query`. The
[pre-turn probes](../evidence/2026-09-26-pre-turn-rate-limits.md) show that
Codex's authenticated app-server read and Claude's SDK `/usage` control request
can each supply an account snapshot before a user turn. Codex's current
account response has a seven-day window only; the absent five-hour window is
absent at the source, not discarded by the reader.
The design review approved this path after one must-fix round.

## Options and decision

For Codex, scanning a different session's newest rollout is cheap and worked
in the probe, but the file is a past observation with no reliable account
identity or freshness proof after an account switch. Marking it as
`source: other_session` would require a new peer-facing protocol field and
still would not make it a current account observation. Use a short-lived
app-server `account/rateLimits/read` at fresh idle startup instead. Both the
exec and app-server backends start this short-lived read before a thread
exists. The app-server backend's own read after opening its thread may later
replace the startup snapshot. Select only the `codex` bucket and known
five-hour/seven-day windows through `AppServerAccountTelemetry`; do not add a
parallel parser. Do not borrow another session's rollout, so no source marker
is needed. Retain the
current session's rollout refresh after its first turn. If the app-server
read is unavailable, malformed, or has no usable window, leave the field
absent; do not fall back to an unmarked borrowed value.
The short-lived read uses `AppServerRpc`'s 25-second request deadline and its
five-second SIGKILL escalation after close. Host close aborts an outstanding
read. A native rollout or app-server read that updates the map before the
startup probe arrives wins by arrival order.

For Claude Code, creating the production Query early would lock startup
Options before the operator can choose model and effort. Extend the existing
`wrapper/claude-code/src/probe.ts` catalog probe to request `/usage` with
`skipBehaviors: true` on its already isolated Query and return only the two
supported windows as optional output. Its private temporary cwd and explicit
minimal Options exclude hooks, MCP servers, tools, agents, system prompt, and
`canUseTool`; it preserves authentication without `--bare`. Reuse
`probe-client.ts`'s existing subprocess deadline and SIGTERM-to-SIGKILL
cleanup. Do not pass the production host's Options or cwd to the probe. Keep
the production Query deferred until the first input. Parse the returned
windows through `AgentHost.#applyUsageRateLimits`, where utilization is divided
by 100 and ISO resets are converted to epoch seconds. The probe outputs the
SDK's raw values. Request `/usage` only when the host passes `--usage`; the
runner's catalog invocation and output remain unchanged. Catalog collection
retains its own deadline, then an optional `/usage` request gets a separate
short deadline before the Query closes. A usage timeout, failure, or empty
response leaves `rate_limits` absent even if catalog collection succeeds;
catalog failure must not discard an independently valid usage result.
Host close aborts its outstanding probe and uses the existing child-process
SIGTERM-to-SIGKILL escalation.

The first idle `state_change` remains immediate and initially omits the field.
Start optional account probes without awaiting them, then emit a deduplicated
state update from the host when a usable snapshot arrives. This keeps the
fresh session at zero turns and makes the value visible through `list_agents`
without delaying idle presence. The issue author's
[scope clarification](https://github.com/sakuraiyuta/kaoiro/issues/408#issuecomment-5836460805)
confirms that the zero-turn `list_agents` result is the acceptance criterion;
the original first-envelope wording described a possible means.
If a native turn or backend read has already supplied a newer snapshot when
the probe finishes, discard the probe result. This is a Boolean record of a
native map update, not a comparison of reset timestamps. Probe failures are quiet at
normal log level, including hosts authenticated by API key but unable to read
account limits.

## Scope

Change the Codex and Claude Code fresh idle startup paths, their host snapshot
initialization seams, and focused tests. The post-probe state update, later
host status, and `whoami` must read the same initialized map. Preserve
eventual refresh behavior after turns. Do not add periodic idle refresh,
change Antigravity, or alter account authorization or quota semantics.

## Verification

- Unit tests for both engines: the first idle envelope is immediate; a
  supplied account snapshot appears in a subsequent idle envelope before a
  turn, and an unavailable or empty source emits no `ext.rate_limits`.
  Include an unchanged production default construction test through first
  idle and probe completion.
- Test that a later native refresh replaces the initial value, and that
  a late probe cannot overwrite it. Check that Claude's production Query
  remains deferred and the probe uses isolated cwd and minimal Options. Check
  that a `/usage` timeout leaves catalog success intact and that the runner's
  default probe omits usage.
  Mutate the new startup wiring or guard once and confirm its corresponding
  test fails, then restore it.
- Run `pnpm typecheck` and `pnpm test` in each affected wrapper package.
- Build current artifacts and exercise the production CLI invocation path
  against the live account, checking the immediate first idle state and
  follow-up `state_change` plus `list_agents` at zero turns. Run an isolated
  unauthenticated or otherwise source-free negative control through the same
  startup path and check that no follow-up adds `ext.rate_limits`.
- Repeat the issue #401 SIGKILL parent probe for each startup child, record
  whether stdin EOF terminates Codex app-server and when the Claude probe
  subprocess and SDK child exit. The pre-change measurement is in the evidence
  record.

## Documentation

Update the rate-limit freshness and initial-availability contract at
`docs/reference/inter-agent/directory.md:46` and `:321-322`, the relevant
engine reference pages, and the measured evidence record with implementation
verification. When checking the issue's to-do items, state explicitly that
no source marker is needed because no other session's value is borrowed, and
that the five-hour absence was measured at both account and rollout sources.
