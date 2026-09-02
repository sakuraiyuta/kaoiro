---
title: Restore the Codex model catalog and define the mid-session switch contract
status: accepted
date: 2026-07-11
opened: 2026-07-11
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model, codex-model-catalog, codex-sdk-events]
related_adrs: [32, 34, 37, 39, 40]
---

# ADR-0035 — Restore the Codex model catalog and define the mid-session switch contract

## Status

Accepted (2026-07-11, approved by マスター). Implementation is
[phase-16-codex-model-switch](../plans/phase-16-codex-model-switch.md), to begin
after phase-15 initial completion.

## Context

[ADR-0032](0032-codex-adapter.md) F4bc emptied Codex’s `supportedModels()` based on
the observation on 2026-07-11 that every explicit model under ChatGPT-account
authentication returned 400/404. It was later found that this observation was
from before ChatGPT Plus enrollment. In the same-persona rollout before and after
enrollment, the account default changed from `gpt-5.6-terra` to `gpt-5.6-sol`,
while the same session history continued (2026-07-11). After Plus enrollment,
running codex-cli 0.144.1 from a host terminal confirmed the following:

| slug | Result |
|------|------|
| `gpt-5.6-sol` | exit 0, `MODEL_OK` |
| `gpt-5.6-terra` | exit 0, `MODEL_OK` |
| `gpt-5.6-luna` | exit 0, `MODEL_OK` |
| `gpt-5-codex` (negative control) | HTTP 400, `turn.failed`, exit 1 |

With Plus auth, explicit selection of the curated trio succeeds, and a
non-entitled slug fails loudly without silent fallback. Meanwhile,
`codex doctor --json` reports auth mode but not ChatGPT plan tier or the entitled
model set. Under this constraint, we need to decide how to make the catalog shown
by the UI truthful.

The model-switch transport already exists. `setModel(value)` retains the value for
the next turn, and each turn calls `resumeThread()` with a fresh `ThreadOptions` and
the same `sessionId`. What is missing is a formal contract for the catalog,
capability advertisement, failure rollback, and Codex-effort UI integration.

## Decision

### F1 — Adopt operator plan declaration (Option B)

Add optional Codex-specific configuration to `runner.config.json`:

```json
{
  "codex": { "chatgpt_plan": "plus" }
}
```

`chatgpt_plan` is a closed enum: `free | go | plus | pro | business | enterprise`.
The runner combines this declaration with an explicit `codex.auth_mode` (added in
Phase-24), or with stored auth-mode detection from `codex doctor --json` (fallback),
to construct the catalog.

- auth mode `chatgpt` + plan undeclared: empty catalog, delegate to account default,
  stderr warning.
- auth mode `chatgpt` + `free|go`: Terra only.
- auth mode `chatgpt` + `plus|pro|business|enterprise`: Sol / Terra / Luna.
- auth mode `apikey`: curated catalog for API keys. Warn to stderr and ignore a
  leftover ChatGPT plan declaration. Do not break runner startup merely by switching
  auth.
- auth-mode detection failure: fail closed to an empty catalog and warn to stderr.
  Do not guess.

#### Auth-mode decision priority (Phase-24 addendum, 2026-07-16)

Fix the `codexAuthMode` used by the runner to resolve the catalog to this priority
(implementation is consolidated in the injectable policy resolver
`runner/src/codex-auth.ts::resolveCodexAuthMode`, called from both startup and hot
reload):

1. **Codex disabled** (no `"codex"` in `capabilities`) → `"unknown"`. Never call
   doctor.
2. **Explicit `codex.auth_mode`** (the closed enum `"chatgpt"` / `"apikey"` is
   declared in config) → adopt that value verbatim; do not call doctor. Catalog can
   be resolved correctly even on a host whose runner environment PATH lacks the
   `codex` binary (a typical dogfood environment dependency). auth_mode is only
   declaration metadata for catalog selection; the runner neither supplies nor
   changes credentials (OAuth token / API key, etc.) in the Codex credential store /
   environment — it is therefore not an escalation. If misdeclared, the catalog can
   diverge from actual entitlement and an unsupported explicit model / effort request
   may loudly fail in the SDK and reach the existing switch_error rollback (whether
   the actual credential store / SDK instead reports invalid credentials depends on
   runtime state and cannot be asserted from config alone).
3. **Absent + Codex enabled** (legacy-config compatibility fallback) → run
   `detectCodexAuthMode` (through doctor). On failure (spawn ENOENT / JSON parse
   failure / mode not reported), fail closed to `"unknown"` and warn to stderr. Do
   not relay doctor stdout / stderr at all — it may contain credential-presence
   details in the same JSON as stored auth mode.
4. **Do not infer implicitly from `chatgpt_plan`**. An API-key runner may retain
   `chatgpt_plan` during an auth switch, and using `chatgpt_plan` as the basis for auth_mode
   would misclassify that transition.

Hot reload uses the same priority, and the helper handles all five transitions
consistently (see the phase-24 plan for details):

- next disabled → `"unknown"` (discard previous mode, do not call doctor)
- next explicit → adopt immediately (do not call doctor; value is verbatim)
- previous explicit → next absent → run doctor again (the operator removed the pin)
- previous off → next on (absent) → run doctor (first detection after returning from off)
- previous on (absent) → next on (absent) → retain previous mode (do not call doctor)

