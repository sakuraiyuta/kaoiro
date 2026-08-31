---
title: Codex model catalog
status: accepted
date: 2026-07-11
opened: 2026-07-11
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model, codex-model-catalog, codex-sdk-events]
related_adrs: [32, 34, 37, 39, 40]
---

# ADR-0035 — Codex model catalog revival and mid-session switch contract

## Status

Accepted (2026.-11, master decision).Home
[phase-16-codex-model-switch](../plans/phase-16-codex-model-switch.md)。phase-15
initial Start after completion.

## Context

[ADR-0032] (code2-codex-adapter.md) F4bc is explicit in ChatGPT-account authentication
Codex based on the observation of 2026 20-11 that model has all 400/404
`supportedModels()` This observation was before joining ChatGPT Plus
was found. same persona rollout before and after joining account default
`gpt-5.6-terra` to `gpt-5.6-sol`, the same session history continues
(2026。-11). codex-cli 0.144.1
Next:

| slug |Result|
|------|------|
| `gpt-5.6-sol` | exit 0、`MODEL_OK` |
| `gpt-5.6-terra` | exit 0、`MODEL_OK` |
| `gpt-5.6-luna` | exit 0、`MODEL_OK` |
| `gpt-5-codex` (negative control) | HTTP 400、`turn.failed`、exit 1 |

In Plus auth, curated trio explicit is specified and silent
fallback to fail. `codex doctor --json`
ChatGPT plan tier and model Under thisAbout Us,
There is a need to decide how to make the catalog presented by the UI to truthful.

model switch `setModel(value)` holds the value for the next turn,
Each turn `sessionId` is the same `ThreadOptions`.
shortage is the official contract of rollback when catalog,capability advertising,failure,
UI integration for Codex effort.

## Decision

### F1 — adopt the operator plan

Add optional codex-specific settings to `runner.config.json`:

```json
{
  "codex": { "chatgpt_plan": "plus" }
}
```

