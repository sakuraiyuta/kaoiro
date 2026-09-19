---
title: Persona delivery
description: The persona asset HTTP API and the WS-handshake personality-prompt push, including the wire's reject/fail-closed guarantees.
status: accepted
last_updated: 2026-09-19
related: [protocol, personas]
---

# Persona delivery

### Persona asset distribution

HTTP API resolving `persona.sprite_set` to images. [ADR-0008](../../adr/0008-persona-asset-distribution.md)
initially covered sprites only; [ADR-0029](../../adr/0029-persona-server-sot-and-pack-distribution.md)
expanded it on 2026-07-05 to persona-pack zip distribution, a server aggregate SoT, and
auto-watch. It is independent of Channels and not gated by `:serve_dashboard` (public API).
Asset layout and format are defined by [personas](../../specs/personas.md); the pack schema is
[persona-pack-format](../personas/pack-format.md).

- `GET /api/personas` — manifest JSON:

```json
{
  "version": "<16hex>",
  "personas": {
    "<sprite_set>": {
      "name": "<display name>",
      "pack_version": "<semver>",
      "description": "<optional 1-line>",
      "states": {
        "<state>": {
          "url": "/personas/<sprite_set>/<state>.png?v=<12hex>",
          "hash": "sha256:<64hex>"
        }
      }
    }
  }
}
```

- `version` is the aggregate version derived from asset contents; clients refetch sprite URLs
  only when it changes (incremental sync).
- `name` / `pack_version` / `description` come from the persona pack `manifest.json`
  ([persona-pack-format](../personas/pack-format.md)). `personality.md` is not exposed by this API;
  it is pushed only during the WS wrapper handshake (see "Personality prompt delivery").
- Hashed `url` forms are immutable with `cache-control: public, max-age=31536000, immutable`;
  URLs without `?v=` are `no-cache`.
- Only files listed in the manifest are served; unknown paths return 404.
- A missing sprite falls back to the `idle` image. `disconnected` has no image (MUST NOT in
  personas.md) and is shown as grayscale idle. Missing manifests or unlisted sprite sets fall
  back to sprite-less rendering (CSS face in the reference implementation).
- **Auto-watch**: the server watches the intake directory with Elixir `FileSystem`, detects zip
  additions/updates/deletions, and rebuilds the manifest ([ADR-0029](../../adr/0029-persona-server-sot-and-pack-distribution.md) F6); no manual restart is needed.

### Personality prompt delivery (ADR-0029)

Under [ADR-0029](../../adr/0029-persona-server-sot-and-pack-distribution.md), the personality
prompt is pushed from the server aggregate SoT (`personality.md` in the persona pack) to the
wrapper during the WS handshake.

- **Reject unknown persona.id at wrapper join**: when accepting `wrapper:<agent_id>`, the server
  checks the persona ID from the agent-token mapping against the manifest. IDs absent from the
  manifest are refused (enforcing no stray personas,
  [ADR-0029](../../adr/0029-persona-server-sot-and-pack-distribution.md)
  F3).
- **after_join push**: server pushes the following message to the wrapper:

  | Direction | Type | Payload | Notes |
  |---|---|---|---|
  | server → wrapper | `persona_prompt` | `{ prompt }` | Sent once after wrapper join. `prompt` is persona-pack `personality.md` plus the server-joined common footer ([ADR-0029](../../adr/0029-persona-server-sot-and-pack-distribution.md) F5). The wrapper injects it unchanged ([Personality-prompt injection by engine](../engines/personality-injection.md)); no hot-swap push occurs during the session (F9). |

- **Fail-closed when server is unreachable**: the wrapper cannot complete spawn until it
  receives `persona_prompt`, including dev/local operation where a minimal server runs in
  [ADR-0029](../../adr/0029-persona-server-sot-and-pack-distribution.md)
  F10).

### Prompt delivery (WS handshake)

In the **handshake message** immediately after the wrapper connects to the
server, the server pushes to the wrapper a prompt string combining “personality
description + common footer.” See “Personality prompt delivery” above for the
detailed message format.

