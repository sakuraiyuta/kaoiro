---
title: Codex model catalog evidence
status: accepted
last_updated: 2026-10-01
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

## Codex catalog snapshot (2026-10-01)

The source is
[`codex-rs/models-manager/models.json`](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json).
The issue's 2026-09-30 03:54:09 UTC retrieval and an independent re-fetch at
2026-10-01 00:08:06 UTC had the same SHA-256:
`fd219bd9f061278275f528939f82f54d2eb97df4b25c23b022adbe48813d920b`.
This preserves the earlier dated table above; it does not rewrite that
historical snapshot.

| Slug | Priority | Minimum CLI | Default effort | Default service tier | Upstream description |
|---|---:|---:|---|---|---|
| `gpt-6.1-sol` | 1 | 0.153.0 | low | none | Latest workhorse model for coding and everyday work. |
| `gpt-6-astra` | 2 | 0.153.0 | low | none | Frontier intelligence for the most demanding work. |
| `gpt-6-sol` | 3 | 0.155.0 | medium | priority | Previous generation workhorse model. |
| `gpt-6-luna` | 4 | 0.155.0 | medium | priority | Fast and affordable model for easier tasks. |
| `gpt-5.6-sol` | 5 | 0.144.0 | low | none | Older generation workhorse model. |
| `gpt-5.6-terra` | 8 | 0.144.0 | medium | none | Older balanced model for straightforward work. |
| `gpt-5.6-luna` | 9 | 0.144.0 | medium | none | Older fast and efficient model. |

All seven rows support the reasoning levels `low`, `medium`, `high`,
`xhigh`, and `max`; `ultra` is supported except by `gpt-6-luna` and
`gpt-5.6-luna`.

The source's `available_in_plans` values include Free and Go for the GPT-6
rows, including Sol 6.1. Those upstream declarations do not establish actual
account entitlement. For `promax`, the source lists `gpt-6.1-sol`,
`gpt-6-astra`, and the GPT-5.6 rows, but omits `gpt-6-sol` and `gpt-6-luna`.
kaoiro currently applies one catalog to every paid plan ID, so this source
metadata difference does not alter the advertised catalog. kaoiro advertises
the GPT-6 models only for Plus and above and advertises only Terra for Free/Go.
The source contains `prolite` and `promax` IDs but does not establish that the
marketed “Pro 500” plan maps to `promax`; that correspondence remains unknown.

The existing API-key `gpt-5.4-mini` catalog row was retained. This change
confirms row inclusion only; it did not synchronize that model's metadata.

The scratch home was confirmed logged in through Codex CLI 0.156.1. Two real
`gpt-6-sol` exec-backend turn requests each timed out after 120 seconds without
a result or rollout. No service tier was observed. Server acceptance, the
unknown-slug 400/404 response, switch rollback, the next-turn model, and
service-tier measurements for either model on either backend remain unverified;
the live portion of the issue remains open. No production Codex home or live
peer model was used for these attempts.

Probe record (2026-10-01, Asia/Tokyo): a temporary `runCodexCli` loopback
harness was used and removed afterward. No raw log was retained; this section
is the report-based record of the attempts.

## Migration links

- [Catalog contract](../../reference/engines/codex-model-catalog.md)
- [Model-change procedures](../../operations/codex-model-settings.md)

## Recorded live probe (2026-10-01)

This section records the follow-up probe using the scratch home
`/home/yuta/.local/share/kaoiro-scratch/codex-461`. The older report above
remains the history of the earlier unrecorded timeouts. The follow-up used the
Codex CLI 0.156.1 binary whose SHA-256 is
`0b2e9301d6100dddda3b9d5c80ebaeaa3a2f1962388f2f36f6b96a9f08b1f33f`.
Every model call below used that binary and the scratch home for both `HOME`
and `CODEX_HOME`; the guarded launcher rejected mismatched homes and binaries.
The probe harness unset `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`,
and `OPENAI_ORG_ID`. No authentication file contents were read or recorded.
Logs listed below contain sanitized startup/backend metadata and no credentials.

### Observations

Times are UTC. Rollout paths are relative to the scratch `CODEX_HOME`.
The app-server backend kept one child process alive across its four turns; that
process exited 0 after the sequence with 0 stderr bytes.

