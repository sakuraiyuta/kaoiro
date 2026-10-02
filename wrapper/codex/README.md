# Codex wrapper internals

The public Codex engine defaults to `codex exec`. Select the backend through
`runner.config.json` → `codex.backend`; see the [configuration contract](../../docs/reference/configuration/runner.md#codex-backend)
and [switching and rollback runbook](../../docs/operations/codex-backend-switch.md).

Implementation contracts are in the [backend architecture](../../docs/architecture/codex-backends.md) and its
transport, session, events, settings and history references. Dated verification
records are linked from [ADR-0058](../../docs/adr/0058-codex-app-server-turn-steer.md).

## Internal CLI composition and supervision

See [backend ownership and CLI composition](../../docs/architecture/codex-backends.md).

## Context meter

App-server publishes qualified native context snapshots; exec remains unsupported.
Unknown intervals retain capability but omit context. Native totals and windows
are preserved even when their ratio exceeds 100%; they do not promise provider
admission. See [ADR-0040](../../docs/adr/0040-context-usage-capability.md#addendum-2026-10-03--app-server-context-snapshots).

The credentialed default-composition gate runs after building core, agent-common
and codex: `pnpm -C runner exec tsx ../scripts/check-codex-context-meter.mts <output-dir>`.
It requires an authenticated `CODEX_HOME`, uses pinned Codex 0.159.3 and a local
Phoenix wire fixture, and injects no host/session/transport factory. Unit suites
run separately with `env -u CODEX_HOME pnpm -C wrapper/codex test`.
