---
title: "Codex backend switching and rollback"
status: implemented
last_updated: 2026-09-30
---

# Codex backend switching and rollback

The runner-local setting is specified in the [runner configuration reference](../reference/configuration/runner.md#codex-backend).
Package handoff measurements and limits are retained in the
[rollback artifact evidence](../evidence/codex-app-server/backend-rollback-artifact.md). General installation and updates
remain in the [production deployment manual](production.md).

## Codex backend selection and rollback

Use a runner release containing ADR-0058 Stage 1. In `runner.config.json`, merge
`"backend": "app-server"` into the existing `codex` object without deleting its
auth or model settings. The default is `"exec"`. This selects all subsequent
Codex wrapper lifetimes on that runner, not one dashboard agent. Running
wrappers keep their backend. No environment variable, backend flag or dashboard
control overrides it. Check the wrapper's `codex: backend=...` startup diagnostic.

To roll back to exec while preserving a session (exercised in production on
the 0.156.1 pin, in both directions, on 2026-09-30; see issue #452):

1. Record the Codex session ID, host and working directory. Stop the target agent
   through the existing operator stop action and wait for it to exit. Do not
   merely drop its socket or race the Supervisor's automatic restart.
2. Set `codex.backend` to `"exec"`. Wait for the runner diagnostic
   `runner: codex backend=exec for subsequent wrappers`. The earlier
   `config reload` line alone is insufficient; a skipped/failed reload must be
   corrected before proceeding. Other future Codex launches also use exec.
3. Use the existing session selection/restore flow to resume that recorded ID
   on the same host and cwd, with the same Codex session store. Do not select
   a fresh session/reset. The runner enforces its existing session existence
   check and exclusive resume lock.
4. Confirm `codex: backend=exec`, the resumed session ID and the next successful
   result. An ambiguous or failed turn is not automatically resubmitted.

This changes backend selection, not the installed release. App-server startup
failure remains an operator-visible error and closes admission; there is no
implicit exec fallback. Unexpected wrapper exits retain the Supervisor's
bounded restart policy. A deliberate stop does not restart.
After updating Codex, start one Codex agent and let its local state initialize
before a bulk spawn or reset of agents sharing a `CODEX_HOME`. The first start
after an update migrates the state schema in place, and separate wrappers can
race while that happens. The transport retries a failed `initialize` up to 3
times (about 2 s of added wait at most), which covered every measured
collision, but the migrations measured were small; the note stays for a
production home with large state databases. A retry is logged as
`codex: app-server initialize failed (attempt N/3), retrying ...`. Persistent
failures still surface as an operator-visible error with the attempt count.

Running the global `codex` CLI against the same `~/.codex` also migrates the
shared state, and opens the same race window for the wrappers that start next.
Production therefore uses a dedicated `CODEX_HOME` that only the pinned binary
touches (operator decision, [issue #454](https://github.com/sakuraiyuta/kaoiro/issues/454));
the procedure is in [Codex home for production](codex-home.md). Rolling back
the backend (above) keeps whichever home is configured.
