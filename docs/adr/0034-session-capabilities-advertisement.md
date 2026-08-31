---
title: Envelope advertisement of session capabilities
status: accepted
date: 2026-07-11
opened: 2026-07-11
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model, file-upload]
related_adrs: [22, 25, 32, 33, 35, 36, 37, 40]
---

# ADR-0034 — Envelope advertisement of session capabilities

## Status

Accepted (implementation is [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md)).

## Context

After the Codex adapter was promoted to accepted in [phase-14](../plans/phase-14-codex-adapter.md),
operational verification found several UI paths where “feature availability is
often branched on engine name”. Specific examples:

- Composer’s attachment (file upload) button: the Codex adapter at that time
  wholesale-rejected attach_open, but adding an engine-name rule “disable for
  Codex” would create a false negative when Codex later implemented image input
  (the SDK implementation would advance while the UI alone stayed blocked). In
  fact, phase-14 made this concern real when Codex gained image attachment support.
- AskUserQuestion (`ask_user_question` MCP tool) availability: Codex provides it
  through the MCP bridge, but in operation there can be cases where the dialog
  does not fire in that session because of the plan tier (Free / Go) or another
  implementation constraint (behavior confirmed from もも’s operational view on
  2026-07-11).
- Values that vary per session (auth mode / plan tier / differences in wrapper
  implementation) cannot be represented by engine name alone.

The false-negative / false-positive risk introduced by engine-name checks will
continue as engines evolve. Replace engine name as the decision axis with the set
of features advertised by each session, and make the UI determine availability
only from advertised capabilities.

The phase-14 envelope schema ([ADR-0033](0033-permission-model-dual-axis.md))
already established the pattern of putting effective values (`ext.permission`)
into the envelope in an engine-neutral form. Feature availability is a natural
extension of the same pattern.

## Decision

### F1 — Add envelope schema `ext.session_capabilities`

The wrapper stamps `state_change.ext.session_capabilities` **starting with the
first state_change immediately after spawn** (assemble capabilities when building
the adapter and send them on the first state_change). Keep the same ext on later
state_changes, updating values that can change during the session when they change.

**Do not wait** for a session_init-equivalent event (Claude’s
`SDKSystemMessage(init)` or Codex’s `thread.started`): Codex spawns a new
`codex exec` process for every turn ([codex-sdk-events](../specs/codex-sdk-events.md)),
so `thread.started` is not reached until the first turn. Combined with the
fail-closed default at the end, waiting would incorrectly display a Codex agent
that has just started as “unsupported” (pass it through the same optimistic-stamp
principle as [phase-15](../plans/phase-15-wrapper-ux-parity.md)):

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

When not stamped (the field is not provided), the UI conservatively interprets it
as “no features” (false equivalent: disable the attach button and display question
dialog UI as “unsupported”). Fail-closed.

### F2 — Initial field set

Add the following to the envelope type in `@kaoiro/protocol`:

| field | type | meaning |
|---|---|---|
| `supports_attachments` | `boolean` | Whether the session accepts attachments (file upload). When false, disable the Composer attach button + show the tooltip “unsupported in this session”. |
| `attachment_types` | `("image")[]` (optional) | Attachment-type restriction. **Absent = no type restriction**, preserving the existing meaning of `supports_attachments`; present = allow only enumerated types. The initial engine-neutral vocabulary contains only `"image"`. |
| `supports_user_input_dialog` | `boolean` | Whether `ask_user_question` (MCP tool / special SDK branch either way) can be used. When false, display question UI in AgentDetail as “unsupported”. |
| `user_input_modes` | `string[]` (optional) | The permission mode / sandbox conditions under which the dialog can be used (for example, `["plan"]` = the dialog fires only in plan mode). Empty / unspecified = unconditional. |

Additional fields `supports_model_switch` / `supports_effort_switch` were already
implemented for Codex by [ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md) F4
and phase-16, and `supports_effort_switch` was also implemented for Claude under
#105. `supports_session_reset` / `session_reset_modes` were implemented under
[ADR-0036](0036-session-lifecycle-commands.md) F5 and phase-17. Future fields
(for example, `supports_cwd_tracking`) can be added within this ADR by extending
the envelope schema + agent-common type.

