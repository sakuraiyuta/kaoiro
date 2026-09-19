---
title: "Runner configuration"
status: implemented
last_updated: 2026-09-18
---

# Runner configuration

## Coverage

This page currently covers the Codex backend selector. Other runner settings
remain in [deployment](../../specs/deployment.md#2-deploy-runners-multiple-hosts)
until their migration unit. Operator steps are in the
[backend switching runbook](../../operations/codex-backend-switch.md). The
per-spawn config fields the runner relays to the wrapper process itself are
in [Wrapper configuration](wrapper.md).

## Codex backend

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
[rollback runbook](../../operations/codex-backend-switch.md#codex-backend-selection-and-rollback)
and [ADR-0058](../../adr/0058-codex-app-server-turn-steer.md).
Steering remains disabled and approval remains `never`.