| Backend / model | Observed result | Rollout |
|---|---|---|
| Direct CLI exec / `gpt-6-sol` | Invocation submitted at 02:39:16.844; first event `thread.started` at 02:39:17.841 and `turn.started` at 02:39:17.918. Process exit 0, no signal, no timeout; stderr was `Reading additional input from stdin...` (39 bytes). No `service_tier` field appeared in the JSON events or rollout. | `sessions/2026/10/01/rollout-2026-10-01T11-39-17-01a0f554-9b39-7600-bb8f-cf93df5314db.jsonl` |
| `runCodexCli` exec / `gpt-6-sol` | Instruction sent at 02:59:45.723; first event `thread.started` at 02:59:46.969 and `turn.started` at 02:59:47.043. Child exit 0; stderr was `Reading prompt from stdin...` (29 bytes). No `service_tier` field appeared in backend events or rollout. | `sessions/2026/10/01/rollout-2026-10-01T11-59-46-01a0f567-5b19-77d3-a0d6-f3ef02e10afc.jsonl` |
| `runCodexCli` exec / `gpt-6.1-sol` | The CLI emitted `thread.started` at 02:59:50.520 and `turn.started` at 02:59:50.541. The request then failed with HTTP 400: the model is not supported with a ChatGPT account. Child exit 1. `switch_error.rolled_back_to` was `gpt-6-sol`; the following turn used `gpt-6-sol` and completed with child exit 0. The unknown slug `gpt-9-nova` also returned HTTP 400, rolled back to `gpt-6-sol`, and the next turn remained on `gpt-6-sol`. No `service_tier` field appeared in backend events or rollout. | Same exec rollout as above |
| `runCodexCli` app-server / `gpt-6-sol` | `turn/start` was accepted at 03:02:55.102; `turn/started` arrived at 03:02:55.122 and the turn completed at 03:02:57.149. The shared app-server child exited 0 after the four-turn sequence with stderr 0 bytes. No `service_tier` field appeared in backend events or rollout. | `sessions/2026/10/01/rollout-2026-10-01T12-02-54-01a0f56a-380d-7791-8b3f-dca6234192bd.jsonl` |
| `runCodexCli` app-server / `gpt-6.1-sol` | `turn/start` was accepted at 03:02:57.841 and `turn/started` arrived at 03:02:57.861. The request then failed with HTTP 400: the model is not supported with a ChatGPT account. `switch_error.rolled_back_to` was `gpt-6-sol`. The following `gpt-6-sol` turn was accepted at 03:03:00.138, started at 03:03:00.142, and completed at 03:03:03.666. No `service_tier` field appeared in backend events or rollout. | Same app-server rollout as above |
| `runCodexCli` app-server / unknown slug `gpt-9-nova` | `turn/start` was accepted at 03:02:58.836 and `turn/started` arrived at 03:02:58.840. It failed with HTTP 400, rolled back to `gpt-6-sol`, and the next turn remained on `gpt-6-sol`. No `service_tier` field appeared in backend events or rollout. | Same app-server rollout as above |

The successful `gpt-6-sol` cells show that the earlier 120-second timeout did
not reproduce in the later direct CLI call or `runCodexCli` exec call. This does
not identify the cause of the earlier timeout. On this scratch ChatGPT-auth
account, `gpt-6.1-sol` was rejected by the upstream request on both backends
after the local turn had started; this observation does not establish that the
model is unavailable to other accounts. The backend accepted the app-server
`turn/start` request, but the model request itself failed. `service_tier` was
absent from the observed events and rollouts for all measured model cells, so
no tier comparison was possible. The live behavior remains account-dependent
and the issue remains open pending a suitable entitlement or upstream change.

The first exec harness variant changed child output streams to strings; on
failed turns this triggered a `Buffer.concat` type error in the observer's
error-collection path. The recorded raw backend events still contained the HTTP
400 and rollback, but error detail from that observer path is not treated as
independent evidence. The app-server run used a corrected observer that kept
stream chunks as buffers. An earlier local-harness attempt did not send the
required permission-sync event, timed out before launching a Codex model child,
and is retained in `attempt0-no-permission-sync/`; it is not counted as a
backend model result.

Turn accounting for the authorized 12-attempt budget: 12/12 counted
conservatively (two earlier 120-second attempts, one direct CLI call, one
pre-backend harness send, four exec-harness attempts, and four app-server
attempts). No authentication error occurred. No additional model call was made
after the budget was exhausted.

Boundary note: before these guarded probe runs, `codex login status` was
accidentally invoked once with the inherited production `CODEX_HOME`; it did
not invoke a model. The operator reported that a separate inspection found no
state migration (the migration count remained 55), no change to the
`auth.json` timestamp, and only temporary `tmp/arg0` entries. I did not inspect
the contents of `auth.json`. All model calls recorded in this section were
pinned to the scratch home.

### Recorded artifact hashes

SHA-256 values bind the redacted logs, their rollout records, and the pinned
probe executables used above. All paths are under
`/home/yuta/.local/share/kaoiro-scratch/codex-461/probe-20261001/` unless
noted otherwise.