### F3 — UI decision principle

The UI does not determine feature availability from the engine name
(`ext.engine`). Use these mappings:

- Composer attachment button: enabled only when
  `ext.session_capabilities.supports_attachments === true`
- AgentDetail / Composer question UI: active only when
  `ext.session_capabilities.supports_user_input_dialog === true`; when
  `user_input_modes` is specified and the current mode is not in the set, display
  “conditionally unsupported”

Keep `ext.engine` in the envelope, but limit it to display (engine badge) and
log/telemetry. Do not use engine name to determine feature availability (detect
this during review).

### F4 — Advertisement implementation in engine adapters

Do not add a capability-retrieval hook to the `EngineAdapter` interface in
`@kaoiro/agent-common`; each adapter builds `session_capabilities` directly in
the state-stamp path (equivalent to `#statusExt`). The reason is that capability
is not a “static fact” over the session lifetime, but a composition of adapter
implementation + spawn-time selection + auth mode; assembling it inside the
adapter and passing it into the envelope reflects reality more closely.

Initial implementation:

- `wrapper/claude-code` (Claude adapter): `supports_attachments: true` /
  `supports_user_input_dialog: true` (unconditional). Add a branch here if the
  SDK later imposes conditions.
- `wrapper/codex` (Codex adapter): `supports_attachments: true, attachment_types: ["image"]` / `supports_user_input_dialog: true`. The adapter
  translates `"image"` into the SDK’s `local_image` path input without leaking SDK
  terminology into the protocol. Claude does not advertise `attachment_types`,
  so it retains the existing unrestricted type behavior. We would like to derive
  plan-tier checks from `codex doctor` information in [codex-model-catalog](../specs/codex-model-catalog.md),
  but plan tier itself cannot be obtained, so MVP is unconditionally true. If
  dialog unavailability is observed on Free/Go plans, then advertise
  `user_input_modes` at that point.

### F5 — Deprecation / migration

Prohibit engine-name checks during review, and replace existing engine-name
branches during phase-15 implementation with this ADR’s checks. There is no period
where `ext.session_capabilities` is intentionally unstamped (both adapters
advertise it in the same phase-15 PR), so the UI’s fail-closed default has an
observable effect only in an intermediate development state.

### F6 — #108 attachment-type addendum (2026-07-23)

`attachment_types` communicates the attachment types accepted by the session to
the UI and wrapper without adding engine-name branches. The initial closed
vocabulary contains only `"image"`; if future values such as `"text"` / `"pdf"`
are added, expand the protocol vocabulary first. Treating an absent field as
unrestricted preserves compatibility with existing Claude wrappers and rolling
upgrades.

### F7 — Absorb the attachment-capability publish decision (2026-08-03)

The old open-question `file-upload-capability-publish` (opened 2026-06-27,
urgency low) is folded into this ADR. That OQ received the following two unresolved
options from [ADR-0025](0025-file-upload-wire-and-wrapper-rendering.md) F8 (A4-α),
“the wrapper rejects; the client does not carry the policy”:

| Option | Content | Evaluation |
|--|--|--|
| A (temporary policy at the time) | The wrapper rejects and the client only displays an error; do not publish capability | Knowledge is centralised in the wrapper and protocol does not grow, but UX is “send and reject within one second” |
| B | Publish accepted types as `ext.capabilities` and have the client reflect them in disabled UI | Good UX and usable by third-party clients, but knowledge is published in two places, eroding wrapper centralisation and adding one protocol surface |

**Decision: effectively adopt B.** However, rather than the independent
`ext.capabilities` field assumed by the OQ, implement it as part of this ADR’s
`ext.session_capabilities` (`supports_attachments` from F2 and `attachment_types`
from F6).

