---
title: Codex model catalog reference
status: accepted
last_updated: 2026-09-23
related: [codex-exec-events, protocol, plugin-model]
---
<!-- markdownlint-disable MD033 -->

# Codex model catalog status and change paths

The historical plan table, authentication asymmetry, doctor output, and
primary sources are in [the catalog evidence](../../evidence/codex/model-catalog.md).
For model-change procedures, see [Codex model settings](../../operations/codex-model-settings.md).

## Advertised catalog

[The plan table](../../evidence/codex/model-catalog.md#plan--available-model-2026-07-11-astra-column-added-2026-09-05-sol6luna6-columns-added-2026-09-23) is an **upstream availability snapshot**, not kaoiro's advertised
catalog. The current kaoiro snapshot advertises Astra / Sol6 / Luna6 / Sol /
Terra / Luna for ChatGPT Plus and above, Terra for Free/Go, and additionally
only `gpt-5.5` and `gpt-5.4-mini` for API-key authentication. It deliberately
does not advertise `gpt-5.3-codex-spark` or non-mini `gpt-5.4`; an operator
can still declare an unadvertised model through `codex.extra_models`.

`gpt-6-astra`, `gpt-6-sol` and `gpt-6-luna` are marked `visibility: list`
upstream. Their `models.json` plan lists also name Free/Go, but that
combination is unverified against the live Free/Go experience — kaoiro's own
catalog (`wrapper/codex/src/catalog.ts`) therefore only advertises them for
Plus and above, matching Sol/Terra/Luna's existing tiering (issue #292,
extended to Sol6/Luna6 by issue #399).

The advertised set is then filtered by the bundled Codex CLI version: an
entry whose `minimal_client_version` is newer is not offered.

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
  from the next turn ([ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md)
  F1). An invalid slug fails loudly with 400/404 at turn start and rolls back
  to the previous pinned model without a silent fallback ([ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md)
  F3; adapter implementation: [wrapper/codex/src/host.ts](../../../wrapper/codex/src/host.ts)).
- **Role of directly editing `~/.codex/config.toml`**: It remains useful for
  CLI/Desktop operation outside kaoiro and for kaoiro-unsupported slugs (such
  as the Pro-only `gpt-5.3-codex-spark`). At CLI priority 4, it is lower than a
  spawn through kaoiro and does not conflict with an operator's explicit
  selection.


## Migration links

- [Exec event contract](codex-exec-events.md)
