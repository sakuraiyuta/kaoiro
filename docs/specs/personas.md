---
title: Character-design policy (persona standing illustrations)
description: Design policy for persona standing illustrations — the initial three personas, expression sets, image standards, and the ComfyUI generation workflow.
status: accepted
related: [protocol]
---

# Character-design policy (persona standing illustrations)

## Purpose

Establishes character-design decisions referenced by Phase 2 task 2-3 (bulk
production of expression variants) and future persona additions. The subject is
**illustrations, names, and expression-performance policy**. Runtime response
manner such as speech style and first-person pronoun is delegated to
[persona-personality-injection](persona-personality-injection.md) (on
2026-07-02 the “out of scope” clause was withdrawn,
[ADR-0026](../adr/0026-persona-personality-injection.md)). For relationship to
a future speech-balloon UI, see
[persona-personality-vs-dialogue](../open-questions/persona-personality-vs-dialogue.md)
.

## Definition

### Basic policy

- The baseline is **chibi/deformed style** (two to three heads tall). Prioritize
  expression legibility in small card displays and style consistency in bulk
  production.
- Run **one non-deformed persona** (kuroe) in parallel as an experiment. The
  mixed styles were **settled as adopted** through live-screen evaluation
  (2026-06-11): a reference implementation has value as a catalog showing
  diverse patterns, while stylistic unity is left to client developers and
  users.
- Differentiation uses two axes: “base color × range of expression performance.”
  Fix a color to each character as the most visible identifier at small sizes.

### Initial personas (three)

| persona.id | Name | Style | Base color | Appearance | Personality / expression-performance range |
|---|---|---|---|---|---|
| `ao` | ao | Full-body chibi | Blue | Blue short hair, hoodie, headphones | Cool and restrained. A gap when composure breaks highlights the state |
| `momo` | momo | Full-body chibi | Pink | Pink twin tails, ribbon | Energetic and over-reactive. Most legible at a distance |
| `kuroe` | kuroe | Non-deformed bust-up | Bluish black | Woman in her late 20s to 30, near-bob short hair, chic suit, monocle | A competent secretary who is matter-of-fact and does not hesitate to admonish. Calm, with a small range |

### Additional personas

Add future personas without impairing operation of the initial three. Manage
them by extending this table and the expression-set columns, and appending seeds
to “Generation record” below.

| persona.id | Name | Style | Base color | Appearance | Personality / expression-performance range |
|---|---|---|---|---|---|
| `fuji` | fuji | Non-deformed bust-up | Wisteria purple | Woman in her early 20s; restrained wisteria vertical curls (below shoulders), white blouse + wisteria jacket + ribbon tie, book in hand | An elegant, intellectual, slightly superior young lady. Happily points out mistakes, then adds a hint. Keeps a reserved distance by using “watakushi” and “Master.” Small to medium range (does not lose elegance or composure) |
| `kohaku` | kohaku | Non-deformed bust-up | Amber | Man in his 40s; short black hair with white streaks, thin silver-rim glasses, stubble, navy collared shirt | A CTO type who calls others Boss. Unruffled and steady, communicating more through posture and hands than expression. Small range. See the pack's personality.md for personality detail |

Personality is **design material for keeping expression performance consistent
in standing-illustration prompts** and is also **consumed by runtime personality
prompts** through [persona-personality-injection](persona-personality-injection.md)
(its use was extended on 2026-07-02, [ADR-0026](../adr/0026-persona-personality-injection.md)).
For example, for the same `done`, ao has a small proud face + modest comment,
momo a beaming smile + over-reactive comment, and kuroe a restrained smile and
nod + matter-of-fact report: expression performance corresponds to response
manner.

### Shared independently of engine (2026-07-10, [ADR-0032](../adr/0032-codex-adapter.md) F3)

