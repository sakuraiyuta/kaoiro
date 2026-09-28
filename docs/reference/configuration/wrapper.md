---
title: Wrapper configuration
description: Runner-relayed WrapperConfig fields and Claude process-local delivery controls.
status: accepted
last_updated: 2026-09-29
related: [protocol]
---

# Wrapper configuration

### WrapperConfig fields relayed by the runner (issues #181 and #292)

`WrapperConfig` (protocol/src/index.ts) is the runner's per-spawn config
handoff to the wrapper process it launches — a process-boundary data
structure, not a `runner:<host_id>` channel message like the ones in
[Runner control and launch](../protocol/runner-control.md).
Most fields mirror the `spawn` payload verbatim (`resolveWrapperConfig`,
runner/src/supervisor.ts). This section documents the fields that instead
come from `runner.config.json`'s per-engine blocks. Claude's delivery controls
below are process-local options, not runner-relayed fields.

- `codex_backend?: "exec" | "app-server"` — runner-local `codex.backend`,
  resolved to `"exec"` when omitted and relayed only for Codex launches. The
  wrapper validates the closed enum. It is not accepted from `spawn` or a
  resume snapshot and is not a wire capability. Reload affects subsequent
  wrapper lifetimes, including resumes; existing wrappers retain their backend.

- `codex_extra_models` / `antigravity_extra_models` (`EngineModelInfo[]`)
  — the operator's `codex.extra_models` / `antigravity.extra_models`
  declaration (runner.config.json), already merged by the runner's
  `buildRegister` into the launch catalog it advertises. Relayed so the
  wrapper applies the SAME merge to its own catalog resolution — `ext.models`,
  effort-switch availability (Codex only), and `setModel` validation must
  all recognise a declared model too, not only the register's launch-time
  list. Absent / empty on either field means no declarations for that
  engine. See [Codex model settings](../../operations/codex-model-settings.md#d-kaoiros-own-extra_models-declaration-issue-292) (D) and
  [Runner configuration](runner.md)'s "Codex 設定" / "Antigravity
  configuration" sections for the declaration syntax and merge semantics.

- `antigravity_cli_path` / `antigravity_probe_timeout_ms` — runner-local
  values derived from `antigravity.cli_path` / `antigravity.probe_timeout_ms`.
  They are not accepted from a server `spawn` payload and introduce no
  server/dashboard error vocabulary. The wrapper snapshots them at launch;
  path resolution or probe failure is reported only by an existing bounded,
  redacted local diagnostic.

- `max_sandbox` / `max_approval` / `max_network_access` — runner-local
  values derived from `antigravity.max_sandbox` /
  `antigravity.max_approval` / `antigravity.max_network_access`
  ([ADR-0057](../../adr/0057-antigravity-adapter.md) F4c Stage B0, issue
  #359). These are the host-local permission-switch
  ceilings for that agent: the wrapper (and the server, redundantly) reject
  a `set_permission` widening any axis past its ceiling with
  `exceeds_launch_ceiling`. See [Runner configuration](runner.md)'s
  "Antigravity configuration" section for the declaration syntax and
  defaulting rules.

### Claude phase-2 delivery controls

`KAOIRO_CLAUDE_PHASE2_DELIVERY=1` in the Claude wrapper process environment
enables advertising `early: "fold"` and `yield: "tool_boundary"` at join. The
default is off; any other value leaves both modes unadvertised. The server
must also echo delivery modes v1 before the wrapper uses either mode. Keep
the flag off until the production-settings native R3 measurement has
established the result-to-root-hook delay for the deployed Claude settings.
The existing normal stage reports remain available when phase 2 is off.

The following optional `WrapperConfig` fields control the Claude input
scheduler. They are read when that wrapper starts; changing them requires a
new wrapper process. A directly launched wrapper may set them in its config
JSON. Runner-generated wrapper configs do not relay these fields, so a
runner-managed deployment sets them through the inherited environment.
An explicit config value wins over its environment fallback.

| Field | Default | Input | Effect |
| --- | ---: | --- | --- |
| `yield_claim_timeout_ms` | 2,000 ms | Positive integer up to 60,000; fallback `KAOIRO_CLAUDE_YIELD_CLAIM_TIMEOUT_MS` | Maximum wait for a server `yield_claim` before downgrade to early input with `claim_timeout` |
| `pending_receipt_root_timeout_ms` | 2,000 ms | Positive integer up to 60,000; fallback `KAOIRO_CLAUDE_PENDING_RECEIPT_ROOT_TIMEOUT_MS` | One bounded live-turn wait across successive fold receipts before a claimed cut; also the separate wait from the old result for a pushed fold or cut root hook, paused by a live task-notification turn |
| `urgent_overtake_limit` | 2 root boundaries | Integer from 1 through 64; fallback `KAOIRO_CLAUDE_URGENT_OVERTAKE_LIMIT` | Consecutive urgent peer roots allowed ahead of the oldest queued ordinary peer root; operator roots neither consume nor reset the count |
| `folds_per_turn` | 3 batches | Integer from 1 through 64; fallback `KAOIRO_CLAUDE_FOLDS_PER_TURN` | Fold reservations allowed in one live turn; a pushed receipt that becomes void or unknown keeps its slot |

If the live-turn pre-cut wait expires, the yield is downgraded with
`receipt_wait_timeout`; the claim and interval remain consumed, and the host
continues. If the post-result root-hook wait expires, the wrapper records
`root_hook_timeout`, freezes admission and tool-origin authority, cancels
queued input, and enters `error`. The operator must then restart it using
[Claude fail-stop recovery](../engines/claude-events.md#recovering-a-fail-stopped-claude-wrapper).
See [Claude recipient handoff](../inter-agent/delivery.md#claude-recipient-handoff)
for stage and reply-authority behavior.

## See Also

- [Runner control and launch](../protocol/runner-control.md) — the
  `runner:<host_id>` control channel this config rides (`spawn` payload
  fields this page's intro refers to as mirrored verbatim).
- [Runner configuration](runner.md) — the Codex backend selector and other
  `runner.config.json` settings not yet migrated here.
