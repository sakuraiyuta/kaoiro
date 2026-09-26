---
title: Issue 365 — Expose wrapper build identity through inter-agent tools
description: Add the wrapper artifact identity to list_agents and whoami while preserving the peer-directory and viewer disclosure boundaries.
status: implemented
issue: 365
base: 148a469a66dae48ae2ea155f5fd54d4c7ae9ad52
last_updated: 2026-09-26
---

# Issue 365 — Wrapper build identity in inter-agent tools

## Problem and evidence

The operator cannot identify a connected wrapper's deployed artifact through
`mcp__kaoiro__list_agents` or `mcp__kaoiro__whoami`. The issue body asks both
tools to expose `build_revision`, `build_dirty`, `build_version`, and
`build_channel` as a nested `build` object, while the server already receives
the wrapper identity after join and shows it on the operator dashboard.

Evidence at base `148a469a66dae48ae2ea155f5fd54d4c7ae9ad52`:

- `wrapper/core/src/transport.ts` reads the wrapper's generated build artifact,
  normalizes it, and sends `wrapper_build_info` after each successful join.
- `server/lib/kaoiro_server/wrapper_build_infos.ex` applies
  `canonical_info/1` and keeps the most recent identity only while the wrapper
  connection is live. The server validates the value's shape and domain; it
  does not cryptographically attest which binary reported it.
- `server/lib/kaoiro_server_web/channels/wrapper_channel.ex` builds live
  directory entries from `AgentStates` and currently does not join the
  `WrapperBuildInfos` snapshot. It builds `directory_only` entries from
  `AgentDirectory`, which has no live build information.
- `protocol/src/index.ts` owns `DirectoryEntry` and the flat
  `WrapperBuildInfoPayload`. `wrapper/agent-common/src/inter_agent.ts` owns
  `WhoamiSnapshot`, while each engine CLI supplies the host snapshot to the
  shared `InterAgentTool`.
- `AgentsChannel` delivers the existing `wrapper_build_info` event only to
  operator-capable dashboard roles; the event is not part of the viewer
  allow-list.

## Proposed decision

Add the same nested object to each tool result, but preserve the two tools'
unknown-value semantics:

```json
{"build":{"revision":"<40-hex-or-unknown>","dirty":false,"version":"YYYY.M.PATCH","channel":"release"}}
```

For `list_agents`, join `WrapperBuildInfos.snapshot()` into the live
`directory_request` projection and construct `build` from the server's already
canonical fields. Do not read the raw envelope `ext` or re-parse a wrapper
claim in the directory projector. Include `build` only when a live wrapper has
reported an identity accepted by server validation. Keep it absent for
`directory_only` entries and legacy/unreported live wrappers. Absent means
unreported; a present `unknown` means reported but indeterminate. Preserve the existing
32-entry directory-only cap, requester exclusion, and reply frame guard. The
frame limit is 8,000,000 - 1,024 bytes; four build fields add about 100 bytes
per peer, or about 3.2 KB across 32 live peers.

For `whoami`, include the wrapper's own locally loaded `WrapperBuildInfo` in the
snapshot returned by the tool. `build` is always present; the normal loader
returns a bounded `unknown` identity when the artifact file is absent or
malformed. Keep it local; do not add a server round trip.

### Disclosure decision

- **Peers:** disclose the complete `build` object to agents through `list_agents`
  for live peers. ADR-0021 F6-3 defines the peer directory's explicit
  allow-set, and F6-7 requires this field addition to be recorded and tested for
  both principals. Build identity answers the fleet rollout question that
  motivated issue 365. Update F6-3 and the peer-directory reference.
- **Self:** disclose the caller's own build identity through `whoami`, as part
  of its existing self-status result.
- **Human viewers:** add no viewer or browser disclosure. `list_agents` and
  `whoami` are wrapper MCP tools, not dashboard fields. Keep the existing
  `wrapper_build_info` dashboard event operator/admin-only, as required by
  ADR-0021 F2/F3 and the current `AgentsChannel` gate.
- **Trust meaning:** the value is validated observational metadata, not a
  signed artifact attestation and not an enforcement input. Do not use it to
  grant permissions or to make release-security decisions.

### Type ownership question for the director

The issue body says both `DirectoryEntry.build` and
`WhoamiSnapshot.build` belong in `@kaoiro/protocol`. At the selected base,
`DirectoryEntry` is in `protocol/src/index.ts`, but `WhoamiSnapshot` is defined
and exported by `@kaoiro/agent-common`; it is a local MCP/host snapshot, not a
server-wrapper wire type. This plan proposes adding a shared nested
`WrapperBuildIdentity` type to `@kaoiro/protocol`, using it for
`DirectoryEntry.build`, and importing it for `WhoamiSnapshot.build` while
keeping `WhoamiSnapshot` in its current package. The director confirmed this
ownership choice: `WhoamiSnapshot` is a local tool result, not a channel wire
contract.

## Alternatives considered

1. **Query each peer wrapper when `list_agents` runs.** Rejected: it adds
   per-peer latency and failure modes to a bounded directory request even
   though the server already has the validated live snapshot.
