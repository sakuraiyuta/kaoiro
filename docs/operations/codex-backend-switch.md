---
title: "Codex backend switching and rollback"
status: implemented
last_updated: 2026-10-31
---

# Codex backend switching and rollback

The runner-local setting is specified in the [runner configuration reference](../reference/configuration/runner.md#codex-backend).
Package handoff measurements and limits are retained in the
[rollback artifact evidence](../evidence/codex-app-server/backend-rollback-artifact.md). General installation and updates
remain in the [production deployment manual](production.md). U1's producer
coverage and remaining limits are recorded in the
[compatibility evidence](../evidence/codex-app-server/issue-564-u1-compatibility-2026-10-27.md).

## Preparation before a default change

Use the preparation command introduced for [issue #564](https://github.com/sakuraiyuta/kaoiro/issues/564),
`scripts/codex-backend-compatibility.mjs`, before deploying a later
default-changing release to an affected host whose `codex.backend` is omitted.
Its only supported phase is `prepare`:

```sh
node scripts/codex-backend-compatibility.mjs \
  --phase prepare \
  --host <host-id> \
  --runner-sha <40-character-runner-release-sha> \
  --compose-file <confirmed-compose-file> \
  --runner-config <confirmed-runner-config> \
  --runner-unit <confirmed-user-unit> \
  --origin-evidence <private-origin-evidence.json>
```

The command reads the complete host union from the server, including directory,
pointer, live, reset-lock, and pending-transition membership. It also verifies
the local runner identity, current configuration, and applied backend evidence.
Runner identity is read from the public startup diagnostic
`runner: host=<host-id> rev=<release-sha> connecting to ...`, scoped to the
current service invocation. The invocation is searched in full; its journal
read is not limited to the last N lines. A missing, ambiguous, malformed, or
over-8-MiB startup read stops with `runner-start-record-unavailable`; a `-dirty`
revision stops with `runner-identity-dirty`. The runner's public
`--version --json` output is another source for checking a release SHA
(`revision` must be the expected full SHA and `dirty` must be the JSON boolean
`false`). The preparation command does not invoke or depend on `kaoiro-prod`.

If the current invocation has no unique, well-formed startup record, or the
full invocation exceeds the 8 MiB read cap, the command stops with
`runner-start-record-unavailable` before observing the server or writing
configuration. Do not synthesize an identity from another invocation. The
operator can schedule a controlled runner-service restart to create a new
startup record, then rerun preparation. A planned runner shutdown stops its
supervised wrappers and interrupts their active turns; affected agents may
need to be relaunched through the existing controls after the runner
reconnects. If that impact is not acceptable, leave configuration untouched
and postpone the host's default-changing update until a planned verification
window. A `runner-identity-dirty` stop means the running artifact reports a
dirty checkout; defer preparation until the intended clean runner release is
active. This command never restarts the service automatically.
The synchronous `execFileSync` capture reports this overflow as `ENOBUFS`;
U1 preserves that error through the command boundary and maps it to
`runner-start-record-unavailable` when reading the startup record.

Before writing, it repeats both observations and stops if any value changed or
is unavailable. A successful preparation adds only `codex.backend: "exec"`,
then waits for the runner's exact applied-selection diagnostic and rechecks the
saved setting. It does not reset, restore, remove a pin, or switch an explicit
backend.

An explicit `exec` or `app-server` setting with a matching applied selection is
left as-is, regardless of session creation origin. For an omitted setting, the
current applied selection must be `exec`, origin evidence must completely and
exactly cover the observed host rows, and no reset or transition may be
pending. A null engine is resolved only by complete evidence bound to the
current runner/config/invocation: `exec`, `not-codex`, or an attested `unknown`
is allowed; `none` is allowed only without a non-nil pointer. `app-server`, an
unsupported origin, conflicting evidence, and an unknown non-null engine stop
before the write. An operator may resolve unknown direct origin with the
separately recorded configuration-history attestation accepted in
[issue #564](https://github.com/sakuraiyuta/kaoiro/issues/564);
the private file must record its scope, attested time, release range, statement,
and unknown rows, with no conflicting or unresolved rows. It remains an
operator-attested routing assumption, not a measurement. The origin-evidence
file must cover archived session IDs as well as current server members; UUID
shape and missing snapshot fields are not origin evidence.

The private JSON has `schema`, `host`, `config_sha256`, `config_mtime_ms`,
`runner_sha`, `invocation_id`, `all_relevant_sessions_covered`, `origin_source`,
`agent_ids`, and `agents` fields. `origin_source` is `measured` or
`operator-attestation`; each `agents` row has `id`, `origin`, and `complete`.
For an attestation, also set `attestation.accepted` and record
`attested_at`, `scope`, `release_range`, `statement`, `unknown_origin_rows`,
`contrary_rows`, and `unresolved_rows`. Set no operator-private values in
public issue comments or release notes.

If the write succeeds but the applied-selection acknowledgement is missing,
the command exits without a second write, rollback, or restore. Keep the
explicit setting in place, treat the applied state as unknown, and stop for
operator review. For separate server and runner hosts, use only an already
authorized adapter module; this command does not infer remote access or add an
SSH route. The preparation is not a distributed lock, so one maintenance owner
must exclude concurrent operator lifecycle actions while it runs.

## Read-only Supervisor observation

`KaoiroServer.CodexBackendCompatibility.observe_runner(host_id)` is a release
RPC that reads the connected runner's Codex Supervisor entries and pending
spawn/switch intents. Stopping, restarting, and resetting entries remain
visible until removed. An empty result is not a process-tree census or proof
of wrapper disconnection; server connection and session-pointer checks remain
separate requirements.

The `observeSupervisor` reader exported by
`scripts/codex-backend-compatibility.mjs` binds two fresh RPC responses to the
local user unit's MainPID, InvocationID, unchanged configuration and startup
revision, applied backend, channel owner, and runner instance. It requires
both server and runner support. Old runners time out after five seconds;
unavailable, malformed, oversized, busy, or ambiguous responses are refused.
The existing `prepare` phase does not use this reader. The omitted backend
still selects `exec`; remove-pin and fresh-restore gating belong to the
subsequent default-change unit ([issue #564](https://github.com/sakuraiyuta/kaoiro/issues/564)).

For `ambiguous_runner`, identify and resolve duplicate connections using the
existing runner-service procedure before observing again. A join that cannot
register in the server's connection Registry fails. If the Registry or its
partition is replaced, RPC returns `runner_registry_changed` (the local
reader reports `runner-registry-changed`). Recovery is manual: schedule a
whole server application restart under the
[server update procedure](server-update-and-rollback.md), then obtain new observations.
Reconnecting a runner alone does not clear this refusal. A channel-only
rejoin also does not resend host registration; the required whole application
restart reopens transports so runners register again.

An abnormal Registry partition exit terminates all runner channels, which
reconnect; wrapper channels and agents are not registered there and remain
unaffected. Lifecycle broadcasts during the runner reconnection gap may not
be delivered. Observation covers the current server's joined channels only,
not offline runners or runners connected to another server. Use one
maintenance owner; a read does not lock out later lifecycle changes.

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
