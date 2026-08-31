---
title: Server-aggregated persona SoT, distributed as zip packs and applied with auto-watch
status: accepted
date: 2026-07-05
opened: 2026-07-05
supersedes: [8, 26]
superseded_by: null
related_specs: [personas, persona-pack-schema, persona-personality-injection, setup-wizards, protocol, threat-model]
related_adrs: [2, 3, 8, 24, 26, 31, 44, 45, 46]
---

# ADR-0029 — Server-Aggregated Persona SoT, Distributed as Zip Packs and Applied with Auto-Watch

## Status

Accepted. Supersedes both [ADR-0008](0008-persona-asset-distribution.md) (asset distribution) and [ADR-0026](0026-persona-personality-injection.md) (personality-prompt injection).

## Context

Persona-related data is currently distributed across three layers:

- `wrapper/personas/<id>.md` — personality prompt (the wrapper loads it itself, [ADR-0026](0026-persona-personality-injection.md))
- `server/priv/personas/<id>/*.png` — persona sprites (the server delivers them through `/api/personas`, [ADR-0008](0008-persona-asset-distribution.md))
- `personas[]` in `runner/runner.config.json` — allow-list of spawnable ids

This distribution creates three practical problems:

1. **Friction from creation → distribution → operation**: every time one persona is added, the wrapper repo, server repo, and runner config must be aligned by hand. When the fuji persona was added (2026-07-05), `runner.config.json`’s personas array was forgotten, so it did not appear in the startup dialog.
2. **No SoT**: it is unclear which is the “source of truth.” Editing the md has no effect if the server / runner do not know about it. Even when an administrator wants to control spawn, multiple layers must be handled.
3. **Cannot prevent rogue personas**: start a wrapper locally with an arbitrary `persona.id`, and the server accepts it as-is and only falls back for the image. A persona unknown to the administrator can appear in the wild.

Resolving all three at once requires **aggregating persona data on the server as the sole SoT**, with a mechanism where the creator distributes one unit (a zip pack) and the administrator activates it simply by placing it in a designated directory.

Against the server’s design principle of “delivering data straightforwardly” (the ADR-0003 family, threat-model), this is an exception allowing limited composition: delivery of the personality prompt (text) and composition of the common footer. Prioritise the SoT rather than leaving the missing SoT in place to preserve pure static delivery.

## Decision

### F1: Internal schema of a persona pack (zip)

The zip has the subdirectory structure `manifest.json` + `personality.md` + `sprites/<state>.png`.

```text
<pack-name>.zip
├── manifest.json         # id / name / sprite_set / version / license /
│                          #  min_kaoiro_version / states[] / …
├── personality.md        # 人格プロンプト本文
└── sprites/
    ├── idle.png
    ├── thinking.png
    ├── tool_running.png
    ├── waiting_input.png
    ├── waiting_permission.png
    ├── done.png
    └── error.png
```

The detailed schema is separated into [persona-pack-schema](../specs/persona-pack-schema.md).

### F2: Integrate the ingestion directory with env

Integrate the current overlay mechanism (prioritise an external directory through env `KAOIRO_PERSONA_DIR`) with the zip ingestion destination. **The ingestion directory specified by one env is the sole SoT**. Leave bundled `server/priv/personas/` empty (move the existing four personas into the ingestion directory as packs).

### F3: Wrapper spawn fails closed when the server is unreachable

If the personality prompt cannot be received from the server, wrapper spawn explicitly fails. Do not fall back to the default persona or retain a wrapper-side cache. The server is required even in dev/local (F10 below).

### F4: Zip verification is basic schema + completeness

On extracting a zip, the server verifies only:

- Presence and types of required fields in `manifest.json` (id/name/sprite_set/version/…)
- All seven state PNGs in `sprites/` (idle/thinking/tool_running/waiting_input/waiting_permission/done/error)
- Uniqueness of `manifest.id` (no collision with an already registered id)

Hash verification and creator signatures are future extensions (see Follow-ups below).

### F5: Compose the common footer on the server side

The final prompt passed to the wrapper is **`personality + common footer`, composed and delivered by the server**. The wrapper only injects the received string into the SDK as-is and has no composition logic. The common footer’s contents are fixed in this ADR’s D5 appendix (absorbing the old open question `persona-common-footer`).