`chatgpt_plan`free| go | plus | pro | business |enterprise` closed enum.
`codex.auth_mode` (added in Phase-24), or
`codex doctor --json` is stored auth mode.
cataloge the catalog.

- auth mode `chatgpt` + plan Undeclared: empty catalog, account default delegation, stderr warn.
- auth mode `chatgpt` + `free|go`: Terra only.
- auth mode `chatgpt` + `plus|pro|business|enterprise`: Sol / Terra / Luna。
- auth mode `apikey`: curated catalog for API-key. ChatGPT plan
ignore stderr warn. Don’t break the game by simply  auth.
- auth mode detection failure: fail closed to empty catalog and stderr warn. Don't guess.

#### auth mode decision priority (Phase-24 supplement, 2026 -16)

`codexAuthMode` for catalog resolve is determined by priority
`runner/src/codex-auth.ts::resolveCodexAuthMode`
Injectable policy resolver, both startup and hot reload
called):

1. **Codex disabled**`capabilities`
doctor is absolutely not called.
2. **explicit `codex.auth_mode`**(`"chatgpt"` / `"apikey"` closed enum
declaration in config) →ctoratim Adopt, doctor is not called.
Environment PATH `codex` binary   host (dogfood dependent)
catalog) also correctly resolves the catalog. auth mode
metadential (OAuth )
APIdential store / environment)
escalation catalog
Unsupported model / force explicit
request reaches the current switch error rollback
runtime if an auth entity invalid dentials error
'configdential store / SDK implementation dependencies, not only config).
3. **absent + Codex enabled**`detectCodexAuthMode`
run (via doctor). failure (spawn ENOENT / JSON parse failure / mode unreported)
If `"unknown"` to fail-closed, stderr warn (doctor stdout / stderr is
relaydential-presence details
and may contain the same JSON.
4. **Implicit estimation from `chatgpt_plan` is prohibited**Home `chatgpt_plan`
to falsely determine the case that is left in config
`chatgpt_plan` is not used for the auth mode decision.

priority is the same in hot reload, and all of the following 5 transitions are consistent with helper
Processed (see phase-24 plan for details):

- next disabled → `"unknown"`
- next explicit → instant adopt (doctor not call, value isatiatim)
- prev explicit → next absent → doctor rerun (operator removed pin)
- prev off → next on (absent) → run on doctor (first time detection from off)
- prev on (absent) → next on (absent) → prev mode

A' "chatgpt auth if Plus" is not collected. Free
to show Sol / Luna to false capacity advertising.  entitled
s 's loud fail is required as a safety valve, but the first defense line presenting known error options
No replacement.

catalogle, workspace adminAbout Us, rollout drift, etc.
There is a possibility that entitlement is lost. There is the second F3 at the specified failure.
Defending line. catalog is not a guarantee of availability, but the operator declaration and the current
Specify the candidate group based on curated snapshot in UI tooltip and docs.

### F2 — catalog and effort`ext.models`integration

Configure global constant of `CODEX_MODELS` from auth mode operator plan
replace resolver.  engine register engine catalog and after spawn
`state_change.ext.models` uses the same resolver output and
Match the candidate group of AgentDetail.

Codex SDK 0.144.1
`effort_levels` The value set is reconfirmed by the CLI/S  type and actual machine at the start of implementation,
Unverified values are not advertised. [ADR-0032] (code2-codex-adapter.md) F4bc E-B,
execution of integration to model entry instead of independent effort catalog.

### F3 — mid-session model switch contract

`set_model` of the operator follows the following agreement:

1. **turn boundary**:  ution turn does not change. This page has been automatically translated.
If you want to change immediately during execution, then send new instruction.
2. **continuity**: Same `sessionId` `resumeThread(sessionId, options)` and history
keep. Make a fresh session only for model changes.
3. **pending and effective separation**: The UI can display the pending value, but
`ext.model` and server snapshot will only be determined by the effective value reported by the successed turn.
4. **loud fail**: Display 400/404 or other explicit rejection as failure, and another model or
silent fallback
5. **rollback**: The wrapper holds the last success model. switch turn
then destroy the pending value, and then instruction resume the same session with the old model.
Do not resend the failuremodel until the operator explicitly retrys.
6. **drift semantics**: operator-requested switch
`resume_drift` The resume snapshot of phase-15 is the last
Save. The failed pending value is not written to snapshot.

effort switch also turn boundary, effect confirmation, loud fail, rollback, drift
Follow the contract. If effort is out of `effort_levels` of new model when changing model, UI is model
Select or return the active value at the same time as above. I don't convert to approximate level.

### F4 — `supports_model_switch`

[ADR-0034] (ses4-session-capabilities-advertisement.md) F2 reservation field
`ext.session_capabilities.supports_model_switch` true
codex catalog for session is non-empty and the wrapper is `set_model` and rollback
Provide contracts. If not stamp/false, set the model switch UI to disabled.

Add `supports_effort_switch` at the same time and non-empty to the active model
`effort_levels` is true. dashboard is not the engine name
Determines the mid-session operation with capability. Selecting the model when launching the LaunchHome
Using engine catalog, session capability is used for operation after spawn.

### F5 — phase-15

phase-15 task 15-4 "Account Default" Codex special case of AgentDetail
To replace `model_source`, do not touch the same special case again in phase-16.
The UI scope of phase-16 is now limited:

- Launch model's Codex model / effort
- AgentDetail's mid-session model / effort switch enabled.
- pending / effective / failure / rollbackdisplay.
-enable/disable by capability.

## Consequences

### Positive

- No model that can not be used for Free / Go, and no choice is returned in Plus or higher.
- The model switch that maintains the session/history becomes a formal contract.
- Use the same catalog for model and effort candidates, start-up options, and mid-session options.
- entitlement driftJapanese termoses session with loud fail + rollback.

### Negative

- The operator is required to update the config config when changing the ChatGPT plan.
- You can't fully express workspace adminAbout Uss and stage rollout only with plan declaration.
- Depends on ex state when auth detection and catalog resolver is launched.

### Neutral

- Existing behavior (empty catalog + account default) is maintained when plan is not declared.
- catalog for API-key is another branch of ChatGPT plan catalog and does not share entitlement guess.

## Alternatives Considered

| Option | Decision |
|--------|----------|
| A': `auth-mode=chatgpt`If you present trio on Plus premise|Reject. Free/Go is the same auth mode, so make false positive structurally. No vague fail is an erroneous advertise|
|B: operator returns a plan| **Adopt**Home There is a manual renewal cost, but it can be the most recent and fail-closed in the absence of enumeration API|
|probe each sort to endpoint and generate catalog|Reject. sesta/latency is consumed for each startup, and the probe itself generates a session. rate limit and temporary failure as entitlement|
|permanent empty catalog|Reject. There is no convenience to continue to disabling existing switch transport routes, with the need for changing gating fact and operator through trio in Plus.|
|fresh session|Reject. S、 same-session resume|

## Implementation

[phase-16-codex-model-switch](../plans/phase-16-codex-model-switch.md)