| Artifact | SHA-256 |
|---|---|
| `direct-exec-gpt-6-sol.summary.log` | `2fccd7bd904ed8a7f047ec9696d9c0812c7a1749543ff5c35c09573746cd6089` |
| `direct-exec-gpt-6-sol.events.jsonl` | `106d293fea48cf9d19c25e4103a05c369edd68c243976ead010e33d773b72c6b` |
| `direct-exec-gpt-6-sol.stderr.log` | `1aa26269eb1cc57f86b235a03cda53c004edb5b1e9fc99d4da4f00843293d721` |
| `harness-exec-20261001.summary.log` | `8eb5fa1293cd2352fa3f26348bfd9fb9188002a00684bbeaef427ddf7a87b97e` |
| `harness-exec-20261001.turns.jsonl` | `4af8ae70b133914b1390e9a4eec35cc3a1e6a0f5ddb07511e2f749dff3d7153a` |
| `harness-exec-20261001.backend-events.jsonl` | `874e3baf7b9eb4d0920219c9ee8c15cba3dfb434594c6d0eed4beaded42fdb2d` |
| `harness-exec-20261001.children.jsonl` | `01d0920450c5320d15490eebd0b0320ab9e98c0d5901cda8695cccbf9691be9b` |
| `harness-exec-20261001.wrapper-stderr.log` | `10a60aa4e650563715e1cabc978e113d218ec3d16dcd2a71c7de29f50d57239a` |
| `harness-exec-20261001.wrapper-stdout.log` | `8f5098d31a04a11c746b68c764f69aaa6eb70a5fcbd47efd68ca073389006f50` |
| `harness-exec-20261001.child-2.stderr.log` through `child-5.stderr.log` (each) | `3e75d28a6681c31400a3f0fcb564c7613fd42796fb83294e4d53fea86bcbd401` |
| `harness-app-server-20261001.summary.log` | `a1afff9cc2e437b1ece4e200377a18527d750b0b9f2263305c7019873b64af15` |
| `harness-app-server-20261001.turns.jsonl` | `30d88c03ea6ecd1861ef9426c9d235a66b87d86f4ac0ef0652a21e398c04c943` |
| `harness-app-server-20261001.backend-events.jsonl` | `4d89c5bcfebd17526f1aaee0fc70bf1d5ab33c524d9dddcf64e0fe27d3bd7ddc` |
| `harness-app-server-20261001.children.jsonl` | `a5af64bcfe4c1db5fca5f261ae61ec45a9b08ea93b06e929434520bf4016eff7` |
| `harness-app-server-20261001.wrapper-stderr.log` | `79c7e18f87d5de54c09a3c0362defb3ef892c646c3de61bf10c3848d29354a68` |
| `harness-app-server-20261001.wrapper-stdout.log` | `7d31cf6f607be6f34f4e075178c468e6cd2764ed44852e3a60885f94accf516a` |
| `attempt0-no-permission-sync/harness-exec-20261001.summary.log` | `9685bd5691b1001ed82d2d9f9fa6424694d99edfcc8651ec26f42181966dd665` |
| `attempt0-no-permission-sync/harness-exec-20261001.turns.jsonl` | `25c48d706d73f00cadbe2eac52dcb76e81e38e4b16758d20ccee3f888b7ebbc8` |
| `attempt0-no-permission-sync/harness-exec-20261001.backend-events.jsonl` | `751bf02bbcae3a0f7149368d239850ec2788a00739c763a9ef976a87930b9039` |
| `direct-exec-probe.mjs` | `f75a47c7eccd4f392930f9ac20a8115dc5be2063fc773de0bdd7ac3aaf8f3755` |
| `run-codex-cli-harness.mjs` | `5486ed6c6dc74b876437b5b4eb92d15ab303add1c9a38cacdc450bb1db50d862` |
| `guarded-codex` | `dbef4d5b21512376b20445b1ae9d0c997262ab5348b530178a3d9e6e75e29786` |
| Codex CLI 0.156.1 binary (worktree package path) | `0b2e9301d6100dddda3b9d5c80ebaeaa3a2f1962388f2f36f6b96a9f08b1f33f` |

The three rollout JSONL files above have SHA-256 values, in direct/exec/app-server
order: `b44b4479578887c0c497f370af7ecced64ea0374b1123c280606612e95bae871`,
`47fb63012ddda5bf699f30d69924dbb64fd3756828d17a91b6812029897c4838`, and
`6d65e0d77c9f421991029222c04a82b619ee8c599fadeb229c57c0626fe0d951`.
