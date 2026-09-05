---
title: persona pack (zip) schema
description: Internal structure and manifest.json schema of the “persona pack” ZIP, the distribution unit for server-centralized persona distribution (ADR-0029).
status: accepted
related: [personas, persona-personality-injection, protocol]
---

# persona pack (zip) schema

## Purpose

Defines the internal structure and schema of the “persona pack” ZIP, the
distribution unit established by
[ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md): personas
have a server-centralized source of truth and are distributed in ZIP packs. It
is the shared contract for authors, the server implementation (import,
extraction, and validation), and build scripts.

## Definition

### Layout

One ZIP file = one persona pack = one persona.

```text
<pack-name>.zip
├── manifest.json
├── personality.md
└── sprites/
    ├── idle.png
    ├── thinking.png
    ├── tool_running.png
    ├── waiting_input.png
    ├── waiting_permission.png
    ├── done.png
    └── error.png
```

The ZIP file name is arbitrary (recommended: `<id>-<version>.zip`; for example,
`fuji-1.0.0.zip`). The `id` field in `manifest.json`, rather than the ZIP name,
is the source of truth.

### manifest.json schema

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | Required | Unique persona identifier. `^[A-Za-z0-9._-]+$` / 1–256 characters. [ADR-0003](../adr/0003-persona-identity-persistence.md). Also becomes the filesystem directory name. |
| `name` | string | Required | Proper name of the persona defined by the pack (Japanese permitted; canonical—issue #209 D19). 1–64 grapheme clusters and at most 256 UTF-8 bytes; control characters prohibited (same domain as agent `display_name`, D24). |
| `sprite_set` | string | Required | Sprite-set identifier. Usually identical to `id`. 1–256 characters. |
| `version` | string | Required | Semver (for example, `1.0.0`). The author bumps it each time they update the pack. |
| `license` | string | Required | License identifier (SPDX-compliant recommended; for example, `CC0-1.0`, `CC-BY-4.0`, `MIT`, `proprietary`). AI-generated works may not have copyright, so confirm that the license label matches reality. Separately confirm how far the model's terms extend to Outputs. |
| `min_kaoiro_version` | string | Required | Lower semver bound of the server version needed to operate. The server rejects import if it is lower. |
| `states` | string[] | Required | State IDs included in sprites/. Order is irrelevant; includes the seven required states and optional reserved IDs. |
| `description` | string | Optional | One-line pack description, shown in the display UI. |
| `author` | string | Optional | Author name. |
| `homepage` | string | Optional | Source-project URL. |

Required `states` values (all seven; order is irrelevant):

```json
["idle", "thinking", "tool_running", "waiting_input",
 "waiting_permission", "done", "error"]
```

The only optional reserved ID is `fatigued`. It is not part of the protocol's
`state` vocabulary; it is a sprite for an orthogonal modifier derived by the
client from context utilization. It is optional, but enumerating it requires a
corresponding PNG. Unknown IDs are rejected.

Example (the fuji persona):

```json
{
  "id": "fuji",
  "name": "ふじ",
  "sprite_set": "fuji",
  "version": "1.0.1",
  "license": "CC0-1.0",
  "min_kaoiro_version": "0.1.0",
  "states": ["idle", "thinking", "tool_running", "waiting_input",
             "waiting_permission", "done", "error"],
  "description": "お嬢様知的マウント才媛型ペルソナ",
  "author": "sakurai.yuta@gmail.com"
}
```

A pack that includes a fatigue sprite declares it by adding `"fatigued"` to the
seven required states:

```json
"states": ["idle", "thinking", "tool_running", "waiting_input",
           "waiting_permission", "done", "error", "fatigued"]
```

### personality.md

**Plain Markdown body**. Do not add frontmatter (metadata belongs in
manifest.json). A length of 200–1000 Japanese characters is a SHOULD guideline
(there is no hard upper limit).

The server retains this body unchanged on import. When delivering it to a
wrapper, if `KAOIRO_FOOTER_DIR` is configured, it concatenates `system-footer.md`
and `user-footer.md` from that directory to the end and pushes it. If it is not
configured, it concatenates only the built-in default system footer. The server
is responsible for this composition ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
F5).

### sprites/

PNG for each state. **512x512 transparent PNGs** are recommended (the existing
implementation line for four personas). **Every** state listed in
`manifest.states[]` MUST be present. The seven required states are needed
whether or not the manifest enumerates them.