2. **Copy the flat `build_*` keys from envelope `ext`.** Rejected: it would
   bypass `WrapperBuildInfos.canonical_info/1` and violate ADR-0021 F6's
   recursive allow-list rule.
3. **Expose build identity to dashboard viewers.** Rejected: issue 365 requests
   MCP visibility; the current dashboard event is deliberately gated from
   viewers. A new human-facing disclosure would be a separate decision.
4. **Move `WhoamiSnapshot` into `@kaoiro/protocol`.** Rejected: the current
   snapshot is a local tool result shared by wrapper hosts, not a channel wire
   contract.

## Scope

In scope:

- A nested `WrapperBuildIdentity` shared shape and optional `build` fields for
  `DirectoryEntry` and `WhoamiSnapshot`. Derive `WrapperBuildIdentity.channel`
  from `WrapperBuildInfoPayload["build_channel"]`; `WhoamiSnapshot` remains
  owned by `@kaoiro/agent-common`.
- Server projection from `WrapperBuildInfos.snapshot()` to live peer entries.
- Wrapper transport narrowing so valid `build` values survive
  `directory_request`; invalid shapes are omitted.
- Local `whoami` composition for Claude Code, Codex, and Antigravity from each
  CLI's existing build-info reader. `whoami.build` is always present; when the
  local artifact cannot be read, its fields use the bounded `unknown`
  identity. For `list_agents`, absent `build` means no identity was reported;
  a present `unknown` value means an identity was reported but could not be
  determined.
- Tool descriptions, the peer-directory reference, and ADR-0021 F6-3. Keep the
  `LIST_AGENTS_DESCRIPTION` and `WHOAMI_DESCRIPTION` additions to one sentence
  each.
- Tests for live/unreported/directory-only entries, maximum-size directory
  frames, all three `whoami` compositions, and viewer non-disclosure.

Out of scope:

- Changing the `wrapper_build_info` channel event or dashboard rendering.
- Exposing the identity to human viewers, runner entries, HTTP APIs, or
  inter-agent message bodies.
- Persisting wrapper build identity across disconnects or server restarts.
- Treating reported build data as a signed attestation or authorization input.

## Verification plan

- Land issue #365 before issue #407. The director's ordering decision is that
  issue #407 must rebase after this change lands; keep changes to the existing
  one-line tool descriptions to one appended sentence each.
- Protocol: `pnpm --dir protocol typecheck`.
- Wrapper: `pnpm --dir wrapper typecheck` and full `pnpm --dir wrapper test`;
  also run the relevant package tests for `wrapper-core`, `agent-common`, and
  each of the three engine CLIs while developing.
- Server: targeted `WrapperChannelTest` directory/build-info coverage, then
  full `cd server && mix test`.
- Positive directory test: create 32 live peers carrying valid maximum-domain
  build identities, issue a real `directory_request`, and assert the response
  stays inside `TransportLimits.reply_frame_fits?/2` with the nested values
  intact. Also assert omission for an unreported wrapper and a `directory_only`
  peer, and preserve the reported `unknown` identity values.
- Positive self test: drive the production CLI composition through startup to
  invoke its actual `whoami` descriptor. Use the default build-info reader and
  default `InterAgentTool`/MCP descriptor wiring; only stub external config,
  SDK, and transport boundaries needed to reach that action. Check the result
  against the generated artifact for Claude Code, Codex, and Antigravity. Extend
  the existing Claude Code and Codex composition tests, and add an equivalent
  Antigravity test. In all three, call the `whoami` descriptor handler
  registered on `ToolHost`, not `getWhoami` directly.
- `whoami` negative controls: for each CLI, temporarily remove `build` from
  the composed `getWhoami` result and require its production-composition test
  to fail; restore the implementation and require all three tests to pass.
- Viewer negative control: ensure the existing viewer projection still drops
  the operator-only `wrapper_build_info` event; no new dashboard projection is
  introduced.
- Mutation negative controls: temporarily remove the server's live build
  projection and require the positive directory test to fail; temporarily
  remove `build` handling from the wrapper directory narrow and require the
  wrapper positive test to fail. Restore both mutations and rerun the affected
  tests against the final tree.
- Report each package's exit code and whether it emitted unhandled errors.

## Documentation updates

- `docs/adr/0021-role-information-disclosure-policy.md`: add `build` to F6-3's
  agent disclosure allow-set and record the peer-only disclosure decision.
- `docs/reference/inter-agent/directory.md`: document the flat-to-nested mapping
  once (`build_revision` → `build.revision`, `build_dirty` → `build.dirty`,
  `build_version` → `build.version`, `build_channel` → `build.channel`), specify
  the nested identity,
  validation source, omission semantics, MCP tool output, and that identity is
  observational rather than an attestation. Document the distinction: an
  absent `list_agents.build` means unreported, while a present `unknown`
  identity means reported but indeterminate. State that `whoami.build` is
  always present and uses the bounded `unknown` value when no artifact is
  available, and summarize these semantics in both tool descriptions.

Do not change `docs/reference/protocol/channels.md`'s existing
`wrapper_build_info` operator-only contract; its wire event does not change.
