---
title: Codex model catalog status and change paths
description: Plan × available-model table in the OpenAI Codex ecosystem; asymmetry between the two authentication modes (ChatGPT account / API key); four model-change paths (Web UI / CLI / config.toml / kaoiro's own extra_models declaration); and the information granularity of `codex doctor`. Background for ADR-0032 F4bc's “empty catalog + delegate to account default” decision.
status: accepted
related: [codex-sdk-events, protocol, plugin-model]
---
<!-- markdownlint-disable MD033 -->

# Codex model catalog status and change paths

## Purpose

[ADR-0032](../adr/0032-codex-adapter.md) F4bc chose an empty catalog for the
Codex adapter's `supportedModels()` and delegated model selection to the
account default. The **current Codex-ecosystem information supporting that
decision** (model availability by plan / authentication-mode asymmetry / change
paths / whether SDK enumeration is possible) does not fit in the ADR itself, so
it is separated into this specification.

**phase-16 update (2026-07-13)**: The decision in
[ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) restored
the catalog. Even under ChatGPT-account authentication, the **operator declares
`codex.chatgpt_plan` in `runner.config.json`** to statically resolve the
entitled-model set. It presents the Sol / Terra / Luna / Astra catalog in
LaunchDialog for Plus and above, and accepts mid-session switching (details:
[ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) and
[phase-16](../plans/phase-16-codex-model-switch.md)). This specification
remains a primary-information reference for why it depends on an operator
declaration rather than wait for an enumeration API.

**Status: accepted** — based on verbatim quotations from primary information
(official OpenAI documentation / Help Center / running `codex doctor`). However,
the entitled-model set has changed in OpenAI operations (for example,
`gpt-5.5` temporarily returned 404 then recovered as of 2026-07;
[openai/codex#26892](https://github.com/openai/codex/issues/26892), and
`gpt-6-astra` was added 2026-09 per a re-fetch of
`codex-rs/models-manager/models.json`; issue #292), so this specification's
table is a snapshot as of 2026-09-05 for the Astra row/slug and 2026-07-11 for
everything else.

## Plan × available model (2026-07-11, Astra column added 2026-09-05)

| Plan | Monthly price | Codex-available models | Codex default | Notes |
|---|---|---|---|---|
| Free | $0 | `gpt-5.6-terra` only | Terra | Sol / Luna / Astra cannot be selected |
| Go | $8 | `gpt-5.6-terra` only | Terra | Tier introduced in 2026-04 |
| Plus | $20 | Sol / Terra / Luna / Astra (effort selectable) | **Sol + medium** | Switchable in CLI/Desktop |
| Pro | $100 or $200 | Sol / Terra / Luna / Astra + `gpt-5.3-codex-spark` | **Sol + medium** | The $200 version has a 20× five-hour window |
| Business | $25/user | Sol / Terra / Luna / Astra | **Sol + medium** | Replaced former Team ($30) in 2026-04 |
| Enterprise | custom | Sol / Terra / Luna / Astra (+ individual negotiation) | **Sol + medium** | Admin can change the default |
| API-key | Usage based | Sol / Terra / Luna / Astra / 5.5 / 5.4 / 5.4-mini + some deprecated models | **Explicit selection required** | No 400/404 restriction |

`gpt-6-astra` is marked `visibility: list` upstream. Its `models.json` plan
list also names Free/Go, but that combination is unverified against the live
Free/Go experience — kaoiro's own catalog (`wrapper/codex/src/catalog.ts`)
therefore only advertises it for Plus and above, matching Sol/Terra/Luna's
existing tiering (issue #292).

**Model slugs** (identifiers used by `--model` / `~/.codex/config.toml` /
`-c model=`):
`gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-6-astra` / `gpt-5.5` /
`gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex-spark`.

**Reference API pricing** (per 1M tokens): Sol $5 input / $30 output,
Terra $2.50 / $15, Luna $1 / $6, Astra $10 / $50
([official pricing page](https://developers.openai.com/api/docs/models/gpt-6-astra),
2026-09-05).

## Asymmetry between the two authentication modes (F4bc background)

### ChatGPT-account authentication

When a model slug not entitled by the plan is explicitly specified with
`--model`:

- **HTTP 400** `{"detail":"The 'gpt-X.Y' model is not supported when using
  Codex with a ChatGPT account."}`
- Or **HTTP 404** `Model not found gpt-X.Y`

Examples of rejected slugs observed in GitHub issues (as of 2026):
`gpt-5-codex` / `gpt-5.1-codex` / `gpt-5.2-codex` / `*-codex-mini` /
`codex-mini-latest`. `gpt-5` / `gpt-5.5` were also rejected temporarily in the
past.

**No enumeration API exists**: There is currently no SDK/CLI path to
programmatically obtain the set of slugs accepted by this account.
`~/.codex/auth.json` only retains tokens and returns no entitlement.
`codex doctor` (below) also returns neither the plan tier nor entitled models.
This asymmetry and inability to enumerate are **the direct basis for
ADR-0032 F4bc abandoning a curated static list for an empty catalog**.

### API-key authentication

There is no entitlement check. Many of the rejected slugs above also work.
Some deprecated versions remain. The 400/404 risk is limited even with a
curated static list.

## Four paths for changing models

(A)-(C) below select AMONG the models Codex (or kaoiro's own curated
snapshot) already knows about. (D) is a different axis: it is how an
operator makes kaoiro aware of a model neither has advertised yet.

### (A) Web UI (Codex Settings)

On 2026-07-09, Codex was integrated into the macOS/Windows ChatGPT Desktop App.

- **Gear icon at top-right of the Codex sidebar → “Codex Settings” → model
  pull-down to switch**. The same panel has an “Open config.toml” button (an
  entry point to editing config.toml directly).
- Desktop / CLI / IDE extensions share the same `~/.codex/config.toml`, so a
  change anywhere affects all paths.

Note that this changes it **only on the Codex side**, not on the ChatGPT web
settings page (ChatGPT conversation and Codex coding are handled separately).

### (B) CLI option (temporary override)

Codex CLI help:

```text
-m, --model <MODEL>
    Model the agent should use
-c, --config <key=value>
    Override a configuration value that would otherwise be loaded from
    `~/.codex/config.toml`. Examples: `-c model="o3"`
```

- One-off override: `codex -m gpt-5.6-terra "..."`
- Dot notation: `codex -c model="gpt-5.6-luna" "..."`

The same flags pass to subcommands such as `codex exec` / `codex mcp-server`
(and to kaoiro through `@openai/codex-sdk`). Under ChatGPT auth, however,
specifying a slug outside the plan results in 400/404.

### (C) Persistent setting (`~/.codex/config.toml`)

```toml
# ~/.codex/config.toml
model = "gpt-5.6-sol"
```

**Resolution priority** (high → low):

1. CLI flags (`--model` / `-c model=`)
2. Profile (`[profiles.xxx]` section, enabled by `--profile`)
3. Project config `.codex/config.toml` (trusted projects only)
4. User config `~/.codex/config.toml`
5. Account / plan default (implicit)

The `CODEX_HOME` environment variable can also relocate `~/.codex` itself.

### (D) kaoiro's own `extra_models` declaration (issue #292)

kaoiro advertises a CURATED static snapshot of the entitled-model set
(`wrapper/codex/src/catalog.ts`, ADR-0035 H3) rather than probing Codex at
runtime, so a brand-new upstream model (like `gpt-6-astra`) is invisible to
LaunchDialog / AgentDetail until a kaoiro release updates that snapshot.
`runner.config.json`'s `codex.extra_models` lets an operator declare one
themselves in the meantime:

```json
"codex": {
  "extra_models": [
    { "value": "gpt-6-astra", "display_name": "GPT-6-Astra",
      "effort_levels": ["low", "medium", "high", "xhigh", "max", "ultra"],
      "default_effort": "low" }
  ]
}
```

- Only `value` is required; `resolved_model` is upstream-derived metadata and
  is never read from config. `display_name` defaults to `value`;
  `effort_levels` / `default_effort` absent means no effort switching is
  offered for that model (ADR-0035's "never infer an effort domain" rule
  — kaoiro does not guess one).
- The same mechanism (identical `parseExtraModels` / `mergeExtraModels`
  helpers) is available for the Antigravity engine as
  `antigravity.extra_models` (phase-34 Stage B6, issue #292) — see
  runner/README.md's "Antigravity configuration" section.
- Declared entries are merged onto the resolved base catalog by
  `mergeExtraModels` (runner/src/config.ts, and the identical wrapper-side
  copy in `@kaoiro/agent-common`'s `catalog.ts`): a `value` matching an
  existing entry overrides it in place, a new `value` is appended. The
  runner applies this to the register payload it advertises (so
  LaunchDialog offers it before any wrapper exists); the wrapper applies
  the same merge to its own catalog resolution (`ext.models`, effort-switch
  availability, `setModel`).
- The declaration is host-wide (every agent on that runner), takes effect
  on the next spawn after a runner restart or config hot-reload, and does
  not bypass entitlement — a model the account is not actually entitled to
  still fails with the SDK's usual 400/404, surfaced as the existing
  `switch_error` rollback (or a launch failure for a fresh spawn).
- A Codex declaration may include `minimal_client_version` as a
  `major.minor.patch` string. When present, the runner and wrapper exclude
  the entry if the SDK-bundled Codex CLI is older. When absent, the entry
  remains advertised and the runner writes one warning: CLI compatibility is
  the operator's responsibility for that escape-hatch declaration.

## Information granularity of `codex doctor`

Of the 18 checks returned by `codex doctor --json` (0.144.1), the auth /
config-related checks report the following:

| Field | Path | Purpose |
|---|---|---|
| `auth.credentials.details["stored auth mode"]` | `~/.codex/auth.json` | Identifies `chatgpt` / `apikey` (available to kaoiro) |
| `auth.credentials.details["stored API key"]` | Same as above | Whether an API key is also used |
| `auth.credentials.details["stored ChatGPT tokens"]` | Same as above | ChatGPT token storage status |
| `config.load.details["model"]` | `~/.codex/config.toml` | Explicitly selected value or `<default>` |
| `config.load.details["model provider"]` | Same as above | Usually `openai` |
| `config.load.details["enabled feature flags"]` | Same as above | List of enabled feature flags |

**Caution about the actual JSON shape** (found by phase-16's A-2 blocker):
0.144.1 doctor `--json` returns `checks` as a “flat element-key dictionary,”
whose element keys are literal dotted strings such as `"auth.credentials"`.
Thus access through
`report.checks["auth.credentials"].details["stored auth mode"]` is correct;
traversing it as the nested path `report.checks.auth.credentials.details[...]`
always produces undefined. Test fixtures must also match this actual shape
(a Potemkin fixture cannot detect real-data breakage; see the implementation in
[runner/src/codex-auth.ts](../../runner/src/codex-auth.ts)).

**Information not returned** (the main reason F4bc's decision remains):

- The **plan tier** of Master (this account) (Plus / Pro / Business / etc.)
- The **account-default model name** (one of Sol / Terra / Luna / Astra)
- The **entitled-model set** (the slugs that do not return 400/404 for this account)

kaoiro can parse `codex doctor --json` through to authentication-mode
identification, but beyond that relies on operator input or waiting for the
upstream SDK to expose the information.

## Implications for kaoiro

- **Former implementation (ADR-0032 F4bc, 2026-07-11 e89fa98 in private
  Gitea history, superseded by ADR-0035 in phase-16)**: LaunchDialog had no
  model select, the wrapper sent no `model`, and `codex exec` resolved through
  `~/.codex/config.toml` then the plan default. AgentDetail displayed
  “account default (not selectable).”
- **Current implementation (ADR-0035, phase-16, host verified 2026-07-13)**:
  When the operator declares `codex.chatgpt_plan` in `runner.config.json`, the
  catalog resolver (`@kaoiro/codex/catalog.ts`) returns `EngineModelInfo[]`
  from auth mode + plan and advertises `ext.models[]` through
  runner→wrapper→server→dashboard. Model / effort selects return to
  LaunchDialog, and mid-session switches from AgentDetail are accepted through
  `set_model` / `set_effort`. Details: [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md)
  and [phase-16](../plans/phase-16-codex-model-switch.md).
- **The entitlement-determination asymmetry remains**: The catalog relies on
  the operator declaration; it can be reconsidered when the SDK gains an
  enumeration API.
- **The authentication mode can also be declared explicitly (phase-24)**:
  Write `codex.auth_mode` (`"chatgpt"` / `"apikey"`) in `runner.config.json`
  to resolve it with priority **explicit declaration > `codex doctor` detection
  > `"unknown"`**, skipping doctor detection itself. This addresses a regression
  where the catalog became empty when the runner PATH lacked a codex binary.
  The declaration is metadata only for catalog selection; the runner neither
  supplies nor changes credentials. A mistaken declaration misaligns catalog
  and actual entitlement, so an explicit request for an unsupported model /
  effort fails loudly with 400/404 and falls into existing `switch_error`
  rollback. There is no implicit inference from `chatgpt_plan`.
- **Switch execution model**: A switch preserves the current turn and applies
  from the next turn ([ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md)
  F1). An invalid slug fails loudly with 400/404 at turn start and rolls back
  to the previous pinned model without a silent fallback ([ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md)
  F3; adapter implementation: [wrapper/codex/src/host.ts](../../wrapper/codex/src/host.ts)).
- **Role of directly editing `~/.codex/config.toml`**: It remains useful for
  CLI/Desktop operation outside kaoiro and for kaoiro-unsupported slugs (such
  as the Pro-only `gpt-5.3-codex-spark`). At CLI priority 4, it is lower than a
  spawn through kaoiro and does not conflict with an operator's explicit
  selection.

## Primary-information references

- Official OpenAI:
  [Codex Pricing](https://chatgpt.com/codex/pricing/) /
  [ChatGPT Learn — Models](https://learn.chatgpt.com/docs/models) /
  [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic) /
  [Codex Settings (OpenAI Academy)](https://openai.com/academy/codex-settings/) /
  [Codex changelog](https://developers.openai.com/codex/changelog)
- OpenAI Help Center:
  [Using Codex with your ChatGPT plan (article 11369540)](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) /
  [GPT-5.6 in ChatGPT (article 20001325)](https://help.openai.com/en/articles/20001325-a-preview-of-gpt-56-sol-terra-and-luna)
- Live observations (400/404 behavior):
  [openai/codex#14266 (gpt-5.4 rejection period)](https://github.com/openai/codex/issues/14266) /
  [#19654 (gpt-5.5 unsupported)](https://github.com/openai/codex/issues/19654) /
  [#26892 (gpt-5.5 404 while gpt-5.4 works)](https://github.com/openai/codex/issues/26892)
- Local verification: `codex doctor --json --no-color` (Codex CLI 0.144.1,
  run 2026-07-11)
