---
title: Inter-agent tool authorization
description: Which engine gate decides each kaoiro inter-agent MCP tool call (send_to_agent / list_agents / whoami and the session companions), and when a send_to_agent call reaches the operator.
status: accepted
last_updated: 2026-09-19
---

# Inter-agent tool authorization

Related security topics: [Security boundaries](../../architecture/security-boundaries.md), [Security threat model](../../architecture/security-threat-model.md), [Authentication and authorization](authentication-authorization.md), [Tool authorization](tool-authorization.md), [Security enforcement boundaries](enforcement-boundaries.md), [Security release audit](../../operations/security-release-audit.md).

Per-engine authorization of the kaoiro inter-agent MCP tools (`send_to_agent` / `list_agents` / `whoami` and the session companions `request_compact` / `request_session_reset`). The common tool ceiling and the broker are in [Tool authorization](tool-authorization.md); the messaging contract itself is in [Inter-agent messaging](../../architecture/inter-agent-messaging.md).

## Default allow set and per-engine approval gates

- The default allow set (`READ_ONLY_TOOLS`,
  `wrapper/claude-code/src/read_only_tools.ts`) contains read-only tools (Read /
  Grep / Glob / LS / NotebookRead) plus side-effect-free inter-agent helpers
  `mcp__kaoiro__list_agents` / `mcp__kaoiro__whoami`. **Membership is a security
  decision, not a convenience**: omission is the per-use approval gate itself
  (`mcp__kaoiro__send_to_agent` / `request_compact` /
  `request_session_reset` are intentionally omitted).

- Codex has no canUseTool and auto-approves every kaoiro bridge tool
  (`default_tools_approval_mode: "approve"`), so a tool that needs per-use
  approval there asks on its own behalf: `operatorApprovalGated`
  (`wrapper/agent-common/src/approval_gate.ts`) calls the same
  `PermissionBroker.decide/3` from inside the MCP call and runs the wrapped
  handler only after allow. The wait is bound to the calling turn and capped
  at 300 s (ADR-0043, 2026-09-14 amendment). Currently gated this way:
  `request_session_reset`.

## MCP (`mcp__kaoiro__send_to_agent`)

- Inject the in-process MCP server from `wrapper/agent-common/src/inter_agent.ts`
  into the engine (Claude via `Options.mcpServers`, Codex via the tool-host bridge,
  Antigravity via `ToolHost.listen` in `wrapper/antigravity/src/host.ts`).
