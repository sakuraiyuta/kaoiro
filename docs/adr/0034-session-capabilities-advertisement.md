---
title: envel  advertising on session capabilities
status: accepted
date: 2026-07-11
opened: 2026-07-11
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model, file-upload]
related_adrs: [22, 25, 32, 33, 35, 36, 37, 40]
---

# ADR-0034 — envel advertisement advertising on session capabilities

## Status

Accepted ([phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md)))

## Context

In [phase-14](../plans/phase-14-codex-adapter.md), the actual operation verification after the codex adapter has been promoted, and it was found that the UI has multiple "code movement lines that tend to branch function availability with the engine name". Example:

- Composer Attachment (file upload) button: The codex adapter at the time was an accessory open, but if the Code name is "Codex disable", it will be false negative when the codex implements attachments such as image input in the future (SJapanese term side implementation will not be obstructed with old UI only). In the actual phase-14, Codex corresponds to image attachment, and this concern was real.
- Availability of AskUsertionstion (`ask_user_question` MCP tool): Codex is provided via MCP bridge, but the actual operational plan tier (Free / Go) session and other implementation sessions may cause "not fire in dialog" (Home operation perspective, 2026-11-11 behavior confirmation).
-Unable to express variable items in the session unit (the difference between the auth mode / plan tier / wrapper implementation status) only with the engine name.

The risk of false negative/positive that the engine name determining is brought in will always occur as long as the engine evolution continues. Subst tion of the judgment axis from the engine name to the design that judges the function availability by seeing only the capability capability.

The envel  schema ([ADR-0033] (model3-permission-model-dual-axis.md) of phase-14 has already established a pattern that "property value (`ext.permission`) can be placed in the engine neutral", so the function availability is also extended in the same pattern.

## Decision

### F1 — envelope schema `ext.session_capabilities`Add

wrapper**spawn from the first state change**stamping `state_change.ext.session_capabilities` (assembling capability when constructing a adapter, and sending it with initial state change). The same ext is maintained in the subsequent state change, and the value that can change in the session will be updated when it changes.

session init related events (Claude `SDKSystemMessage(init)`, Codex `thread.started`)**Not waiting**`thread.started` does not reach the first turn, and if set to fail-closed default at the end, the codex agent will be "unsupported" error display ([phase-15](../plans/phase-15-wrapper-ux-parity.md), the same as the .../plans/phase-15-wrapper-ux-parity.md).

```json
{
  "type": "state_change",
  "state": "idle",
  "ext": {
    "engine": "codex",
    "permission": { "sandbox": "workspace-write", "approval": "never" },
    "session_capabilities": {
      "supports_attachments": true,
      "attachment_types": ["image"],
      "supports_user_input_dialog": true,
      "user_input_modes": ["plan"]
    }
  }
}
```

When not stamp (not provided), the UI is conservatively interpreted as "un ed" (false equivalent). attach button disabled, the question dialog system UI is "unsupported" display). fail-closed.

### F2 — Initial field

Add the following to `@kaoiro/protocol` envel  type:

| field |Type||
|---|---|---|
| `supports_attachments` | `boolean` |Attached file (file upload) When false, the attach button of Composer is disabled + tooltip "Not supported in this session"|
| `attachment_types` | `("image")[]` (optional) |Type limit of attachment.**absent = no type limit**Existing`supports_attachments`maintains the meaning and only present = enumerated type. engine-neutral`"image"`Only.|
| `supports_user_input_dialog` | `boolean` | `ask_user_question`(MCP tool / SDK Special ) When false the AgentDetail question UI system is "unsupported" display|
| `user_input_modes` | `string[]` (optional) |Permission mode / sandbox`["plan"]`= dialog will fire only in plan mode). empty/unspecified = unconditional|

[ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md) F4 and phase-16 have been implemented in Codex, and `supports_effort_switch` was implemented in Claude with #105. `supports_session_reset` / `session_reset_modes` implemented in [ADR-0036] (0036-session-lifecycle-commands.md) F5 and phase-17. The future field (e.g. `supports_cwd_tracking`) can also be added by following the envel  schema + agent-common type in the frame of this ADR.

### F3 — UI Principles

UI does not determine function availability in engine name (`ext.engine`). Supported:

- Composer attachment button: enabled only when `ext.session_capabilities.supports_attachments === true`
- AgentDetail / Composer's question UI: `ext.session_capabilities.supports_user_input_dialog === true` only when active, `user_input_modes` is specified and the current mode is not included in the set "Conditional unsupported" display

`ext.engine` remains on envel , but the application is limited to display and log/telemetry only. The engine name is used to determine function availability.

### F4 — engine adapter

The `EngineAdapter` interface of `@kaoiro/agent-common` does not add a function  , each adapter constructs a `session_capabilities` directly with the state stamp path (equivalent to `#statusExt`). Reason: Capability is not a “Facts fact” over the session-lifetime, but it is a result of apter implementation + spawn time selection + auth mode, so it is close to the actual form that assembles in the adapter internal and flows to envel..

Initial implementation:

- `wrapper/claude-code` (Claude adapter): `supports_attachments: true` / `supports_user_input_dialog: true` (unconditional). If the SDK has a condition in the future, please add it in this location.
- `wrapper/codex` (Codex adapter): `supports_attachments: true, attachment_types: ["image"]` / `supports_user_input_dialog: true`. `"image"` converts the SDK to `local_image` path input in the adapter and does not leak the SDK term to the protocol. Claude does not advertise `attachment_types`, so there is no type limit as existing. The plan tier judgment is because the plan tier itself is not acquired because it wants to beHome from the `codex doctor` information of [codex-model-catalog](../specs/codex-model-catalog.md). When dialog is not available in Free/Go plan, it will be reHomeed to `user_input_modes`.

