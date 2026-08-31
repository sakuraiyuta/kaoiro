---
title: Persona is distributed in server aggregate SoT, zip pack and reflected in auto-watch
status: accepted
date: 2026-07-05
opened: 2026-07-05
supersedes: [8, 26]
superseded_by: null
related_specs: [personas, persona-pack-schema, persona-personality-injection, setup-wizards, protocol, threat-model]
related_adrs: [2, 3, 8, 24, 26, 31, 44, 45, 46]
---

# ADR-0029 — Persona is distributed in server aggregate SoT, zip pack and reflected in auto-watch

## Status

Accepted. [ADR-0008](0008-persona-asset-distribution.md)
[ADR-0026](0026-persona-personality-injection.md)
supersede both.

## Context

The current persona data is distributed to three layers:

- `wrapper/personas/<id>.md` — Personality Prompt (wrapper loads itself,
  [ADR-0026](0026-persona-personality-injection.md))
- `server/priv/personas/<id>/*.png` — with `/api/personas`
Delivery, [ADR-0008](0008-persona-asset-distribution.md)
- `runner/runner.config.json` `personas[]` — spawnable id allowlist

This dispersion produces three practical problems:

1. **Create → Distribution → Operational Friction**: wrapper repo for each additional persona
server repo and config config Add fuji Persian
(2026 -05) forget to touch the personas array of `runner.config.json`
There was a problem that the startup dialog does not come out.
2. **Lack of SoT**: Which one is vague. even if the creator edits md,
server /   If the administrator wants to control spawn
There are several layers to hold.
3. **I can't enclose a persona**: arbitrary `persona.id`
If wrapper is launched, wrapper accepts it as it is and only images
fallback. The persona that the administrator does not know can be found in the field.

To solve these 3 points at the same time, consolidate the persona data to**
The only SoT** and the author is distributed in 1 unit (zip pack).
It is necessary to be activated only by   in the directory.

This is the design concept (ADR 3 system) of server "delivering data silly"
For threat-model, the delivery and delivery of personality prompts (text)
This is an exception to allow a limited composition of common footer binding. Pure Static
Prioritize SoT rather than leaving the absence of SoT to protect the delivery.

## Decision

### F1: persona pack (zip) internal schema

zip internal `manifest.json` + `personality.md` + `sprites/<state>.png`
subdirectory structure.

```text
<pack-name>.zip
├── manifest.json         # id / name / sprite_set / version / license /
│                          #  min_kaoiro_version / states[] / …
├── personality.md        # Personality Prompt
└── sprites/
    ├── idle.png
    ├── thinking.png
    ├── tool_running.png
    ├── waiting_input.png
    ├── waiting_permission.png
    ├── done.png
    └── error.png
```

Detailed schema is [persona-pack-schema](../specs/persona-pack-schema.md)
separation.

### F2: env integration of the import directory

Current overlay mechanism (emphasize ex  directory with env `KAOIRO_PERSONA_DIR`)
and integrate the zip import destination. **env One import directory
SoT** bundled `server/priv/personas/` empty
also transferred to the import directory as pack.

### F3: server wrapper spawn = fail-closed

If the server cannot receive a personality prompt, wrapper spawn will explicitly
failure. wrapper side cache
No warmth. server is required for dev/local.

### F4: zip validation is the basis of schema + integrity

server validates only the following when deploying zip:

- `manifest.json` required fields (id/name/sprite set/version/...)
Type
- `sprites/` to 7 state(idle/thinking/tool running/waiting input/
waiting permission/done/error) There are all PNGs
- Uniqueness of `manifest.id`

hash validation and author signatures will be extended in the future.

### F5: common footer joins on the server side

The final prompt passed to the wrapper is the server
e and ship by side**. The wrapper will send the received string to the SDK.
No binding logic just by injecting. common footer
ADR Appendix D5 (formerly open-question `persona-common-footer`)
absorbed).