**Revision by [ADR-0045](0045-footer-file-externalization.md) (accepted, implemented)**: compose `personality + system-footer + user-footer`. The footer text’s SoT is `system-footer.md` / `user-footer.md` directly under the footer installation directory (`KAOIRO_FOOTER_DIR`). Use the built-in default when unset, and do not add the user footer when unset. In all cases, the ownership in this section remains: “composition is the server’s responsibility; the wrapper injects the received string as-is.”

### F6: Auto-watch uses the Elixir FileSystem library

The physical location of the extraction cache was moved outside the persona directory by [ADR-0046](0046-persona-cache-relocation.md) (accepted).

Watch the ingestion directory event-driven with Elixir’s `FileSystem` library (an fs.notify wrapper abstracting Linux inotify / macOS FSEvents / Windows ReadDirectoryChangesW). Do not poll. Rebuild the manifest without a manual restart.

### F7: Schema versioning is semver + `min_kaoiro_version`

`manifest.version` is semver. Declare the minimum server version with `min_kaoiro_version` (reject ingestion below it). Start with a permissive operation, and consider strict API-version branching when it becomes necessary.

### F8: Zip / persona deletion means persona retirement (consistent with fail-closed)

When the zip equivalent disappears from the ingestion directory, remove it from the manifest and prohibit future spawn with that id. A connected wrapper fails closed at its next connection (do not treat it as archived, consistent with F3).

### F9: Concurrent updates to a connected wrapper apply only at the next connection

Updating a zip does not affect a connected wrapper (the prompt fixed in a connection-time snapshot remains fixed during the session). Hot-swap is a post-phase-1 extension.

### F10: Dev/local always assumes a minimal server

As a consequence of fail-closed, establish an operation where the server is also started in dev/local (auto-start through scripts/dev.sh, etc.). Read [ADR-0002](0002-local-wrapper-websocket-topology.md)’s “the wrapper works locally” as “local + local server.”

### F11: Work outside the wrapper; abolish `wrapper/personas/*.md` completely

Creators edit outside the wrapper repo (initial proposal: `persona-packs/<id>/{manifest.json,
personality.md, sprites/}`) and package it as a zip with a build script. Remove `wrapper/personas/*.md` completely, narrowing the wrapper’s responsibility to “running” it.

### D5 appendix: Provisional contents of the common footer

Adopt and fix in this ADR the provisional policy from the old open question `persona-common-footer` (option B = one sentence recognising the environment) as-is (the open question itself was merged into this ADR and `git rm`-ed):

- Contents: one sentence equivalent to “This agent is operated through the kaoiro client.”
- Composition order: `preset(claude_code) + personality + common footer` (personality above, footer below).
- Compose on the server side (F5). If dogfooding reveals a deficiency, extend it in a separate ADR.

**Current**: through the implementation of [ADR-0045](0045-footer-file-externalization.md), the text SoT moved to `system-footer.md` / `user-footer.md` directly under the footer installation directory (`KAOIRO_FOOTER_DIR`). D5’s provisional wording remains only as the built-in default content. An operator’s override takes effect by editing files alone, without changing the server implementation.

## Consequences

### Positive

- Persona SoT becomes singular (the ingestion directory), simplifying the creation → distribution → operation flow (one zip-drop step).
- “Rogue personas” naturally become impossible (a wrapper spawned with an id not in the server manifest is rejected at connection time).
- The operation of touching three layers for every addition of four personas (the omission exposed by fuji) disappears.
- Creators can make persona packs without touching the wrapper repo. Treating the whole creation as a distributable package lowers the barrier to distribution by external creators.

### Negative

- The server now enters “text composition,” slightly violating [ADR-0003](0003-persona-identity-persistence.md)’s “server is agent-independent” principle. Composition is only a `personality
  - common footer` concat and contains no decision-making, but crossing the boundary is explicitly treated as an exception.
- Fail-closed makes running a server in dev/local routine. The dev procedure changes from “run the wrapper alone” to “also run a minimal server.”
- Initial cost of packaging and migrating the existing four personas (ao/kuroe/momo/fuji).
- Hot-swap for connected wrappers is deferred until phase-1. A dev workflow that expects a zip update to apply immediately requires extra work (disconnect → reconnect).

### Neutral

- `personas[]` in the runner’s `runner.config.json` remains as a “per-host restriction” allow-list (it is not abolished). Its purpose is not “forbid rogue personas” but the operational policy of narrowing which personas can be used on this host. Differences from the server SoT are shown as an operational warning.
- The persona pack schema has room for future extensions (metadata such as license / provenance / attribution). Start with the minimum keys.

