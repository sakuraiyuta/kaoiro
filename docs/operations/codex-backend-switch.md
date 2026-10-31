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
Run `prepare` on the preparation release before installing the default-changing release:

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
The existing `prepare` phase does not use this reader. The `observe`,
`remove-pin`, `pin-exec-fresh`, and `restore-fresh` phases use it with the
server host projection and local runner/configuration observations.

For `ambiguous_runner`, identify and resolve duplicate connections using the
existing runner-service procedure before observing again. A join that cannot
register in the server's connection Registry fails. If the Registry or its
partition is replaced, RPC returns `runner_registry_changed` (the local
reader reports `runner-registry-changed`). The refusal is latched for the
current server application generation. Recovery is manual: schedule a full
server release/BEAM VM stop and start under the
[server update procedure](server-update-and-rollback.md). Confirm that the old
VM has exited and the new VM has started, then require runner registration
and a fresh successful Supervisor observation before proceeding. A healthy
server alone does not establish recovery. If either check fails, stop and
investigate; do not treat an unavailable observation as an empty result.

Stopping and starting only `:kaoiro_server` inside the same VM is not a
supported recovery procedure: it can reset the Registry baseline without
restoring runner registration after an abnormal partition exit. Reconnecting
a runner alone does not clear the existing application generation's refusal.
A channel-only rejoin also does not resend host registration.

An abnormal Registry partition exit terminates runner channels. The partition
failure itself does not terminate wrapper channels or agents, which are not
registered there. The subsequent VM restart disconnects their server
transports; confirm wrapper reconnection as part of recovery. Lifecycle
broadcasts during the runner reconnection gap may not be delivered.
Observation covers the current server's joined channels only,
not offline runners or runners connected to another server. Use one
maintenance owner; a read does not lock out later lifecycle changes.

## Fresh backend migration

Use one maintenance owner and exclude concurrent operator lifecycle actions.
Observations do not form a distributed lock: peer input can race with a reset
or arrive after the last observation. Before changing backend, every Codex
agent on the host must be disconnected, have a persisted **nil** pointer
(not a missing row), and have no pending reset/transition or Supervisor work.
Keep non-Codex agents in the roster; their existing connections are allowed.
Resolve unknown engine/current routing from actual records. Never infer a
session's origin from its UUID, an omitted backend, or missing snapshot data.

For each Codex sibling, obtain the operator's acceptance of context loss,
use the existing reset/new control, wait for completion and join, then stop.
Peer input after reset can create a new pointer. Repeat at most three cycles;
if the host still cannot reach the boundary, stop for operator review. A reset
failure may restore the previous ID: do not interpret failure as a nil pointer
or silently discard that session. The CLI does not perform resets or stops.

Use the same confirmed host, runner SHA, compose file, runner config and user
unit arguments as `prepare`. Immediately before **each** operation, the director
or assigned agent may run the read-only phase with already authorized adapters:

```sh
node scripts/codex-backend-compatibility.mjs \
  --phase observe --phase-target remove-pin \
  --host <host-id> --runner-sha <full-sha> \
  --compose-file <compose-file> --runner-config <runner-config> \
  --runner-unit <user-unit>
```

For `restore-fresh`, add `--agent <agent-id> --backend <exec|app-server>`.
`observe` does not write config, collect an acknowledgement cursor, read an
operator credential, or open an operator socket. Its JSON contains the actual
configured/applied backend, receipt, and `maintenance_template`. It succeeds
when observation succeeds, even if the host is not ready to mutate.

Save only the template as a private JSON file. Keep both the template and the
completed record outside repositories, public issues and kaoiro shared folders;
use an owned temporary directory or an operator-private location. Do not post
its output into those destinations. The creator deletes it after use.
The template includes runner/config identity, owner, instance and the complete
host roster, with `maintenance_owner_accepted:false`, unknown current routing,
and empty evidence references. It cannot authorize a write as emitted.

The director/agent prepares classifications, current routing and evidence
references from actual launch records. Each row has `id`, `classification`
(`codex` or `not-codex`), `current_backend`, and nonempty `evidence_refs`.
A non-Codex row uses `not-applicable`; a Codex row uses its known backend or
`none` only when disconnected/nil/work-free. References are pointers to
operator-reviewed facts, not machine-verifiable proof. The **operator** checks
the complete record and exclusion of concurrent actions, sets
`maintenance_owner_accepted:true`, and runs the operation from their own console.
Agents do not accept or execute writes on the operator's behalf.
If owner, instance, config or roster changes, regenerate the record and repeat
the operator check. Never carry an earlier acceptance forward automatically.