**LINK0 [0045-footer-file-externalization](0045-footer-file-externalization.md)
implemented)**: `personality + system-footer + user-footer`
SoT on the footer statement is directly under the footer installation directory (`KAOIRO_FOOTER_DIR`)
`system-footer.md` / `user-footer.md` When not set, use the built-in default,
user footer Contact Us
"Combination is the responsibility of the server side, wrapper injects the receipt string as it is"
Attribution does not change.

### F6: auto-watch Home xir FileSystem library

extract cache
[ADR-0046](0046-persona-cache-relocation.md)
(accepted).

watchxir `FileSystem` library
(fs.notify wrapper.Linux inotify / macOS FSEvents / Windows
ReadDirectoryChangesW) to event-driven. polling
Not used. Run manifest rebuild without manual restart.

### F7: schema versioning semver +`min_kaoiro_version`

`manifest.version` is semver. `min_kaoiro_version` on server
Declaring the version (rejection if below). Initial operation is loose
First, consider the value of the strict API version when required.

### F8: zip / persona Deleted Meaning = persona abolition (compliant with fail-closed)

If the zip value disappears from the import directory, it disappears from manifest,
Spawn in the id is not allowed. wrapper in connection fail- at next connection
Failure with closed (notiveive, consistent with F3).

### F9: concurrent update to wrapper during connection = reflected only when next connection

Even if zip is updated, it does not affect wrapper during connection (snap when connecting
session). hot-swap is phase-1 or later
extension.

### F10: dev/local always assumes minimal server

dev/local
(auto-start with scripts/dev.sh etc.). CODELINK0 [0002-local-wrapper-websocket-topology](0002-local-wrapper-websocket-topology.md)
"wrapper works locally" reads the meaning of "local + local server"


### F11: The working tree is not wrapper,`wrapper/personas/*.md`Complete removal

wrapper repo`persona-packs/<id>/{manifest.json,
personality.md, sprites/}`) edit and zip in build script.
`wrapper/personas/*.md` completely removes the wrapper's responsibility
Close

### D5 Appendix: common footer