Do not adopt Option A’, “assume Plus and show the trio when auth is ChatGPT”. It
would advertise Sol / Luna to Free / Go users and make capability advertisement
untruthful. Loud failure for a non-entitled slug is necessary as a safety net, but
is not a substitute for the first line of defence: not showing known-wrong choices.

The catalog may still diverge from actual entitlement because of a stale operator
declaration, workspace-admin constraints, rollout drift, and so on. Therefore use
F3 on explicit-selection failure as the second line of defence. State in UI tooltips
and docs that the catalog is a candidate set based on operator declaration and the
current curated snapshot, not a guarantee of availability.

### F2 — Integrate catalog and effort into `ext.models`

Replace the global `CODEX_MODELS` constant with a resolver that constructs the
catalog from auth mode + operator plan. Use the same resolver output for the runner
register engine catalog and post-spawn `state_change.ext.models`, keeping the
candidate sets in LaunchDialog and AgentDetail consistent.

Attach the reasoning effort accepted by Codex SDK 0.144.1 to each Sol / Terra / Luna
entry as `effort_levels`. Recheck the value set against CLI/SDK types and a real
machine when implementation begins; do not advertise unverified values. Execute
the E-B decision from [ADR-0032](0032-codex-adapter.md) F4bc: integrate effort into
model entries rather than maintaining an independent effort catalog.

### F3 — Mid-session model switch contract

The operator’s `set_model` follows this contract:

1. **Turn boundary**: do not change an executing turn. Apply the selection starting
   with the next turn. To change immediately during execution, interrupt and send
   a new instruction.
2. **Continuity**: call `resumeThread(sessionId, options)` with the same `sessionId`
   and preserve history. Do not create a fresh session merely to change the model.
3. **Separate pending and effective**: the UI may show the pending value immediately
   after selection, but confirm `ext.model` and the server snapshot only with the
   effective value reported by a successful turn.
4. **Loud fail**: display 400/404 and other explicit-selection rejection as a
   failure; do not silently fall back to another model or the account default.
5. **Rollback**: the wrapper retains the last successful model. If the switch turn
   fails, discard the pending value and resume the next instruction in the same
   session with the old model. Do not resend the failed model until the operator
   explicitly retries.
6. **Drift semantics**: an operator-requested switch is intentional and is not
   `resume_drift`. The phase-15 resume snapshot stores the last successful effective
   value. Do not write a failed pending value to the snapshot.

Effort switching follows the same contract for turn boundary, effective-value
confirmation, loud failure, rollback, and drift. If the current effort is outside
the new model’s `effort_levels` when changing models, have the UI choose an effort
at the same time or return to the default. Do not silently convert it to an
approximate level.

### F4 — Implement `supports_model_switch`

Implement the reserved field `ext.session_capabilities.supports_model_switch` from
[ADR-0034](0034-session-capabilities-advertisement.md) F2. It is true only when the
Codex catalog used by the session is non-empty and the wrapper provides `set_model`
and the rollback contract. Disable model-switch UI when it is unstamped or false.

Also add `supports_effort_switch`, true only when the active model has non-empty
`effort_levels`. The dashboard determines mid-session operations from this
capability, not the engine name. Use the runner engine catalog for launch-time model
selection, and session capabilities for post-spawn operations.

### F5 — Boundary with phase-15

Phase-15 task 15-4 replaces the Codex-specific “account default” handling in
AgentDetail with a `model_source` check, so do not touch that special case again in
phase-16. Limit the phase-16 UI scope to:

- Restoring the Codex model / effort selects in LaunchDialog.
- Enabling mid-session model / effort switches in AgentDetail.
- Displaying pending / effective / failure / rollback states.
- Enabling/disabling through capabilities.

## Consequences

### Positive

- Do not show models unavailable to Free / Go users indiscriminately, while restoring
  selection freedom for Plus and above.
- Formalise model switching while preserving the session/history.
- Use the same catalog for model and effort candidates, launch-time selection, and
  mid-session selection.
- Expose entitlement drift through loud failure + rollback without breaking the
  session.

### Negative

- The operator must update runner config when the ChatGPT plan changes.
- A plan declaration cannot fully represent workspace-admin restrictions or staged
  rollouts.
- Auth detection and catalog resolution depend on external state at runner startup.

### Neutral

- Preserve existing behavior when no plan is declared (empty catalog + account
  default).
- The API-key catalog is a separate branch from the ChatGPT plan catalog and does
  not share entitlement inference.

## Alternatives Considered

| Option | Decision |
|--------|----------|
| A’: Assume Plus and show the trio when `auth-mode=chatgpt` | Reject. Free / Go use the same auth mode, so this structurally creates false positives. Loud failure is not an exemption for false advertisement. |
| B: Operator declares the plan | **Adopt**. It has manual update cost, but with no enumeration API it is the most truthful and can fail closed. |
| Probe each slug at the endpoint and generate a catalog | Reject. It consumes quota/latency on every startup, and the probe itself creates a session. It can mistake rate limits and transient failures for entitlement. |
| Keep the catalog empty permanently | Reject. The gating fact that the trio works on Plus and the request to switch are established; there is no benefit in keeping the existing switch transport disabled. |
| Create a fresh session for every model switch | Reject. It needlessly loses history, and the SDK already has a same-session resume path. |

## Implementation

Implement this in [phase-16-codex-model-switch](../plans/phase-16-codex-model-switch.md).
