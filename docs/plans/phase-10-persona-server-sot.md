---
title: Phase 10 — Server-Centralized Persona SoT + Zip-Pack Distribution
description: Make persona data the server-centralized SoT, distribute it as zip packs, apply updates automatically with auto-watch, and prevent rogue personas (ADR-0029). Migrating the four existing personas (ao/kuroe/momo/fuji) to packs is also included in this phase.
status: done
phase: 10
depends_on: [phase-4-host-runner]
last_updated: 2026-07-06
---

# Phase 10 — Server-Centralized Persona SoT + Zip-Pack Distribution

Implementation phase for the “server-centralized persona distribution model”
decided in [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md).
Completely replace the distributed model (wrapper-side md + server-side PNG +
runner-side allowlist) with the server-centralized model.

See ADR-0029 and [persona-pack-schema](../specs/persona-pack-schema.md) for the
policy and background. This plan lists the implementation tasks.

## Completion Criteria (Stage 0)

The completion criterion is **zero residue of the distributed model**. Partial
dual existence would break the SoT, so merging is allowed only once all of the
following are in place.

### Server side

- [x] Consolidate the ingestion directory specification via env (`KAOIRO_PERSONA_DIR` retained; fall back to `server/priv/persona-packs/` when unset)
- [x] Completely remove bundled `server/priv/personas/` (move the four existing personas to the ingestion directory as zips)
- [x] Zip extraction logic (at the time, idempotently extract into content-hashed `.cache/<hash>/` inside the ingestion directory). Currently moved to an extraction cache outside the persona dir by ADR-0046
- [x] Auto-watch + 300 ms debounce using the Elixir `file_system` library
- [x] Rebuild the manifest (scan the ingestion directory → aggregate all packs)
- [x] Zip validation (schema / 7 sprites / unique ids / min_kaoiro_version /
      reserve manifest.id "default")
- [x] Return `/api/personas` with the new schema (copy name / pack_version /
      description to each persona entry; do not return personality.md body through
      the API)
- [x] Extend the WS handshake: receive `join params.persona_id`, combine
      `personality + common footer` in `after_join`, and push `persona_prompt`
- [x] Reject wrapper connections claiming an unknown persona.id
      (`missing_persona_id` / `unknown_persona`)
- [x] Define the common footer (hard-code ADR-0029 D5's one sentence in
      PersonaAssets)

### Wrapper side

- [x] Remove local md loading (delete `wrapper/personas/*.md`, and remove
      `resolvePersonaAppend` / `COMMON_FOOTER`)
- [x] Path to inject the prompt received in the WS handshake into the SDK
      (`onPersonaPrompt` → Promise → `host.run()`)
- [x] Fail closed when the server cannot be reached (spawn failure, explicit
      error after a 10-second timeout)
- [x] Remove `personality_prompt_file` / `language` fields from the `Persona` type
      (protocol Persona downgraded to a type alias of WirePersona)
- [x] Make `server_url` required (remove local-only mode)

### Runner side

- [x] Retain `personas[]` in `runner.config.json` as the “per-host restriction”
      allowlist (do not deprecate it)
- [x] Check consistency with the server manifest — call `GET /api/personas` 3 s
      after startup and `console.warn` if an id is in the allowlist but unknown
      to the server (allow spawn; warning only)

### Author workflow

- [x] Set up the `persona-packs/<id>/` working tree at the kaoiro repository top
      level (`manifest.json` + `personality.md` + `sprites/`)
- [x] `scripts/build-persona-pack.sh` build script (bash + jq + zip; working tree
      → zip → validation)
- [x] Move the four existing personas (ao / kuroe / momo / fuji) to
      `persona-packs/` (license: CC-BY-4.0, version: 1.0.0,
      min_kaoiro_version: 0.1.0)
- [x] Build and zip the four personas and place them in the ingestion directory
      (`server/priv/persona-packs/`)
- [x] Completely remove the old locations (`wrapper/personas/*.md`,
      `server/priv/personas/{ao,kuroe,
      momo,fuji}/`)

### Docs side

- [x] Update the status of the new spec [persona-pack-schema](../specs/persona-pack-schema.md)
      from `provisional` → `accepted`
- [x] Update [personas](../specs/personas.md) to “creation = zip workflow”
      (completed before starting this phase)
- [x] Update [persona-personality-injection](../specs/persona-personality-injection.md)
      to the new model (completed before starting this phase)
- [x] Remove `personality_prompt_file` / `language` from the wrapper config
      section of [setup-wizards](../specs/setup-wizards.md) (completed before
      starting this phase)
- [x] Add the persona-prompt push message and reject specification to
      [protocol](../specs/protocol.md) (completed before starting this phase)

### Dev procedure

- [x] Expand the `scripts/dev.sh` runner config default to include all four
      personas, including fuji (automatically applied by server auto-watch)
- [x] Starting the wrapper alone is rejected at the config stage because
      `server_url` is required (local-only branch removed)

## Out of Scope (handled from Stage 1 onward)

The following are not handled in this phase. They are tied to ADR-0029's
Follow-ups.

- **Hot-swap**: Push live updates to connected wrappers
- **Concurrent update refinement**: Handling zips while they are being written
- **Watch-debounce tuning**: Load characteristics when dropping many zips
- **Hash / signature verification**: Pack integrity / provenance verification
- **Schema strict API versioning**: API v1/v2 branching
- **Multi-host sync**: Zip synchronization when operating multiple servers

## Risks and Rollback

- **Risk**: fail-closed makes “starting the wrapper alone” impossible in the dev
  flow. Existing dogfooding procedures and scripts need review.
- **Risk**: During migration of the four existing personas, details may diverge
  between the pack's personality.md and the old md, causing response-tone drift.
  Include a step to visually check the diff during migration.
- **Rollback**: Before zero residue of the distributed model is achieved (during
  migration), treat ADR-0029's supersession as provisional and keep the old
  ADR-0008 / ADR-0026 valid in parallel. After merging (once Stage 0 is complete),
  it is irreversible.

## See Also

- ADR: [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
- Specs: [persona-pack-schema](../specs/persona-pack-schema.md),
  [personas](../specs/personas.md),
  [persona-personality-injection](../specs/persona-personality-injection.md),
  [setup-wizards](../specs/setup-wizards.md),
  [protocol](../specs/protocol.md)
- Superseded ADRs: [ADR-0008](../adr/0008-persona-asset-distribution.md),
  [ADR-0026](../adr/0026-persona-personality-injection.md)