Japanese term open-question `persona-common-footer`
1 sentence) to be adopted and determined by the ADR (open-question itself is the ADR
merged into `git rm`:

- Inside: "This agent is operated beyond the kaoiro client
1 sentence.
- Syn  order: `preset(claude_code) + personality + common footer`
(personality is lower than footer).
- Connected on the server side (F.. If you see a lack in dogfooding, you can use another ADR
Expand.

**Current**: [ADR-0045](0045-footer-file-externalization.md)
SoT on the surface is directly under the footer installation directory (`KAOIRO_FOOTER_DIR`)
`system-footer.md` / `user-footer.md` Built-in default D5 interim statement
Only remain as content. The overwrite of the operator can be reflected only by editing the file.
No change in implementation.

## Consequences

### Positive

- Persona SoT becomes the only (intake directory), creating →  buting →
Simple operation flow (zip drop 1 hand).
- "Nora persona" becomes impossible naturally (not in fest manifest id
spawn wrapper is rejected when connecting.
- 4 Operations that touch three layers per body addition (deposited by fuji)

- The creator can make a persona pack without touching the wrapper repo.
Since it can be handled as a whole distribution, the distribution Japanese termdle to the ex  creator is lowered.

### Negative

- [ADR-0003](0003-persona-identity-persistence.md)
the " agent is a non-agent" principle. The composition`personality
  - common footer`The concat only does not include decision-making, but across borders
explicit exception handling.
- fail-closed normalizes the server in dev/local.
The dev procedure starts from "Movee with wrapper" to "Movee minimal server"
Change
- Initial cost of transferring existing four bodies (ao/kuroe/momo/fuji) into pack.
- hot-swap to wrapper in connection is forwarded to phase-1. Update zip
The number of hands increases with the dev flow you want to reflect immediately (connection disconnection→reconnection).

### Neutral

- CO `runner.config.json` `personas[]` is "per-host limit"
survive as allowlist. The purpose is not "Nora"
Operation policy of “Squeeze persona” to be used by this host. server
The difference is indicated by an operational warning.
- persona pack schema is a future expansion
metadata such as attribution). Minimum keys.

## Alternatives Considered

### F1: zip internal schema

| Option | Why rejected |
|---|---|
|Flat root configuration|If you add files in the future, it will become dirty. sprites/ does not endure design changes that are obese|
|YAML frontmatter|personality.md becomes the second role of "body + meta" and both tooling and reedability worsen|

### F2: overlay integration vs double surviving

| Option | Why rejected |
|---|---|
|bundled + overlay|SoT purity drops (either true or ambiguous)|
|overlay removal bundled only|bundled is read-only in release. docker does not have a writable directory|

### F3: Unreachable behavior

| Option | Why rejected |
|---|---|
|Start by default persona|Make a hole in pure SoT. dev/local can be protected, but user prefers SoT purity|
|Use the wrapper cache for fallback|SoT is infringed in the phenomenon that "Old prompts are alive once cached"|

### F4: zip validation level

| Option | Why rejected |
|---|---|
|Added hash validation (transit corruption detection)|Excess in the inner wheel project. Expanded when distribution over the net is established|
|Request author signature|Key management and operational load for enterprise applications. No need for inner ring trust|

### F5: Attribution of common footer

| Option | Why rejected |
|---|---|
|wrapper (current attack)|server server SoT. "Remains personality logic in wrapper" → SoT doubles|
|footer abolished personality|Make all packs every time you change the common specification. Operational load|

### F6: Watch implementation

| Option | Why rejected |
|---|---|
|polling (5 to 30 seconds interval)|Trade-off of latency and resources. event-driven is already mature, no reason to choose|

### F7: schema versioning

| Option | Why rejected |
|---|---|
|(v1/v2)|Excess in the inner ring. breaking change|

### F8: Deleted Meaning

| Option | Why rejected |
|---|---|
|delete = archive|F3(fail-closed) "The conversation continues with the disappeared persona" state diminishes the meaning of SoT|

### F9: concurrent update

| Option | Why rejected |
|---|---|
|live push(hot-swap)|icult to implement and process. The behavior of persona changes during conversation is uncertain. Extended at the time of future required (phase-1)|

### F10: dev/local

| Option | Why rejected |
|---|---|
|wrapper`--dev-mode`(dummy)|F3(fail-closed) SoT purity drops only dev|

### F11: Working Tree

| Option | Why rejected |
|---|---|
| `wrapper/personas/*.md`Leave as a working tree|The wrapper's responsibility is "moving + making". Leave sprites in another position|

## Follow-ups

[phase-10-persona-server-sot](../plans/phase-10-persona-server-sot.md)
Reference.
- Work to move existing 4 bodies (ao / kuroe / momo / fuji) into pack
Includes phase-10 completion conditions.
ADR88 / ADR-0026 retire
10 d at completion.
- Phase-1: hot-swap(F9), concurrent update
debounce tuning.
- Phase-2 (deferred): hash / sign validation (F4), schema strict API
zip  between versioning(F7) and multi-host.

## See Also

- Related specs: [personas](../specs/personas.md),
  [persona-pack-schema](../specs/persona-pack-schema.md),
  [persona-personality-injection](../specs/persona-personality-injection.md),
  [setup-wizards](../specs/setup-wizards.md),
  [protocol](../specs/protocol.md), [threat-model](../specs/threat-model.md)
- ADRs: [ADR-0002](0002-local-wrapper-websocket-topology.md) (WS route),
[ADR-0003](0003-persona-identity-persistence.md),
  [ADR-0008](0008-persona-asset-distribution.md)(supersedes),
[ADR-0024](0024-agent-instance-identity-and-spawn-auth.md)(spawn authentication),
  [ADR-0026](0026-persona-personality-injection.md)(supersedes)
- Plan: [phase-10-persona-server-sot](../plans/phase-10-persona-server-sot.md)
