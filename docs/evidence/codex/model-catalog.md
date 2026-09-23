---
title: Codex model catalog evidence
status: accepted
last_updated: 2026-09-23
---
<!-- markdownlint-disable MD033 -->

# Codex model catalog evidence

This page preserves the dated record from the pre-migration specification.
The stated versions, dates, observations, and limits have not been re-measured
by the documentation move.

## Purpose

[ADR-0032](../../adr/0032-codex-adapter.md) F4bc chose an empty catalog for the
Codex adapter's `supportedModels()` and delegated model selection to the
account default. The **current Codex-ecosystem information supporting that
decision** (model availability by plan / authentication-mode asymmetry / change
paths / whether SDK enumeration is possible) does not fit in the ADR itself, so
it is separated into this specification.

**phase-16 update (2026-07-13)**: The decision in
[ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md) restored
the catalog. Even under ChatGPT-account authentication, the **operator declares
`codex.chatgpt_plan` in `runner.config.json`** to statically resolve the
entitled-model set. It presents the Astra / Sol6 / Luna6 / Sol / Terra / Luna
catalog in LaunchDialog for Plus and above, and accepts mid-session switching (details:
[ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md) and
[phase-16](../../plans/phase-16-codex-model-switch.md)). This specification
remains a primary-information reference for why it depends on an operator
declaration rather than wait for an enumeration API.

**Status: accepted** — based on verbatim quotations from primary information
(official OpenAI documentation / Help Center / running `codex doctor`). However,
the entitled-model set has changed in OpenAI operations (for example,
`gpt-5.5` temporarily returned 404 then recovered as of 2026-07;
[openai/codex#26892](https://github.com/openai/codex/issues/26892), and
`gpt-6-astra` was added 2026-09 per a re-fetch of
`codex-rs/models-manager/models.json`; issue #292), so this specification's
table is a snapshot as of 2026-09-23 for the Sol6/Luna6 rows and the refreshed
description strings, 2026-09-05 for the rest of the Astra row, and 2026-07-11
for everything else. `gpt-6-sol` and `gpt-6-luna` were added 2026-09-23 per
another re-fetch of the same upstream file (issue #399); that re-fetch also
showed `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna`/`gpt-5.5`/`gpt-6-astra`'s
own descriptions had drifted from the earlier snapshot (upstream now describes
them as superseded by the GPT-6 generation), which `wrapper/codex/src/catalog.ts`
was updated to match.

## Plan × available model (2026-07-11, Astra column added 2026-09-05, Sol6/Luna6 columns added 2026-09-23)

| Plan | Monthly price | Codex-available models | Codex default | Notes |
|---|---|---|---|---|
| Free | $0 | `gpt-5.6-terra` only | Terra | Sol / Luna / Astra / Sol6 / Luna6 cannot be selected |
| Go | $8 | `gpt-5.6-terra` only | Terra | Tier introduced in 2026-04 |
| Plus | $20 | Sol / Terra / Luna / Astra / Sol6 / Luna6 (effort selectable) | **5.6-Sol + medium** | Switchable in CLI/Desktop |
| Pro | $100 or $200 | Sol / Terra / Luna / Astra / Sol6 / Luna6 + `gpt-5.3-codex-spark` | **5.6-Sol + medium** | The $200 version has a 20× five-hour window |
| Business | $25/user | Sol / Terra / Luna / Astra / Sol6 / Luna6 | **5.6-Sol + medium** | Replaced former Team ($30) in 2026-04 |
| Enterprise | custom | Sol / Terra / Luna / Astra / Sol6 / Luna6 (+ individual negotiation) | **5.6-Sol + medium** | Admin can change the default |
| API-key | Usage based | Sol / Terra / Luna / Astra / Sol6 / Luna6 / 5.5 / 5.4 / 5.4-mini + some deprecated models | **Explicit selection required** | No 400/404 restriction |

`gpt-6-sol` and `gpt-6-luna` (like Astra) list free/go among upstream
`models.json`'s `available_in_plans`, but that combination is unverified
against the live Free/Go experience -- kaoiro's own catalog only advertises
them for Plus and above, same as Sol/Terra/Luna/Astra's existing tiering
(issue #399).

The distinction from kaoiro's advertised catalog and its version filter are in
[the model catalog reference](../../reference/engines/codex-model-catalog.md#advertised-catalog).

**Model slugs** (identifiers used by `--model` / `~/.codex/config.toml` /
`-c model=`):
`gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-6-astra` / `gpt-6-sol` /
`gpt-6-luna` / `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex-spark`.

**Reference API pricing** (per 1M tokens): Sol $5 input / $30 output,
Terra $2.50 / $15, Luna $1 / $6, Astra $10 / $50
([official pricing page](https://developers.openai.com/api/docs/models/gpt-6-astra),
2026-09-05), Sol6 $2 / $10
([official pricing page](https://developers.openai.com/api/docs/models/gpt-6-sol),
2026-09-23), Luna6 $0.1 / $0.5
([official pricing page](https://developers.openai.com/api/docs/models/gpt-6-luna),
2026-09-23).

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
[runner/src/codex-auth.ts](../../../runner/src/codex-auth.ts)).

**Information not returned** (the main reason F4bc's decision remains):

- The **plan tier** of Master (this account) (Plus / Pro / Business / etc.)
- The **account-default model name** (one of Astra / Sol6 / Luna6 / Sol / Terra / Luna)
- The **entitled-model set** (the slugs that do not return 400/404 for this account)

kaoiro can parse `codex doctor --json` through to authentication-mode
identification, but beyond that relies on operator input or waiting for the
upstream SDK to expose the information.

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

## Migration links

- [Catalog contract](../../reference/engines/codex-model-catalog.md)
- [Model-change procedures](../../operations/codex-model-settings.md)