`personality.md` and standing illustrations (seven-state expressions) are
shared by both engines (`claude-code` / `codex`) independently of engine.
Claude injects them into SDK `systemPrompt.append` as before
([ADR-0026](../adr/0026-persona-personality-injection.md) →
[ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)); Codex
injects them into config key `developer_instructions` (appended to base
instructions as a developer-role message; live verified 2026-07-10,
[ADR-0032](../adr/0032-codex-adapter.md) F3). There are no engine-specific
persona packs (`kuroe-claude` / `kuroe-codex`) nor engine-specific sections in
`personality.md`. Live verification on 2026-07-11 confirmed Codex injection is
effective (reproducing manner of speech and attitude): kuroe / ao were clearly
differentiated, and `developer_instructions` injection took effect faithfully
per persona (“Live verification note” in [codex-sdk-events](codex-sdk-events.md)).

### Default persona (plain AI)

Provide one default persona without a standing illustration for a “plain AI
agent” without personality. It includes no sprites and displays directly with
the reference dashboard's CSS-face fallback (simple expressions by state,
`expression.ts` / `AgentCard`).

| persona.id | Name | sprite_set | Standing illustration | Personality |
|---|---|---|---|---|
| `default` | Default | `default` | None (CSS face) | None |

- `default` in `sprite_set` is a reserved value. Do not place an `id: "default"`
  pack in the import directory (default `server/priv/persona-packs/`, changeable
  through `KAOIRO_PERSONA_DIR`); the server rejects it through
  `PersonaAssets.validate_manifest/2`. It is absent from the manifest, and the
  client falls back to sprite-free rendering (CSS face; “Persona asset delivery”
  in [protocol](protocol.md)).
- It is outside the MUST (Constraints below) to provide all seven state
  expression images — it is deliberately the only persona using a CSS face.
- It appears in the kaoiro client's startup dialog as the default candidate
  whenever the host's trust policy (“Host-side acceptance policy” below) allows
  it. Until ADR-0031, `default` was always injected irrespective of a host-side
  declaration, but it now has the same standing as an ordinary id subject to
  blocklist / allowlist for id-space consistency and simplification of
  `HostRegistry.inject_default/1` (see below).
- Example `persona` block in wrapper configuration (for full structure, see
  [wrapper/kaoiro.config.claude-code.example.json](../../wrapper/kaoiro.config.claude-code.example.json)
  or
  [wrapper/kaoiro.config.codex.example.json](../../wrapper/kaoiro.config.codex.example.json)):

```json
"persona": { "id": "default", "name": "デフォルト", "sprite_set": "default" }
```

### Expression set (state → performance)

The required generation target is seven states. Do not generate `disconnected`;
the client represents it by applying grayscale (a CSS filter) to idle (the
state-set definition is in [protocol](protocol.md); mapping implementation is
the reference dashboard's `expression.ts`). `fatigued` is an optional sprite
modifier derived from context utilization, not a protocol state; its supporting
images are generated in issue #163
([ADR-0054](../adr/0054-fatigue-as-orthogonal-persona-modifier.md)).

| State | ao (restrained) | momo (large) | kuroe (calm) | fuji (composed superiority) | kohaku (unruffled) |
|---|---|---|---|---|---|
| idle | Composed blank face | Smiling | Cool composed face | Relaxed slight smile, gaze a little downward | Arms folded, looking slightly into the distance |
| thinking | Eyes closed, thinking quietly | Tilts head with a “hmm” | Hand on chin, eyes lowered | Hand on chin, diagonal gaze, smile | Hand on chin, eyes lowered, “hmm” |
| tool_running | Concentrates silently on hands | Rolls up sleeves enthusiastically | Tapping at a PC, concentrating | Eyes down on book/documents in hand, concentrating | Operating a desktop PC, concentrating |
| waiting_permission | Gives a silent look | Raises hand: “okay?” | Offers a document and asks for approval | Gently extends one hand, raises one eyebrow in inquiry | Offers document and requests a seal |
| waiting_input | Glances this way | Leans forward and waves | Holds a memo and looks quietly | Turns toward us, an expectant smile and slight head tilt | Leans forward to peer at the expression |
| done | Small proud face | Beaming smile + fist pump | Restrained smile and light nod | Proud eyes-closed smile, small nod | Crisp slight smile in a 20-degree turned composition |
| error | Eyes wide in upset | Teary-eyed | Apologetic expression | Hand on cheek, looks away with a troubled smile | Hides expression with hand on forehead |
| fatigued (optional modifier) | Half-lidded eyes, shoulders slightly dropped | Dejected but retains energy | Half-lidded eyes, lowered mouth corners, quietly shows exhaustion | Eyes lowered, mouth not relaxed, unable to hide fatigue | Narrows eyes, loosens posture slightly to show fatigue |

### Image standards

- Format: **transparent PNG**, square. Generate at 1024x1024 and shrink to
  512x512 for delivery.
- Composition: chibi (ao / momo) is full body; kuroe / fuji are bust-up (above
  chest), because a non-deformed full body makes the face collapse at small
  square size.
- Placement: distribute in a persona-pack ZIP as `sprites/<state>.png`
  ([persona-pack-schema](persona-pack-schema.md)). By convention, `sprite_set`
  has the same name as `persona.id`.
- Placement method ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)):
  authors distribute a persona-pack ZIP, and the server administrator drops it
  into the **import directory** (set by env). The server auto-watches, expands
  it automatically, and rebuilds the `/api/personas` manifest.