For the generation recipe (ComfyUI model / seed / rembg procedure), see
[personas](personas.md). Only PNGs are required when distributing a pack.

### provenance/ (work tree only; not included in ZIP)

`persona-packs/<id>/provenance/<state>.json` is generation provenance
(reproduction parameters) in a one-to-one correspondence with
`sprites/<state>.png`. From the output directory of the source ComfyUI, the
state-to-generation-job mapping is uniquely determined either by a sha256 match
with the raw PNG or by the opaque-interior RGB invariant of the final sprite,
then sanitized and imported. The latter is used only for pipelines that retain
the raw PNG's RGB after rembg (for its background, see “Generation record” in
[personas](personas.md)).

It is not included in the ZIP. `scripts/build-persona-pack.sh` explicitly lists
only the three entries `manifest.json`, `personality.md`, and `sprites`, so
placing `provenance/` there does not affect the distributed artifact (it is an
asset of the development repository).

Retained fields (allowlist, fail-closed—unknown fields are warned about and
dropped on import): `mode` / `prompt` / `negative` / `model` / `architecture` /
`seed` / `steps` / `width` / `height` / `cfg` / `denoise` / `generated_at` /
`job_id` / `source_job_id` / `tool` / `source_refs` / `postprocess` / `sha256`.
The last four are optional fields independent of the generation system: `tool`
identifies the generation surface, `source_refs` is an array of relative paths
to reference material, `postprocess` summarizes post-processing, and `sha256`
is the artifact PNG's SHA-256. Existing Anima fields remain unchanged; only
these four fields explicitly extend the allowlist. The fail-closed principle is
preserved: unknown fields not listed here continue to be warned about and
dropped from output. Fields that may contain personal or sensitive information,
such as `account` (email address) or `image_url` (a signed URL with credential
properties), are excluded on import.

Use `scripts/import-anima-provenance.sh <id> --anima-dir <dir>` for import.
`--anima-dir` MUST be explicitly supplied; there is no environment-specific
default path. For the RGB invariant, pass `--match-mode rgb-invariant` and
compare all 7x7 pairs across the seven states. Each correct pair must be within
the MAE cap, every incorrect pair must be sufficiently distant, and the mapping
must be one-to-one.

## Constraints

- **MUST**: The ZIP root contains all three entries: `manifest.json`,
  `personality.md`, and `sprites/`. Other entries are ignored (future
  forward-compatible).
- **MUST**: All required fields of `manifest.json` are present. Missing fields
  or wrong types reject import.
- **MUST**: `sprites/` contains PNGs for all seven states (idle / thinking /
  tool_running / waiting_input / waiting_permission / done / error).
- **MUST**: `id` is unique (it does not collide with an existing registration).
  A collision rejects import. **The first match wins**: ZIP files in the import
  directory are read by filename order. Thus, if a new version is placed while
  retaining an old version with the same `id`, the earlier filename is adopted
  (`kohaku-1.0.0.zip` < `kohaku-1.1.0.zip`, so **the old version wins**). Remove
  the old ZIP when increasing the version. The implementation is
  `drop_duplicate_ids/1` in `server/lib/kaoiro_server/persona_assets.ex` (it
  drops subsequent entries with a warning).
- **MUST**: Import is rejected when `min_kaoiro_version` is higher than the
  server's runtime version.
- **MUST NOT**: Add frontmatter to `personality.md` (to prevent duplicate
  metadata management).
- **SHOULD**: `personality.md` is approximately 200–1000 Japanese characters
  ([ADR-0026](../adr/0026-persona-personality-injection.md) inheritance).
- **SHOULD**: PNGs are 512x512 and transparent. Higher resolutions are allowed,
  but increase delivery volume.
- **MAY**: To anticipate future additional pack fields, `manifest.json` takes a
  forward-compatible stance and ignores unknown keys.
- **NOT ENFORCED**: Hash/signature verification is an extension for phase-2 and
  later ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) F4).

## Open Questions

None. Decided by ADR-0029.

## See Also

- ADRs: [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  (the decision defining this spec),
  [ADR-0003](../adr/0003-persona-identity-persistence.md)
  (persona.id identity and persistence)
- Related specs: [personas](personas.md) (generation recipe and standing-
  illustration design policy),
  [persona-personality-injection](persona-personality-injection.md)
  (personality-prompt delivery and injection),
  [protocol](protocol.md) (`/api/personas` response format)
- Plan: [phase-10-persona-server-sot](../plans/phase-10-persona-server-sot.md)
