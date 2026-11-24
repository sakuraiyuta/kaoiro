---
title: Codex model catalog reference
status: accepted
last_updated: 2026-11-24
related: [codex-exec-events, protocol, plugin-model]
---
<!-- markdownlint-disable MD033 -->

# Codex model catalog status and change paths

The historical plan table, authentication asymmetry, doctor output, and
primary sources are in [the catalog evidence](../../evidence/codex/model-catalog.md).
For model-change procedures, see [Codex model settings](../../operations/codex-model-settings.md).

## Advertised catalog

[The plan table](../../evidence/codex/model-catalog.md#plan--available-model-2026-07-11-astra-column-added-2026-09-05-sol6luna6-columns-added-2026-09-23) is an **upstream availability snapshot**, not kaoiro's advertised
catalog. The current kaoiro snapshot advertises Sol6.2 / Astra6.2 / Sol6.1 / Astra / Terra6.1 / Sol6 /
Luna6 / Sol5.6 / Terra5.6 / Luna5.6 for ChatGPT Plus and above, Terra5.6 for
Free/Go, and additionally
only `gpt-5.5` and `gpt-5.4-mini` for API-key authentication. It deliberately
does not advertise `gpt-5.3-codex-spark` or non-mini `gpt-5.4`; an operator
can still declare an unadvertised model through `codex.extra_models`.

The current upstream `models.json` lists `gpt-6.1-sol`, `gpt-6-astra`,
`gpt-6-sol` and `gpt-6-luna` in `available_in_plans` for Free and Go. These
values are upstream metadata, not proof of live entitlement. kaoiro's catalog
(`wrapper/codex/src/catalog.ts`) advertises these GPT-6 models only for Plus
and above, and only `gpt-5.6-terra` for Free/Go. The dated source record and
the distinction between those two policies are in
[the 2026-10-01 evidence addendum](../../evidence/codex/model-catalog.md#codex-catalog-snapshot-2026-10-01).

The plan parser recognizes `prolite` and `promax` as upstream plan IDs. The
mapping from the marketed “Pro 500” plan to either ID remains unknown; kaoiro
does not infer that mapping. `gpt-5.4-mini` remains in the API-key catalog;
this update only confirms that its existing row is retained and does not
resynchronize its metadata.

The advertised set is then filtered by the bundled Codex CLI version: an
entry whose `minimal_client_version` is newer is not offered.

`gpt-6.1-terra` comes from the signed-in remote catalog rather than bundled
`models.json`. It supports `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`,
with default effort `low`. Its `minimal_client_version=0.161.0` is kaoiro's
verified floor, not an upstream minimum. The
existing shared paid catalog also includes it for API-key authentication;
actual entitlement remains account-dependent. See the
[dated Terra evidence](../../evidence/codex/model-catalog.md#signed-in-remote-catalog-2026-10-27).

## Bundled 0.170.0 baseline

The CLI and SDK are pinned together at 0.170.0. The two new GPT-6.2 entries
come from the signed-in remote catalog and support low through ultra effort,
with low as the default. The remote did not declare a minimum client version;
0.170.0 is the measured floor, while 0.165.0–0.169.x were not tested. Free/Go
retain their existing catalog. Catalog inclusion does not establish entitlement
for every account. See the [dated adoption evidence](../../evidence/codex-app-server/pin-0.170.0-adoption-gates-2026-11-19.md).

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
  `set_model` / `set_effort`. Details: [ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md)
  and [phase-16](../../plans/phase-16-codex-model-switch.md).
- **The entitlement-determination asymmetry remains**: The catalog relies on
  the operator declaration; it can be reconsidered when the SDK gains an
  enumeration API.
- **Explicit authentication mode declaration (issue #1214)**:
  The runner does not run `codex doctor`. Declare `codex.auth_mode`
  (`"apikey"`, or `"chatgpt"` with `codex.chatgpt_plan`) in
  `runner.config.json` to advertise the standard catalog; when omitted, the
  runner resolves `"unknown"` with a guidance warning (standard catalog is
  empty; explicit `codex.extra_models` remain). See
  [Runner configuration](../configuration/runner.md#codex-configuration) for
  the authoritative rules.
- **Switch execution model**: A switch preserves the current turn and applies
  from the next turn ([ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md)
  F1). An invalid slug fails loudly with 400/404 at turn start and rolls back
  to the previous pinned model without a silent fallback ([ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md)
  F3; adapter implementation: [wrapper/codex/src/host.ts](../../../wrapper/codex/src/host.ts)).
- **Role of directly editing `~/.codex/config.toml`**: It remains useful for
  CLI/Desktop operation outside kaoiro and for kaoiro-unsupported slugs (such
  as the Pro-only `gpt-5.3-codex-spark`). At CLI priority 4, it is lower than a
  spawn through kaoiro and does not conflict with an operator's explicit
  selection.