### Generation workflow (ComfyUI, demonstrated by ao prototype)

1. Use a fixed character-description prompt + fixed seed for each character;
   replace only the expression description to generate the seven states.
2. **Fix clothing and accessories, including colors, in tags** (for example,
   `white headphones, black shorts, blue and white sneakers`). For accessories
   whose design tends to vary, describe their shape in natural language at the
   end of the tags (for example, plain white round ear cups). Accessories whose
   colors are unspecified vary between images (observed).
3. Always include `logo, glowing, text` in the negative prompt (suppresses
   trademark logos, clothing prints, and glowing accessory variants).
4. For expressions with small performance changes, i2i from an idle anchor
   (denoise 0.6–0.75) is also effective: clothing and accessories are preserved
   almost completely, while pose/expression changes are weak (observed). Use it
   as a way to repair variation as well.
5. Prototype order: ao (validate chibi standard) → kuroe (validate
   non-deformed standard) → bulk production from momo onward.
6. The parent Anima license for `animality_ap3.safetensors` used in this
   generation limits Model / Derivatives to non-commercial use while permitting
   commercial use of Outputs. Commercial Model use through a paid API, etc.,
   requires a separate commercial license. Also check distribution conditions
   specific to derivative models.

### Generation record (2026-06-11, provenance for reproduction)

| Persona | Model | Fixed seed | Added |
|---|---|---|---|
| ao | `animality_ap3.safetensors` | `188531704877709` | 2026-06-11 |
| momo | `animality_ap3.safetensors` | `15180469782598` | 2026-06-11 |
| kuroe | `animality_ap3.safetensors` | `78243803967796` | 2026-06-11 |
| fuji | `animality_ap3.safetensors` | `218473265094718` | 2026-07-05 |
| kohaku | `animality_ap3.safetensors` | `87170280435203` | 2026-08-08 |

Work artifacts are `assets-work/dist/<sprite_set>/<state>.png` (1024x1024
transparent PNG, background removed with rembg `birefnet-portrait`, untracked
by git). Manage the distribution SoT in `persona-packs/<id>/` as a persona-pack
ZIP ([persona-pack-schema](persona-pack-schema.md)), create the ZIP with
`scripts/build-persona-pack.sh`, and place it in the server import directory.
See “Persona asset delivery” in [protocol](protocol.md) for delivery API format.

For complete reproduction parameters such as prompt text and steps, see
`persona-packs/<id>/provenance/<state>.json` (for field definitions and import
method, see “provenance/” in [persona-pack-schema](persona-pack-schema.md)).
The five imported personas are ao / momo / kuroe / kohaku / fuji. The seven
basic fuji states are matched uniquely through the opaque-interior RGB invariant
of archived raw PNG and final sprite. `fatigued` is a derived state generated by
Codex; retain its provenance separately from generation provenance.

