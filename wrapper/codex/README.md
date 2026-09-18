# Codex wrapper internals

The public Codex engine defaults to `codex exec`. Select the backend through
`runner.config.json` → `codex.backend`; see the [configuration contract](../../docs/reference/configuration/runner.md#codex-backend)
and [switching and rollback runbook](../../docs/operations/codex-backend-switch.md).

Implementation contracts are in the [backend architecture](../../docs/architecture/codex-backends.md) and its
transport, session, events, settings and history references. Dated verification
records are linked from [ADR-0058](../../docs/adr/0058-codex-app-server-turn-steer.md).

## Internal CLI composition and supervision

See [backend ownership and CLI composition](../../docs/architecture/codex-backends.md).
