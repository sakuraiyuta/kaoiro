---
title: Session pointer cwd recovery
description: Audit launch directories and explicitly repair a confirmed session pointer without replacing its session or settings.
status: accepted
last_updated: 2026-10-02
related: [ADR-0014, issue-480]
---

# Session pointer cwd recovery

Restore uses the launch cwd stored in `SessionPointers`. Envelope reports update
the latest session ID and engine while retaining that cwd; a first reported cwd
fills an unseeded pointer. Explicit spawn seeds and maintenance writes can replace
the cwd. Dashboard `cwd` displays the latest reported `ext.cwd`, which may instead
be a worktree. Restore, disconnected resume, and implicit session enumeration use
the pointer's launch cwd. Runner allowlist membership is an exact match.

Existing pointers retain their DETS format and contents. A pointer already
containing an execution cwd needs operator confirmation and explicit repair;
there is no automatic search through allowed directories. Deployment and data
repair are separate operations. See [server update and rollback](server-update-and-rollback.md)
for deploying the corrected server.

## Read-only audit before and after deployment

Run this against the deployed release before updating it, and again after the
corrected server is running and runners have registered. Replace the Compose
path with the deployment's actual file. The command reads the application stores,
including live and offline rows, without opening their DETS files.

```sh
docker compose -f /path/to/deployment/docker-compose.yaml exec -T kaoiro \
  /app/bin/kaoiro_server rpc '
states = KaoiroServer.AgentStates.snapshot()
KaoiroServer.SessionPointers.all()
|> Enum.flat_map(fn {agent_id, pointer} ->
  host_id = KaoiroServerWeb.AgentId.host_id_from(agent_id)
  host = KaoiroServer.HostRegistry.get(host_id)
  reason = cond do
    is_nil(pointer.cwd) -> :no_cwd
    is_nil(host) -> :host_not_registered
    pointer.cwd in host.cwd_allowlist -> nil
    true -> :cwd_not_allowed
  end
  if is_nil(reason), do: [], else: [%{
    agent_id: agent_id, host_id: host_id, cwd: pointer.cwd,
    session_id: pointer.session_id,
    state: get_in(states, [agent_id, "state"]), reason: reason
  }]
end)
|> Enum.sort_by(& &1.agent_id)
|> IO.inspect(limit: :infinity)'
```

`no_cwd` requires a confirmed launch directory. `cwd_not_allowed` identifies a
repair candidate, not its correct replacement. `host_not_registered` cannot be
checked against the runner's current allowlist: wait for registration or use a
separately confirmed maintenance procedure. Direct-wrapper rows also require
operator judgment. A contaminated cwd that is itself allowlisted is invisible
to this comparison, so inspect known affected rows even when the audit is empty.
The snapshots are not atomic; rerun when registration, reset, switch, deletion,
or maintenance overlaps the audit.

## Confirm the launch directory and exact session

1. Record the affected agent ID, owning host, engine, and exact stored session
   ID. Confirm the intended launch cwd from the original launch/configuration
   evidence and its exact membership in that host's current `cwd_allowlist`.
   A parent directory or the first allowed entry is not sufficient evidence.
2. In LaunchDialog, select resume mode, choose that host, cwd, and engine,
   and wait for the newly
   requested session list. Close the dialog without launching. This sends an
   explicit-cwd `enumerate_sessions` request;
   implicit enumeration would still use the contaminated pointer. The listing
   is a candidate check: a Claude directory named like a JSONL can be listed,
   and a listed file can disappear before restore.
3. On the owning runner host, using its service user and environment, run the
   actual built `sessionExists` query from the same runner release. Replace all
   four arguments below. Use the runner's own module, including its default
   engine-specific storage paths and `CODEX_HOME`; do not check an unrelated
   workstation or reconstruct the storage-path encoding by hand.

```sh
node --input-type=module - \
  /absolute/runner-install/dist/sessions.js \
  '<confirmed-launch-cwd>' '<exact-stored-session-id>' '<engine>' <<'JS'
import { pathToFileURL } from 'node:url';
const [modulePath, cwd, sessionId, engine] = process.argv.slice(2);
const { sessionExists } = await import(pathToFileURL(modulePath).href);
const exists = await sessionExists(cwd, sessionId, engine);
console.log(JSON.stringify({ cwd, sessionId, engine, exists }));
process.exit(exists ? 0 : 1);
JS
```

Continue only after exit 0 and `exists: true` for the exact stored ID. This is
the same query used by runner T3; Claude requires an actual JSONL file. Restore
repeats T3, so this observation does not bypass a later missing-file rejection.
If the stored session ID is nil, skip the transcript checks: restore starts a
fresh session while applying retained settings. Do not overlap repair with a
reset, switch, or delete operation.

## Repair after the corrected ingestion policy is running

After the confirmations above, replace the placeholders and run this maintenance
RPC. It refuses an unknown host or non-allowlisted cwd before writing. Do not use
an old server whose envelope ingestion can overwrite the repaired cwd again.

```sh
docker compose -f /path/to/deployment/docker-compose.yaml exec -T kaoiro \
  /app/bin/kaoiro_server rpc '
agent_id = "<confirmed-agent-id>"
cwd = "<confirmed-launch-cwd>"
host = KaoiroServer.HostRegistry.get(KaoiroServerWeb.AgentId.host_id_from(agent_id))
true = is_map(host) and cwd in host.cwd_allowlist
before = KaoiroServer.SessionPointers.get(agent_id)
true = is_map(before)
KaoiroServer.SessionPointers.record(agent_id, nil, cwd)
after_repair = KaoiroServer.SessionPointers.get(agent_id)
true = after_repair == %{before | cwd: cwd}
IO.inspect(after_repair, limit: :infinity)'
```

The synchronous readback follows the cast and checks that only cwd changed;
session ID, engine, snapshot, and effort revision remain intact. A failed
readback may indicate a concurrent update: inspect the latest row and re-audit
instead of retrying blindly or overwriting the other fields. Run the audit again,
then restore the disconnected agent. Normal runner T1/T3 checks remain active.
Do not delete the row as a repair shortcut. A delayed envelope after deletion
can bootstrap a new pointer from its reported cwd; deletion fencing is outside
this procedure.