### Distribution and import (pack workflow)

The complete create → distribute → operate flow is unified as follows under
[ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md):

1. **Author**: edit `persona-packs/<id>/{manifest.json, personality.md,
   sprites/}`
2. **Import provenance** (recommended): Use
   `scripts/import-anima-provenance.sh <id> --anima-dir <dir>` to compare
   source ComfyUI output and source PNG, and produce `<state>.json` below
   `persona-packs/<id>/provenance/`. Normally uses sha256. A pipeline that
   retains raw-PNG RGB after rembg can compare every opaque-interior 7×7 pair
   with `--match-mode rgb-invariant`. Do not import unless either method is
   deterministically unique.
3. **Build**: create a ZIP (`<id>-<version>.zip`) with
   `scripts/build-persona-pack.sh`
4. **Administrator**: drop the ZIP into the server import directory (set by
   env), and **remove a ZIP for an earlier version with the same `id`**. Import
   reads ZIPs in filename order and first wins on an `id` collision, so keeping
   an old version prevents a new one being adopted (the uniqueness MUST in
   [persona-pack-schema](persona-pack-schema.md))
5. **Server**: auto-watch detects and expands it, then rebuilds the manifest
6. **Wrapper**: receive the personality prompt from the server in the startup
   WS handshake and inject it into the SDK
   ([persona-personality-injection](persona-personality-injection.md))

For the internal ZIP schema, see
[persona-pack-schema](persona-pack-schema.md).

### Host-side acceptance policy (runner trust policy)

Of personas ingested by the server, the runner chooses one of three policies
declared in configuration to decide “which ones can actually be started on this
host”
([ADR-0031](../adr/0031-runner-persona-trust-mode.md)):

- **accept-all** (default): All server-known personas can start. This is the
  state without persona-related fields in `runner.config.json`. Placing a new
  pack on the server takes effect without restarting a running runner (the
  decision completes server-side in `AgentsChannel`).
- **allowlist**: Only ids enumerated in `allowed_personas: [id, ...]` can start.
- **blocklist**: All server-known personas except ids enumerated in
  `blocked_personas: [id, ...]` can start.

Each of the three has “only one declaration.” Configuration specifying both
`allowed_personas` and `blocked_personas` is rejected loudly (both at runner
startup and server registration). The former `personas: [...]` field is
accepted as an allowlist equivalent for a one-release compatibility window and
emits a deprecation warning.

The `default` id is also subject to these policies — listing it in
`blocked_personas` removes it from start candidates, and a host whose spawnable
set thereby becomes empty (a canary / host in preparation) is treated as a
legal state (the dashboard explicitly shows an empty picker).

## Constraints

- MUST: Each persona provides expression images for all seven required states
  (except the `default` persona — it has no standing illustration and displays
  as a CSS face). `fatigued` is optional, but a pack that declares it MUST
  provide its matching image.
- MUST NOT: Generate a `disconnected` image. Use a unified client-side
  grayscale representation.
- `persona.id` is a stable ID and does not change
  ([ADR-0003](../adr/0003-persona-identity-persistence.md)).
- SHOULD: Expressions are legible at small card-display size (roughly 128px
  square).
- MUST NOT: Include logos/trademarks of real brands in generated output. Check
  accessories (devices, shoes, headphones) during acceptance.
- Rendering is limited to switching static variants
  ([ADR-0004](../adr/0004-client-rendering-staged.md)).

## Open Questions

None.

## See Also

- Related specs: [protocol](protocol.md),
  [persona-pack-schema](persona-pack-schema.md),
  [persona-personality-injection](persona-personality-injection.md)
- ADRs: [0003](../adr/0003-persona-identity-persistence.md),
  [0004](../adr/0004-client-rendering-staged.md),
  [0008](../adr/0008-persona-asset-distribution.md)(superseded),
  [0026](../adr/0026-persona-personality-injection.md)(superseded),
  [0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
- Plans: [phase-2-client-character](../plans/phase-2-client-character.md),
  [phase-10-persona-server-sot](../plans/phase-10-persona-server-sot.md)