### F5 — deprecation / migration

The engine name judgment is prohibited at the time of review, and if the engine name is specified in the existing code, it will be replaced with the ADR judgment when implementing phase-15. There is no unstamp period of `ext.session_capabilities` on envel  (the same PR of phase-15 implements both adapter adapters, so that the fail-closed default on the UI is only the middle state in development).

### F6 — #108 attachment type addendum (2026-07-23)

`attachment_types` does not increase the value of the engine name, and tells the type of attachment that the session accepts to UI and wrapper. The initial closed vocabulary is only `"image"`, and if you want to add `"text"`/`"pdf"`, the protocol vocabulary will be extended first. Keep current Claude wrapper and rolling upgrade compatibility by using field absent as unrestricted.

### F7 — Ab  publish judgment of attachment capability (2026 (2003)

Old open-question `file-upload-capability-publish` (2026-06-27 votes,
urgency low) OQ
[ADR-0025](0025-file-upload-wire-and-wrapper-rendering.md) F8 (A4-α)
The following two proposals are given, "where the wrapper and client do not have the norm"
It was undecided.

|||Japanese term|
|--|--|--|
|A (tentative policy at the time)|If the wrapper is rejected, the client is only an error display. capability does not publish|Knowledge is centralized to the wrapper and there is no addition to the protocol, but UX is "rejected within 1 second"|
| B |Acceptable type`ext.capabilities`as publish, and client is reflected in disable UI|UX Good and Third-Party Clients are also available, but publish knowledge into two systems to ignore wrapper centralization, and the protocol face is not|

**Decision: Adopted real B.**However, OQ assumed independent fields
Part of the `ext.session_capabilities` of this ADR, not `ext.capabilities`
(F2 `supports_attachments`, F6 `attachment_types`)
Home

**2 layers intentionally for A-side concerns that “publish knowledge to two systems”
It is important to be separated. The ability is
*exact MIME
([ADR-0025](0025-file-upload-wire-and-wrapper-rendering.md))
F8 A4-α). The client reads is a preliminary tip, not a final decision.
There is no erosion that A wanted to avoid because there is no double norm.

The current codex adapter advertises `attachment_types: ["image"]`,
Composer is limited to attach and picker / paste / drop images.
This field is used only. Now**non-image category is pre-ex d**。
However, the UI can be SVG/BMP UI stage to allow `image/*`, and wrapper
exact MIME allow-list can be rejected as `mime_denied` — the
The "reject" path is not disappeared, but at the category level
It is correct.

**Stay**`attachment_types`
(`"text"` / `"pdf"` etc.) protocol
vocabulary is already established, so it is independent
Open-question is not tracked, and is treated as a supplement to F6 when required.

## Consequences

### Positive

- Function Availability judgment is released from the engine name, and the UI side judgment is not corrected in the evolution of engine (Codex image input, etc.).
- Can express variable conditions (plan tier / auth mode / wrapper implementation difference) in the session unit.
- Reduces the engine value of the UI (display name is single for display only).
- When fail-closed is not stamped, the apter implementation leak is not "live only function display and the actual behavior is broken".

### Negative

- envel  size is slightly different (from several bytes to ten bytes, once per session + only when changing).
- The maintenance burden that implements adapter with each adapter is generated (the degree of additional field). Cover by required stamp detection.

### Neutral

- viewer delivery automatically covers the ext allow-list of [ADR-0021] (0021-role-information-dis sure-policy.md). session capabilities
- [ADR-0022] (0022-pending-permission-authoritative-source.md) authoritative source principles (`state_change.ext` to SoT) follow the same pattern in this ADR and do not supersede.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|engine by engine name|Codex Evo  false negative / positive, non-expression of session unit difference (the core of Home operation pointing out)|
|engine registration`HostInfo.engines[]`host-static|session Unable to express unit difference (auth mode / plan tier / spawn time selection).   returns a fixed value at host startup, and deviates from the actual session behavior|
|Features`EngineAdapter`to interface`capabilities(): CapSet`) Have as|The interface is enlarged. capability is part of the session state, so you want toRoutehronize with the path of state stamp (source-of-truth)|
|Open with "true equivalent" when not stamp (fail-open)|The adapter implementation leak is "supported" on the UI, and the actual behavior is broken. fail-closed default|

## Related

- Origin: [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md) The engine name determining risk (design conversion of D4/D5) seen in actual operation verification.
- [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md).
- engine ADR: [ADR-0022] (0022-pending-permission-authoritative-source.md) (authoritative source pattern attack), [ADR-0032] ( engine2-codex-adapter.md) (additional starting point of Codex adapter), [ADR-0033] (model3-permission-model-dual-axis.md) (precedent example of neutralization pattern by ext).
-modelmodels: [protocol](../specs/protocol.md) (`ext.session_capabilities` supplement), [model-model](../specs/model-model.md) (relationship with EngineAdapter).
-git issue: [#99](https://github.com/sakuraiyuta/kaoiro/issues/99) — lister information enhancement of list agents ( model/model/ effort). Review of the "directory" decision of phase-8. TheHandmade is expected to inherit the same principle (state stamp = SoT) because it is affinity with the session capability capability pattern of this ADR.
