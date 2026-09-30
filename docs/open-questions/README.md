# Open Questions

Unresolved issues. Each entry follows the "Background / Options / Impact /
Basis for judgment / Provisional policy" structure and has `urgency` / `blocks`
/ `opened` in its frontmatter.

## Open

| Slug | Urgency | Blocks | Opened |
|------|---------|--------|--------|
| [live2d-oss-rendering](live2d-oss-rendering.md) | low | — | 2026-06-15 |
| [file-upload-fs-read-fallback](file-upload-fs-read-fallback.md) | low | — | 2026-06-27 |
| [file-upload-json-fallback](file-upload-json-fallback.md) | low | — | 2026-06-27 |
| [file-upload-spill-storage](file-upload-spill-storage.md) | low | — | 2026-06-27 |
| [file-upload-exif-stripping](file-upload-exif-stripping.md) | low | — | 2026-06-27 |
| [file-upload-name-collision](file-upload-name-collision.md) | low | — | 2026-06-27 |
| [file-upload-files-api-route](file-upload-files-api-route.md) | low | — | 2026-06-27 |
| [file-upload-markitdown-fallback](file-upload-markitdown-fallback.md) | low | — | 2026-06-27 |
| [persona-behavioral-prompt](persona-behavioral-prompt.md) | low | — | 2026-07-02 |
| [persona-voice-distinctiveness](persona-voice-distinctiveness.md) | low | — | 2026-07-02 |
| [persona-language-dispatch](persona-language-dispatch.md) | low | persona-personality-injection | 2026-07-02 |
| [persona-personality-vs-dialogue](persona-personality-vs-dialogue.md) | low | — | 2026-07-02 |
| [external-human-inbound-llm-tier](external-human-inbound-llm-tier.md) | medium | protocol-external-human, phase-9-external-human-messaging | 2026-07-04 |
| [external-human-inbound-loss](external-human-inbound-loss.md) | low | — | 2026-07-04 |
| [external-human-agent-consumes-input](external-human-agent-consumes-input.md) | low | — | 2026-07-04 |
| [external-human-recv-permission-model](external-human-recv-permission-model.md) | low | — | 2026-07-04 |
| [external-human-contact-management-ux](external-human-contact-management-ux.md) | low | — | 2026-07-04 |
| [codex-cwd-extraction](codex-cwd-extraction.md) | low | — | 2026-07-10 |
| [claude-effort-levels-init-transition](claude-effort-levels-init-transition.md) | medium | — | 2026-07-14 |
| [coordination-report-routing](coordination-report-routing.md) | medium | — | 2026-07-28 |
| [work-division-conflict-guard](work-division-conflict-guard.md) | low | — | 2026-07-28 |
| [lifecycle-timeline-ui](lifecycle-timeline-ui.md) | medium | — | 2026-08-31 |
| [inter-agent-delivery-timing-and-turn-ownership](inter-agent-delivery-timing-and-turn-ownership.md) | high | issue-426-agent-handback-admission, issue-412 | 2026-09-28 |

## Deferred

Decided but not promoted to an ADR — the decision was to defer, not to settle
a design. Kept here (not deleted) so the reason for the deferral stays visible.

| Slug | Decided | Reason |
|------|---------|--------|
| [codex-lifecycle-observability](codex-lifecycle-observability.md) | 2026-08-31 | No way to observe Codex compaction locally, so Codex `session_lifecycle` / `resume_prompt` support is deferred (engine-side auto-compaction assumed; out of scope for now) |

## Recently decided

Once `status` is decided, promote the file to `../adr/` (or delete it). Do not
leave a stale `decided` entry here. See [../adr/](../adr/) for resolved decisions.

## Format

Each file: Background / Options / Impact / Basis for judgment / Provisional
policy / Actions upon resolution.
