---
title: "Codex backend retirement"
status: implemented
last_updated: 2026-11-24
---

# Codex backend retirement

Codex uses only the `app-server` backend. The `exec` backend was retired, and
the read-only Supervisor work observation RPC and backend switching CLI were
removed in [issue #1247](https://github.com/sakuraiyuta/kaoiro/issues/1247)
following the [operator decision in issue #1246](https://github.com/sakuraiyuta/kaoiro/issues/1246#issuecomment-7111070280).

- The runner and wrapper each validate their configuration at startup.
  Omit the backend or use `"app-server"`. Both reject an explicit `"exec"`
  ([runner configuration](../reference/configuration/runner.md#codex-backend)).
- To restart a Codex peer in a new session, use the dashboard reset or launch
  controls.
- Historical transition measurements and [U2 acceptance limits](https://github.com/sakuraiyuta/kaoiro/issues/564#issuecomment-6435984343)
  remain archived in [backend rollback evidence](../evidence/codex-app-server/backend-rollback-artifact.md),
  [U1 compatibility evidence](../evidence/codex-app-server/issue-564-u1-compatibility-2026-10-27.md),
  and [U2 fresh migration evidence](../evidence/codex-app-server/u2-fresh-migration-0.164.0-2026-10-31.md).
