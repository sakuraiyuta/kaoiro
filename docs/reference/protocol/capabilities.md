---
title: Session capabilities contract
status: accepted
last_updated: 2026-09-19
description: The ext.session_capabilities shape, stamp timing, and per-engine advertised values.
---

# Session capabilities

#### `ext.session_capabilities` (2026-07-11, [ADR-0034](../../adr/0034-session-capabilities-advertisement.md) F1/F2)

An envelope field expressing feature availability per session. It absorbs
differences (auth mode, plan tier, wrapper implementation) that engine names
cannot represent.

- Shape (`SessionCapabilitiesExt`):
  - `supports_attachments: boolean` — whether attachments are accepted (false disables the Composer attach button and shows a “not supported in this session” tooltip).
  - `attachment_types?: ("image")[]` — optional attachment restriction. **Absent preserves legacy behavior with no type restriction**; when present, only listed types are allowed. SDK block names are not exposed. Codex advertises `supports_attachments: true, attachment_types: ["image"]`, limiting picker/paste/drop to images; Claude omits the field and accepts all legacy types.
  - `supports_user_input_dialog: boolean` — availability of `ask_user_question`.
  - `user_input_modes?: string[]` — conditions when dialog firing is limited to a mode or sandbox (empty/absent = unconditional).
- **Stamp timing**: from the first `state_change` immediately after spawn (do not wait for a session-init event; Codex `thread.started` may not occur before the first turn, so waiting would show a false fail-closed default).
- Unstamped means conservatively “feature unavailable” (fail-closed); UI decisions use only this field.
- `supports_model_switch: boolean` — whether mid-session `set_model` is accepted (phase 16, [ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md) F4).
- `supports_effort_switch: boolean` — whether mid-session `set_effort` is accepted. UI shows/hides model and effort selectors from each boolean, never from engine name (ADR-0034 F3).
- `supports_permission_switch?: boolean` — accepts the engine-neutral `set_permission` control and implements its synchronization/observation contract below. Absent or false means unsupported. Codex advertises true when the contract is implemented end to end; Antigravity advertises true once permission-sync negotiation succeeds and the runner has relayed all three switch-axis ceilings ([ADR-0057](../../adr/0057-antigravity-adapter.md) F4c Stage B0, issue #359); Claude does not implement runtime `set_permission`. This is independent of Claude's six-mode selector.
- `supports_permission_mode_switch?: boolean` — accepts the existing six-value `set_permission_mode` command. Claude advertises true from its first state_change, including an idle spawn/restore with no configured or observed permission_mode, and retains it after SDK metadata arrives. Codex and Antigravity Stage A do not advertise true. This describes command availability, not the effective mode or fixed permission constraints. The absent-capability compatibility rule below is the explicit exception to the general unstamped-capability rule.
- `supports_session_reset: boolean` / `session_reset_modes?: ("new" | "clear")[]` — whether the operator can run `session_reset` and which modes are available. This is separate from exposing the agent's `request_session_reset` tool, which both engines now register behind per-call operator approval — Claude through canUseTool, Codex through the wrapper-side gate inside the bridge tool call (ADR-0043, 2026-09-14 amendment).
- `supports_context_usage: boolean` — whether this session provides an authoritative context-window snapshot in `ext.context` (phase 21, [ADR-0040](../../adr/0040-context-usage-capability.md)). UI has three states:
  - **absent** — unstamped capability from an old wrapper during rolling upgrade; hide the context row rather than treating it as unsupported.
  - **explicit `false`** — adapter cannot provide an exact snapshot (currently Codex); show “unsupported”.
  - **explicit `true`** — adapter promises to stamp `ext.context`; show a meter when it arrives and a loading placeholder before then.
- Claude is `true`: SDK `getContextUsage()` can return exact `totalTokens`/`maxTokens`/`percentage` (best-effort even immediately after init; failures leave “loading”). Codex is `false`: `turn.completed.usage.input_tokens` is per-turn input only and shrinks on compaction, excluding reasoning/output, so it is not context usage (see [codex-sdk-events](../engines/codex-exec-events.md)).

- **Stamp timing**: **from the first state_change** directly after spawn (do not
  wait for a session_init-equivalent event). Codex delays `thread.started` until
  the first turn because it spawns a new `codex exec` process every turn; waiting
  for session_init would make a newly started Codex agent display falsely as
  “no capability” under the fail-closed default
  ([codex-sdk-events](../engines/codex-exec-events.md)). Claude also stamps from its first
  state_change for symmetry.
- **UI decision principle**: The UI must not determine capability from the
  engine name (`ext.engine`) (review prohibition,
  [ADR-0034](../../adr/0034-session-capabilities-advertisement.md) F3). Look only
  at boolean / conditional arrays in `ext.session_capabilities`.
- **Current advertised values**:
  - `wrapper/claude-code`: `supports_attachments: true` /
    `supports_user_input_dialog: true` (unconditional; omit
    `attachment_types` = no type restriction)
  - `wrapper/codex`: `supports_attachments: true` /
    `attachment_types: ["image"]` / `supports_user_input_dialog: true`. The UI
    limits picker / paste / drop to images (changed from the original planned
    `false` when attachments were added in phase-14)
  - `wrapper/antigravity`: `supports_attachments: false` /
    `supports_user_input_dialog: true` / `supports_model_switch: true` /
    `supports_effort_switch: false` / `supports_context_usage: false`
- **`supports_model_switch` / `supports_effort_switch`** (implemented in
  phase-16, 2026-07-13, [ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md)
  F4): Advertise whether `set_model` / `set_effort` are accepted mid-session.
  Claude is always `true` because its SDK supports them; Codex is `true` when
  the catalog resolver can return `EngineModelInfo[]` (auth mode and plan are
  known), and `false` when unknown / the catalog is empty. The engine updates
  the advertisement whenever catalog / auth mode changes.
- **`supports_permission_switch` / `permission_switch_axes`**: Codex and
  Antigravity advertise runtime permission selection only after permission-sync
  negotiation. Antigravity additionally requires all runner-supplied sandbox,
  network-access, and approval ceilings; absent capability fields remain
  fail-closed for legacy peers.

## Related protocol topics

- [Envelope contract](envelope.md).
- [Model and effort state](model-effort.md).
- [Permission requests](permission-requests.md).
- [Extension architecture](../../architecture/extensions.md).
- [Session lifecycle](session-lifecycle.md).
- [State machine](state-machine.md).
- [Attachment wire contract](attachments.md).
- [Attachment rendering by engine](../engines/attachment-rendering.md).