## Alternatives Considered

### F1: Internal zip schema

| Option | Why rejected |
|---|---|
| Flat root layout (place all files side by side at root) | Becomes messy when files are added in the future. Cannot withstand design changes that make sprites/ larger |
| Consolidate in YAML frontmatter (abolish manifest.json) | personality.md takes two roles, “body + metadata,” worsening both tooling and readability |

### F2: Overlay integration vs keeping two layers

| Option | Why rejected |
|---|---|
| Keep bundled + overlay as two layers | Lowers SoT purity (which is the source of truth becomes ambiguous) |
| Abolish overlay and keep bundled only | Bundled is read-only inside the release. Cannot secure a writable directory with docker |

### F3: Behaviour when the server is unreachable

| Option | Why rejected |
|---|---|
| Start with the default persona (plain AI) | Creates a hole in the pure SoT. Protects dev/local, but the user prioritises SoT purity |
| Use the wrapper-side cache as fallback | SoT is compromised by the phenomenon that “an old prompt once cached continues to live” |

### F4: Zip verification level

| Option | Why rejected |
|---|---|
| Add hash verification (detect transit corruption) | Excessive for an internal project. Extend it once network distribution is established |
| Require creator signatures | Key management and operational load suit enterprise use. Unnecessary in an internal trust domain |

### F5: Ownership of the common footer

| Option | Why rejected |
|---|---|
| Compose on the wrapper side (carry over the current form) | Damages the server SoT. “Personality logic remains in the wrapper” → SoT becomes double-managed |
| Abolish the footer and embed it in personality | Requires rebuilding every pack for each common-spec change. High operational load |

### F6: Watch implementation

| Option | Why rejected |
|---|---|
| Polling (every 5–30 seconds) | Latency and resource trade-off. Since event-driven operation is already mature, there is no reason to choose it |

### F7: Schema versioning

| Option | Why rejected |
|---|---|
| Strict API-version branching (v1/v2) from the start | Excessive for an internal project. Extend it when a breaking change occurs |

### F8: Semantics of deletion

| Option | Why rejected |
|---|---|
| Treat deletion as archive (continue connected sessions) | Inconsistent with F3 (fail-closed). “A conversation continues with a deleted persona” weakens the meaning of the SoT |

### F9: Concurrent update

| Option | Why rejected |
|---|---|
| Live push/hot-swap with WS messages | Difficult to implement and debug. Behaviour where a persona changes during a conversation is highly uncertain. Extend when it becomes necessary in the future (phase-1) |

### F10: Dev/local

| Option | Why rejected |
|---|---|
| `--dev-mode` on the wrapper (inject a dummy prompt) | Creates an exception hole in F3 (fail-closed). Even if dev-only, it lowers SoT purity |

### F11: Work tree

| Option | Why rejected |
|---|---|
| Keep `wrapper/personas/*.md` as the work tree | The wrapper’s responsibility grows into “run + create.” The need to place sprites elsewhere also remains |

## Follow-ups

- See the implementation plan [phase-10-persona-server-sot](../plans/phase-10-persona-server-sot.md).
- Packaging and migration of the existing four personas (ao / kuroe / momo / fuji) is included in phase-10’s completion conditions.
- Old ADR-0008 / ADR-0026 are superseded by this ADR. The retirement work is fixed at phase-10 completion.
- Phase-1 (future): hot-swap (F9), refinement of concurrent-update behaviour, and watch-debounce tuning.
- Phase-2 (deferred): hash / signature verification (F4), strict API versioning (F7), and zip synchronisation between multiple hosts.

## See Also

- Related specs: [personas](../specs/personas.md), [persona-pack-schema](../specs/persona-pack-schema.md), [persona-personality-injection](../specs/persona-personality-injection.md), [setup-wizards](../specs/setup-wizards.md), [protocol](../specs/protocol.md), and [threat-model](../specs/threat-model.md)
- ADRs: [ADR-0002](0002-local-wrapper-websocket-topology.md) (WS path), [ADR-0003](0003-persona-identity-persistence.md) (persona identity), [ADR-0008](0008-persona-asset-distribution.md) (superseded), [ADR-0024](0024-agent-instance-identity-and-spawn-auth.md) (spawn authentication), and [ADR-0026](0026-persona-personality-injection.md) (superseded)
- Plan: [phase-10-persona-server-sot](../plans/phase-10-persona-server-sot.md)
