---
title: Model and effort state contract
status: accepted
last_updated: 2026-09-19
description: The model/effort provenance, resume-drift snapshot, and pending-switch envelope fields.
---

# Model and effort state

#### `ext.model_source` / `ext.effort_source` (2026-07-11, [ADR-0032](../../adr/0032-codex-adapter.md) F4bc addendum, phase 15)

Source vocabulary indicating how model/effort values were chosen. Because it
communicates provenance, **preserve an explicit source even after SDK
confirmation**.

- Value: `"launch" | "env" | "config" | "default"` (`ModelSource` type)
  - `launch` — SpawnMessage.model / SpawnMessage.effort.
  - `env` — engine-specific environment (`KAOIRO_CLAUDE_CODE_DEFAULT_MODEL` /
    `KAOIRO_CODEX_DEFAULT_MODEL`).
  - `config` — `model` / `effort` in `kaoiro.config.json`.
  - `default` — no explicit value; delegate to the engine account / SDK default.
- Resolution priority: `launch > env > config > default`.
- Startup stamp: **when explicitly supplied**, stamp `model` and
  `model_source=launch|env|config` immediately (optimistic stamp, phase-15
  [15-4b/4c]). An SDK report rewrites neither: the pick keeps the spelling it
  was given (an alias `opus[1m]` is reported back as `claude-opus-5[1m]` and
  stays `opus[1m]`), and replacing the source with `default` would falsely
  claim an account default.
- **When unspecified**: stamp neither `model` nor `model_source` at startup;
  the first SDK report emits `model` with `model_source="default"`.
- **Engine-side switch away from an explicit pick** (issue #363, Claude
  `model_refusal_fallback`): the engine's latest report (init, context usage,
  or a session-scope fallback notice) is compared with the pick. Another
  spelling of the pick (equal string, or the catalog resolves both to one id)
  is the same model and shows nothing; an undecidable comparison (catalog not
  yet loaded) is held and judged once the catalog lands — a fallback notice
  is authoritative on its own. A report that is a different model is
  DISPLAY-ONLY: the top-level `ext.model` / whoami `model` show the running
  model with `model_source: "fallback"` (`DisplayedModelSource`), while
  `ext.effective` — and therefore the resume snapshot — keeps the explicit
  pick and its source, so a relaunch re-sends the operator's model (explicit
  `model` beats the CLI's resumed session state; measured on SDK 0.3.258).
  The wrapper also emits a one-shot `switch_error{reason:"sdk_fallback",
  requested:<pick>, rolled_back_to:<running>}`, a transcript system line,
  and a stderr diagnostic, and re-emits `state_change` whenever a report or
  the catalog moves the displayed model, not only at the next transition.
  `"fallback"` never appears in `ext.effective`; the runner pair rule and
  the server snapshot sanitizer do not accept it. A subagent-only fallback
  (`scope: "local"`) is logged and changes nothing.
  An explicit `set_model` supersedes the divergence and persists as
  `config` as before.
- Effort follows the same *startup* semantics (`ext.effort_source`): without
  an explicit startup value the wrapper does not know the SDK default and
  waits for its report. Unlike model, effort has no engine-side
  fallback-divergence display — `#applyModelFallback` never touches
  `#effort`/`#effortSource`, and `effort_source` stays typed `ModelSource`,
  not `DisplayedModelSource`.

#### `ext.resume_snapshot` / `ext.effective` / `ext.resume_drift` (2026-07-11, [ADR-0032](../../adr/0032-codex-adapter.md) F4bc + [ADR-0033](../../adr/0033-permission-model-dual-axis.md) F4 addendum, phase 15)

Envelope extensions for D8 (resume drift detection), detecting unintended model
or permission substitutions on the resume path.

- `ext.resume_snapshot` (`ResolvedSnapshotExt`): the **last effective values** in
  the source session—`model`, `model_source`, `effort`, `effort_source`,
  `permission_mode`, `sandbox`, `network_access`, and `approval` (Antigravity's
  launch-fixed approval axis, [ADR-0057](../../adr/0057-antigravity-adapter.md)
  F4c; unset means absent).
  **Important**: use the last effective values, not spawn values. If an operator
  changed model, effort, permission mode, or sandbox/network mid-session, snapshot
  the latest confirmed values so an intentional change does not trigger a resume drift.
- `ext.effective` (`ResolvedSnapshotExt`): effective values, same shape. For
  switchable permissions, sandbox/network fields require a current observation;
  omit them while the current execution's policy is unknown.
- `ext.resume_drift` (`ResumeDriftExt`): per-field differences between the two
  snapshots as `Array<{field, prev, now}>`; an empty array means no difference,
  absent means a fresh spawn rather than a resume.
- On a difference, the wrapper warns on stderr and AgentDetail shows a drift badge.

#### `ext.pending_model` / `ext.pending_effort` / `ext.switch_error` / `ext.effort_reset` (2026-07-13, [ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md) F1–F3, phase 16)

Represent the pending/effective/rollback stages of a mid-session model or effort
switch in the envelope. **The current turn is unchanged; apply from the next
turn** ([ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md) F1).

- `ext.pending_model?: string` — value requested by `set_model` but not yet
  applied as the next turn's `turn_context.model`; promote it to
  `ext.effective.model` and clear `pending_model` at the next turn. AgentDetail
  shows `pending: <display_name>`.
- `ext.pending_effort?: string` — same semantics for effort.
- `ext.effective` (phase 16) also carries the **current effective model/effort**
  during the session, promoting pending values at the next turn boundary and
  retaining them on subsequent `state_change` events.
- `ext.effort_reset?: boolean` — when the old effort is not in the new model's
  `effort_levels`, report that it was reset to `default_effort` instead of
  silently downgrading ([ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md)).
  UI states that the old effort was unavailable.
- `ext.switch_error?: {kind: "model" | "effort", requested: string, reason: string, rolled_back_to?: string}` — one-shot report when the post-switch turn
  fails loudly (400/404, etc.); clear it at the next turn boundary (one stamp,
  ADR-0035 F3). `rolled_back_to` is the previous pinned last-known-good value
  (normally the prior turn's effective value). UI reports failure and rollback;
  never put the failed value in effective or resume snapshots (phase-16 16-7).
  The one exception is `reason: "sdk_fallback"` (issue #363, see the model
  bullet above): there `requested` is the still-held explicit pick and
  `rolled_back_to` is the model actually running now — the reverse direction
  from every other reason.

**Operator drift filter for `resume_drift`** (phase-16 addendum, [ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md) F2): do not include
model/effort changes intentionally made by an operator mid-session (intentional
change is not drift). Consult the adapter's `modelRollbackPinned` flag and
switch history; emit drift only for an unintended substitution immediately
after resume.

## Related protocol topics

- [Envelope contract](envelope.md).
- [Session capabilities](capabilities.md).
- [Permission state](permission-state.md).
- [Session lifecycle](session-lifecycle.md).
- [State machine](state-machine.md).
- [Message topology](../../architecture/message-topology.md).