- On Claude, `send_to_agent` is **not in the default allowedTools**, so every call
  enters `canUseTool`, and it reaches the broker (operator dialog) unless the
  conversation-scoped whitelist below allows it first
  (`wrapper/claude-code/src/host.ts`, `#canUseTool`). The colocated
  `list_agents` / `whoami` are read-only and therefore auto-allowed (the
  `READ_ONLY_TOOLS` set above). Codex auto-approves
  every bridge tool (`default_tools_approval_mode: "approve"`,
  `wrapper/codex/src/bridge_policy.ts`) and `send_to_agent` is not wrapped in
  `operatorApprovalGated` (`wrapper/codex/src/cli.ts`); Antigravity registers the
  same descriptors unwrapped through `ToolHost` (`wrapper/antigravity/src/cli.ts`),
  which carries no approval axis. The engine-scope bullets under
  [Automatic approval](#automatic-approval-conversation-scoped-whitelist-adr-0044-f2-addendum-option-b)
  state the same boundary.
- Routing uses the server's `route_inter_agent`; quotas use `ConversationStates`.
- Details: [Inter-agent messaging](../../architecture/inter-agent-messaging.md) (formerly `protocol-inter-agent`)

## Approval flow (permission_broker integration)

This flow applies to Claude Code only; see the engine-scope note near the end
of this section for Codex and Antigravity. When wrapper-A invokes
`send_to_agent`, it asks the operator for approval through the existing
`canUseTool` path ([ADR-0022](../../adr/0022-pending-permission-authoritative-source.md)).

- Tool name: `send_to_agent`.
- `input` contains destination `to`, kind, a body excerpt, and
  `conversation_id` so the operator can decide.
- Phase 1 reuses the existing permission dialog; Phase 2 may provide a
  dedicated UI.
- On denial the tool call fails; wrapper-A returns a send-rejected error to the
  SDK and the agent can try another response.

### Automatic approval (conversation-scoped whitelist, ADR-0044 F2 addendum, option B)

Subsequent `send_to_agent` calls for the same `(conversation_id, to)` are
automatically allowed inside `canUseTool` before the broker is asked (no
`PermissionBroker.decide`, no operator dialog; `wrapper/claude-code/src/host.ts`
`#canUseTool`) **only when this wrapper process just received an accepted ack
from the server for that pair**.

- The whitelist exists **only in wrapper-process memory** as
  `autoAllowedPeer` on the conversation lifecycle track (issue #167
  `ConversationTrack` extension). It is bound to both `conversation_id` and
  the approved `to` (issue #165 round-3 review, Fujino M2); binding only the
  conversation would allow an `unknown_agent` rejection to be replaced by a
  different recipient without approval. It is not persisted by the server.
  A wrapper restart (including relaunch), or track TTL/cap eviction, clears it
  and requires first-send approval again. A transport reconnect does not clear
  it: the same-process `InterAgentTool` survives, and reconnect does not revoke
  an operator-approved conversation.
- Each wrapper instance has an independent whitelist. When B first replies to
  a conversation started by A, B has no local entry and needs normal
  broker approval through `canUseTool`.
- The first send of a new conversation (caller omitted `conversation_id`, and
  the wrapper allocates one after sending) always reaches the broker through
  `canUseTool`; no ID exists yet to match a whitelist entry.
- **Establish a whitelist entry only for the first send that is both operator-
  approved and server-accepted** (issue #165 round-4 review, Fujino design
  approval, condition A — [issue #201 comment 5384486838](https://github.com/sakuraiyuta/kaoiro/issues/201#issuecomment-5384486838)).
  `canUseTool` approval (dialog or an existing auto-allow) merely permits the
  attempt and does not write the whitelist. Register `(conversation_id, to)`
  when `#dispatch()` returns `{kind: "accepted"}`. **Rejected sends and
  `unknown` (delivery unknown because no ack arrived) never touch the
  whitelist**. Keeping unknown state gated is consistent with the repository's
  safe default of retaining approval requirements ([ADR-0051](../../adr/0051-history-restart-resilience.md)
  D3-2): the cost is repeated dialogs, whereas promoting unknown delivery
  would create a permission-bypass risk. The former optimistic registration at
  the canUseTool boundary was discarded after three review rounds; see
  [#201 comment 5384486746](https://github.com/sakuraiyuta/kaoiro/issues/201#issuecomment-5384486746)
  and the design decision in [#201 comment 5384486838](https://github.com/sakuraiyuta/kaoiro/issues/201#issuecomment-5384486838).
- **Race with inbound during a non-`done` dispatch** (issue #165 round-3
  review, Fujino M3, gitea issue #201): if a valid inbound (including a
  server-synthesized hard-limit stop) arrives for the same conversation while
  `#dispatch()` is pending, the accepted-only rule prevents a rejected send
  from establishing a whitelist through the race. `mutationGen` protects
  `closed` / `turnNumber` state so reject cleanup cannot overwrite inbound
  writes such as `closed=true` (a counter increments only on actual value
  changes; issue #165 round-4 review, Fujino condition C). The comments in
  `wrapper/agent-common/src/inter_agent.ts` `invoke()` and `receiveInbound()`
  are authoritative.
- This section applies **only to Claude's canUseTool path**. Codex fixes
  approval to `never` and has no canUseTool-equivalent route ([ADR-0033](../../adr/0033-permission-model-dual-axis.md)
  F3), so `send_to_agent` is already unconditionally allowed and this
  whitelist has no additional role.
- Antigravity's inter-agent tools (`send_to_agent` / `list_agents` /
  `whoami`) are registered through `ToolHost.listen` (`wrapper/antigravity/src/host.ts`),
  a separate MCP-serving path that never passes through `AntigravityGate`'s
  tool-class table (`wrapper/antigravity/src/gate.ts`) — they carry no
  approval axis at all, unconditionally allowed by construction, not merely
  fixed to `never` like Codex.
- Kind does not affect the decision (query/response and request/propose share
  the whitelist). Responsibility scope from ADR-0044 F2 is not an auto-allow
  axis; only first approval per conversation is the gate.

## Constraints (MUST)

- MUST: When injecting a new in-process MCP tool into the SDK, explicitly decide
  whether it belongs in default allowedTools (omitted = per-use approval;
  included = unsupervised).