Regarding A’s concern about “publishing knowledge in two places”, it is important
that **the two layers remain intentionally separate**. Capabilities are authoritative
only for “whether attachments can be used” and “which categories are accepted”; the
**exact MIME policy remains in the wrapper** ([ADR-0025](0025-file-upload-wire-and-wrapper-rendering.md)
F8 A4-α remains). The client reads a preflight hint, not the final decision. Since
the policy is not duplicated, the erosion A sought to avoid does not occur.

The Codex adapter currently advertises `attachment_types: ["image"]`, and Composer
uses only this field to disable the attach button and limit picker / paste / drop
to images. This **pre-excludes non-image categories** in advance. However, the UI
allows `image/*`, so SVG / BMP and similar files can be staged and may still be
rejected as `mime_denied` by the wrapper’s exact MIME allow-list — the path in A
where “see the rejection and resend” is possible has not disappeared; it simply
no longer occurs at the category level. That is the accurate interpretation.

**Remaining room**: expand the closed vocabulary of `attachment_types` beyond
`"image"` (for example, `"text"` / `"pdf"`). As F6 states, the process for
expanding protocol vocabulary first is already defined, so do not track this as a
separate open question; handle it as an F6 addendum when needed.

## Consequences

### Positive

- Feature availability is freed from engine names, so UI decision code does not
  need follow-up fixes as engines evolve (such as Codex image-input support).
- Session-varying conditions (plan tier / auth mode / wrapper implementation
  differences) can be represented as first-class values.
- UI engine branches decrease (engine name becomes display-only).
- The fail-closed default when unstamped prevents an adapter omission from leaving
  the UI displaying “supported” while runtime behavior is broken; the UI explicitly
  displays “unsupported”.

### Negative

- Envelope size increases slightly (a few to a few dozen bytes, once per session
  plus changes only when values change).
- Maintaining advertisement in every adapter creates a maintenance burden for each
  added field; require tests to detect missing stamps.

### Neutral

- Viewer delivery is automatically covered by the ext allow-list in
  [ADR-0021](0021-role-information-disclosure-policy.md) (ext is completely
  removed for viewers). session_capabilities is operator-only as well.
- The authoritative-source principle in [ADR-0022](0022-pending-permission-authoritative-source.md)
  (`state_change.ext` is SoT) follows the same pattern here; it is not superseded.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Branch on engine name (implicit assumption in the current implementation) | Codex evolution creates false negatives / positives, and per-session differences cannot be represented (the core of もも’s operational observation). |
| Put capabilities in engine registration (`HostInfo.engines[]`) (host-static) | Cannot represent per-session differences (auth mode / plan tier / spawn-time selection). The runner would return a fixed value at host startup, diverging from actual session behavior. |
| Add a hook to the `EngineAdapter` interface (`capabilities(): CapSet`) | Bloats the interface. Capability is part of session state, so synchronise it with the state-stamp path (make the envelope the source of truth). |
| Fail-open when unstamped (“true equivalent”) | An adapter omission leaves the UI displaying “supported” while runtime behavior is broken. Fail-closed is safer. |

## Related

- Origin: operational verification of [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md), where the risk of engine-name checks became visible (the design shift in D4/D5).
- Implementation: [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md).
- Related ADRs: [ADR-0022](0022-pending-permission-authoritative-source.md) (authoritative-source pattern), [ADR-0032](0032-codex-adapter.md) (origin of adding the Codex engine), and [ADR-0033](0033-permission-model-dual-axis.md) (prior engine-neutralisation example through ext).
- Related specs: [protocol](../specs/protocol.md) (`ext.session_capabilities` addendum), [plugin-model](../specs/plugin-model.md) (relationship with EngineAdapter).
- Related issue: [#99](https://github.com/sakuraiyuta/kaoiro/issues/99) — richer peer information in list_agents (engine / model / effort, etc.). Reconsider the phase-8 decision that “the directory is the minimum needed for name resolution”. Since it is compatible with this ADR’s session capability advertisement pattern, the same principle (state stamp = SoT) is expected to be inherited once work begins after the phase-15 envelope schema is fixed.
