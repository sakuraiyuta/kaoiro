# Codex wrapper internals

The public Codex engine defaults to `codex exec`. Set `codex.backend` to
`"app-server"` in `runner.config.json` to select the persistent app-server child
for subsequent Codex wrapper lifetimes on that host. `"exec"` or omission keeps
the default. The runner relays only its local selection as `codex_backend` in
the wrapper startup config; direct wrapper launches may use that same field.
Unknown values are rejected. No environment variable, command-line backend flag,
dashboard selector, spawn payload or resume snapshot selects a backend.

Configuration reload does not switch running children. After the runner's
`codex backend=... for subsequent wrappers` diagnostic, new launches and resumes
use the new selection. The wrapper also logs its selected backend at startup.
There is no automatic fallback to exec. See the
[rollback runbook](../../docs/operations/production.md#codex-backend-selection-and-rollback)
and [ADR-0058](../../docs/adr/0058-codex-app-server-turn-steer.md).
Steering remains disabled and approval remains `never`.

Implementation contracts are in the [backend architecture](../../docs/architecture/codex-backends.md) and its
transport, session, events, settings and history references. Dated verification
records are linked from [ADR-0058](../../docs/adr/0058-codex-app-server-turn-steer.md).

## Internal CLI composition and supervision

See [backend ownership and CLI composition](../../docs/architecture/codex-backends.md).