| Phase | Additional arguments | Required boundary and result |
|---|---|---|
| `remove-pin` | `--maintenance-evidence <private-file>` | Explicit exec configured and applied, plus the whole-host fresh boundary. Remove only the backend key; wait for omitted app-server to be applied. Explicit app-server and already omitted configurations are refused. |
| `pin-exec-fresh` | `--maintenance-evidence <private-file>` | Same whole-host fresh boundary. Select explicit exec. Already explicit exec still needs current observations and freshness; it is not a bypass. |
| `restore-fresh` | `--maintenance-evidence <private-file> --agent <id> --backend <exec|app-server> --operator-config <private-file>` | Target disconnected/nil/work-free, no pending lifecycle work, and all known Codex routing on the same selected backend. A connected same-backend sibling with a non-nil pointer is allowed. Send normal restore once and observe target connection plus its normal Supervisor child. |

The operator runs restore from their own console too. Agents, including the
director, never create, read or receive the operator token file. It contains
`{"server_url":"wss://<server>/client/websocket","token":"<operator-token>"}`,
lives outside the repo and shared folders, and must be a regular non-symlink
file owned by the executing effective UID with mode **0600**. The CLI checks
before reading and checks the opened descriptor again. The operator confirms
placement; file mode alone does not prove that placement. Other phases reject
`--operator-config` before reading it. Custom adapters do not waive these
operational rules. No credential is accepted in URL userinfo or query strings.

Normal restore sends no resume ID, cwd, engine override or snapshot. The
server's nil-pointer path retains `apply_resume_snapshot:true`. A reply is only
acceptance; successful CLI output additionally requires a fresh observation
of the target connection, no pending operation, and a normal Supervisor child.
It sends no model input. New native identity is checked by the migration's
native acceptance procedure, not inferred from reply correlation.

Every mutation rechecks H/R -> Supervisor -> H/R and compares a second bundle
immediately before the action. Successful JSON includes
`maintenance_evidence_sha256`, the hash of the exact accepted input bytes.
Keep the result with the private record until the operation is resolved.

| Failure stage | Required next action |
|---|---|
| `before-write` | No write/restore occurred. Resolve the reason, observe again, and create a new accepted record. |
| `write-outcome-unknown` | Inspect actual config and applied state; even a failed directory fsync may follow a successful rename. Do not restore wrappers yet. |
| `after-write` | Keep the actual config, resolve acknowledgement/observation failure, and confirm a reload receipt newer than the write. No automatic pin restoration. If remove-pin already left omission, do not rerun remove-pin or write exec just to retry. Only after confirming omitted app-server, create a new record for restore. |
| `restore-outcome-unknown` | Do not resend. Inspect current membership, pending work and connections. Use existing controls to resolve the state; retry only once the target is again disconnected/nil/work-free with a new record. |

A signal or forced exit is an unknown outcome too. If A restores successfully
and B fails, keep the backend and reobserve the whole host before retrying B.
Switching back to exec requires the fresh boundary for A and every sibling.
Registry replacement uses the VM recovery procedure above; application-only
restart or VM readiness without runner registration is not recovery.

## Backend selection and code rollback

The runner-local backend selects all subsequent Codex wrapper lifetimes on
that runner, not one dashboard agent. Existing wrappers keep their backend.
There is no environment flag or dashboard per-agent override. Confirm
`codex: backend=...` and the runner's applied-selection diagnostic.

Backend fallback and code rollback are different operations. The supported
backend fallback is `pin-exec-fresh` followed by fresh exec restores; it does
not resume app-server IDs on exec. Before a same-native **code** rollback,
stop all Codex siblings, preserve explicit app-server selection and verify its
application, then activate the known older code with the same native hash.
Restore one app-server ID, check its continuation/history, then restore siblings.
If the runner cannot start, validate the selected backend with the offline
loader before activating the old code. An old omitted-exec code target without
explicit app-server preparation is not a valid rollback target. Native-hash or
state changes require the existing state-aware rollback procedure instead.
Historical cross-backend observations remain evidence only and do not authorize
that procedure on the current native pin.

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