- The server rejects a wrapper connection claiming an unknown `persona.id`
  (enforcement of “no unregistered personas,”
  [ADR-0029](../../adr/0029-persona-server-sot-and-pack-distribution.md)).
- If the server is unreachable, the wrapper spawn itself fails (fail closed).
  There is no local fallback.

### Data model

Wrapper configuration has no personality-related field. Only `persona.id` /
`persona.name` / `persona.sprite_set` (canonical values from the pack,
unchangeable during a session) remain in startup configuration
([setup-wizards](../configuration/setup-wizards.md)). Separately, the independent top-level
`display_name` field holds a **display name that may change during operation**
(issue #209 D19/D20 — `Principal.display_name`,
[ADR-0050](../../adr/0050-principal-model-and-graded-access-control.md) D1). On
spawn, the server initializes it with an operator-specified custom name or, if
unspecified, a copy of `persona.name`.

The personality-prompt body resides in `personality.md` in the server-side
persona pack ([persona-pack-format](../personas/pack-format.md)). Authors edit it
inside the persona-pack ZIP.

## Constraints

- MUST: Do not put a personality string in wrapper→server Envelopes
  ([threat-model](../../architecture/security-threat-model.md)).
- MUST: The server rejects a wrapper connection claiming an unknown `persona.id`.
- MUST: Wrapper spawn fails when the server is unreachable (fail closed).
- MUST NOT: Implement a fallback that loads local md on the wrapper side.
- MUST NOT: Cache a prompt on the wrapper side (prevents SoT violation).

## Open Questions

- [persona-behavioral-prompt](../../open-questions/persona-behavioral-prompt.md) —
  injection of task posture (future work)
- [persona-voice-distinctiveness](../../open-questions/persona-voice-distinctiveness.md)
  — trigger for rigorous distinguishability
- [persona-language-dispatch](../../open-questions/persona-language-dispatch.md) —
  multilingual dispatch. Since the former model's `persona.language` field was
  removed, reconsider including whether to add a `language` equivalent to the
  pack's manifest.json
- [persona-personality-vs-dialogue](../../open-questions/persona-personality-vs-dialogue.md)
  — reconsideration when speech-balloon UI is introduced

## See Also

- Related specs: [personas](../../specs/personas.md),
  [persona-pack-format](../personas/pack-format.md),
  [threat-model](../../architecture/security-threat-model.md)
- ADRs: [ADR-0003](../../adr/0003-persona-identity-persistence.md) (persona
  identity), [ADR-0006](../../adr/0006-doc-language-i18n.md) (language policy),
  [ADR-0029](../../adr/0029-persona-server-sot-and-pack-distribution.md)
  (application model for this specification; supersedes former ADR-0026),
  [ADR-0045](../../adr/0045-footer-file-externalization.md) (common-footer
  externalization; implemented; partially revises ADR-0029 F5/D5),
  [ADR-0044](../../adr/0044-coordination-injection-hitl.md) (adding
  collaborative-behavior guidance to footer, F1)
- Plan: [phase-10-persona-server-sot](../../plans/phase-10-persona-server-sot.md)

## Related protocol topics

- [Envelope contract](envelope.md).
- [Event types and payloads](events.md).
- [Channels and directional messages](channels.md).
- [Versioning policy](versioning.md).
- [Message topology](../../architecture/message-topology.md).
- [Permission requests](permission-requests.md).
- [Permission state](permission-state.md).
- [Permission synchronization and audit](permission-sync-audit.md).
- [Model and effort state](model-effort.md).
- [Session capabilities](capabilities.md).
- [Session lifecycle](session-lifecycle.md).
- [State machine](state-machine.md).
- [Attachment wire contract](attachments.md).
- [Attachment rendering by engine](../engines/attachment-rendering.md).
- [Runner control and launch](runner-control.md).
- [Wrapper configuration](../configuration/wrapper.md).
- [Task and tasklist envelopes](tasks.md).
- [Subagent visibility](../../architecture/subagent-visibility.md).
- [Personality-prompt injection by engine](../engines/personality-injection.md).
- [Personality configuration](../configuration/personality.md).
- [Personality-prompt injection (design)](../../architecture/personality-injection.md).
