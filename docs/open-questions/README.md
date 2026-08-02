# Open Questions

未決の論点。各エントリは「背景 / 選択肢 / 影響 / 判断材料 / 暫定方針」構造で、
`urgency` / `blocks` / `opened` の frontmatter を持つ。

## Open

| Slug | Urgency | Blocks | Opened |
|------|---------|--------|--------|
| [live2d-oss-rendering](live2d-oss-rendering.md) | low | — | 2026-06-15 |
| [subagent-task-envelope-schema](subagent-task-envelope-schema.md) | high | subagent-tasks | 2026-06-16 |
| [subagent-task-aggregation](subagent-task-aggregation.md) | medium | subagent-tasks | 2026-06-16 |
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
| [codex-exec-approval-upstream](codex-exec-approval-upstream.md) | low | — | 2026-07-10 |
| [claude-effort-levels-init-transition](claude-effort-levels-init-transition.md) | medium | — | 2026-07-14 |
| [send-to-agent-auto-allow](send-to-agent-auto-allow.md) | high | protocol-inter-agent | 2026-07-28 |
| [coordination-footer-scope](coordination-footer-scope.md) | medium | — | 2026-07-28 |
| [coordination-report-routing](coordination-report-routing.md) | medium | — | 2026-07-28 |
| [work-division-conflict-guard](work-division-conflict-guard.md) | low | — | 2026-07-28 |
| [footer-default-visibility](footer-default-visibility.md) | medium | persona-personality-injection | 2026-08-02 |

## Recently decided

`status` が決定したらファイルは `../adr/` へ昇格(または削除)。stale な
`decided` をここに残さない。解決済みの決定は [../adr/](../adr/) を参照。

## Format

各ファイル: 背景 / 選択肢 / 影響 / 判断材料 / 暫定方針 / 解決時のアクション。
