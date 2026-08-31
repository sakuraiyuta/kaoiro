---
title: Phase 3 reliability and authentication policy (seq / permission correlation / tokens)
status: accepted
date: 2026-06-11
opened: 2026-06-11
supersedes: []
superseded_by: null
related_specs: [protocol, architecture]
related_adrs: [2, 5, 10, 12, 13, 14, 21, 22, 24, 27, 42]
---

# ADR-0011 — Phase 3 Reliability and Authentication Policy (seq / Permission Correlation / Tokens)

## Status

Accepted

## Context

At the start of Phase 3 (bidirectional routing and multiple agents), the
concrete approaches for the two items in the protocol-reliability open question
(originating from issue #4; the two items were promoted to this ADR and the
original file was deleted)—seq/event ID and the correlation ID and default
timeout for permission_request—as well as wrapper authentication
([ADR-0002](0002-local-wrapper-websocket-topology.md)) and the user access
control stub ([ADR-0005](0005-access-control-oauth-stub.md)) needed to be
settled (user decision on 2026-06-11).

## Decision

1. **Introduce seq**: The wrapper adds the envelope outer key `seq` (a
   monotonically increasing integer starting at 1 for each process startup) to
   every envelope. The ordering/deduplication key is `(agent_id, seq)` + `ts`.
   **The server continues to determine the latest state by receive order
   (last-write-wins)**—because seq rolls back when the wrapper restarts, it is
   not used for overwrite decisions. version remains "0" (a forward-compatible
   key addition).
2. **Correlate permission_request with a correlation ID**: Put `request_id`
   (wrapper-generated and unique within the session) in the request payload, and
   have the `permission_decision` response return the same `request_id`.
   **The default when there is no response is unlimited waiting, as with the
   SDK** (keep the Promise pending until a response is received; migrated from
   the old 600-second default in
   [ADR-0022](0022-pending-permission-authoritative-source.md)). A finite timeout
   can be opted into in the wrapper configuration; in that case, fail-closed
   deny. The session continues after a deny. The truth for the pending state is
   persistently attached as `state_change.ext.pending_permission`
   ([ADR-0022](0022-pending-permission-authoritative-source.md)).
3. **Wrapper authentication uses an agent_id-specific token**: List
   `agent_id:token` pairs in the server configuration (env). The wrapper
   presents the token on connection; a mismatch rejects the connection. Do not
   introduce SQLite (follow-up policy on 2026-06-11).
4. **The user access-control stub uses a user token + role**: List `token:role`
   pairs in the server configuration (env). There are two roles:
   `viewer` (view-only) and `operator` (can instruct and approve). Link ADR-0005's
   "email whitelist" when OAuth is introduced (the token is the interim
   identifier).

## Consequences

### Positive

- The simplicity of the display path (receive-order last-write-wins) remains
  unchanged while seq lays groundwork for audit logs and replay.
- The approval flow is correctly correlated by request_id (the no-response
  behavior has been migrated in [ADR-0022](0022-pending-permission-authoritative-source.md)
  to the SDK default of unlimited waiting).
- An effective guard (the operator role) is placed at the entry point for
  bidirectional operations (which mean remote tool execution).

### Negative

- Token management (one token per wrapper and per user) is added to the env
  configuration.
- When migrating to OAuth, user tokens must be linked to accounts again.

### Neutral

- The full RBAC implementation (the main line of ADR-0005) remains future work.
- Consumers of seq (deduplication and auditing) will be implemented in a future
  phase.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| No seq (last-write-wins only) | Causes problems for future auditing and replay (introduced by user decision) |
| No permission timeout | The agent stops indefinitely when the user is away |
| One shared wrapper token | A leak requires replacing it on every machine and weakens ADR-0002's per-wrapper implication |
| Self-declared email whitelist | Cannot be verified and does not provide a guard for bidirectional operations |
