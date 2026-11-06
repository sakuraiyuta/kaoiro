import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import type { PermissionObservation, PermissionSelection, PermissionSyncMessage } from "@kaoiro/protocol";
import { applyPermissionSyncState, beginPermissionExecution, capturePermission,
  createPermissionState, effectiveNetworkAccess, permissionLaneFailed,
  permissionObservationApplied, permissionObservationFailed, requestPermission,
  setPermissionSyncSupport, withinCeiling } from "../src/permission_state.js";
const time = "2026-01-01T00:00:00Z";
const selection = (revision: number, sandbox: PermissionSelection["requested"]["sandbox"] = "read-only",
  network_access = false): PermissionSelection => ({ revision, requested: { sandbox, network_access } });
const launch = selection(0, "danger-full-access", true);
const initial = () => createPermissionState(launch, true);
const observation = (submission: ReturnType<typeof capturePermission> & {}) => ({ ...submission,
  session_id: "session", turn_id: "observed-prompt", permission: { sandbox: submission.requested.sandbox,
    approval: "on-request", enforcement: "os" }, network_access: effectiveNetworkAccess(submission.requested),
}) as PermissionObservation;
const prior = (
  revision: number,
  sandbox: PermissionSelection["requested"]["sandbox"],
  turn: string,
): PermissionObservation => ({
  revision, requested: { sandbox, network_access: false }, execution_id: "exec-" + turn,
  session_id: "session", turn_id: turn, permission: { sandbox, approval: "on-request", enforcement: "os" },
  network_access: false,
});
const pending = (
  control: PermissionSelection,
  history?: PermissionObservation,
): PermissionSyncMessage => ({
  version: "0", next: control,
  control: { ...control, constraints: { approval: "on-request", enforcement: "os" }, status: "pending",
    ...(history ? { last_effective: history } : {}) },
});
describe("server-authoritative Grok permissions", () => {
  it("publishes revision zero only after negotiation", () => {
    const state = createPermissionState(launch, false);
    expect(state.latest).toBeNull();
    expect(setPermissionSyncSupport(state, true).latest).toEqual({ ...launch,
      constraints: { approval: "on-request", enforcement: "os" }, status: "pending" });
  });
  it("keeps the raw launch ceiling and normalizes only observations", () => {
    const ceiling = selection(0, "danger-full-access", false);
    expect(effectiveNetworkAccess(ceiling.requested)).toBe(true);
    expect(withinCeiling(selection(1, "workspace-write", true), ceiling)).toBe(false);
    expect(withinCeiling(selection(1, "read-only", true), selection(0, "workspace-write", false))).toBe(false);
    expect(effectiveNetworkAccess(selection(1, "read-only", true).requested)).toBe(false);
  });
  it("binds outcomes to the captured submission and emits one audit per revision", () => {
    let state = requestPermission(initial(), selection(1));
    const a = capturePermission(state, "a")!;
    state = beginPermissionExecution(state, a);
    state = requestPermission(state, selection(2, "workspace-write", true));
    const applied = permissionObservationApplied(state, observation(a));
    expect(applied.emitAudit).toBe(true);
    state = applied.state;
    expect(state.latest).toMatchObject({ revision: 2, status: "pending" });
    expect(capturePermission(state, "b")).toMatchObject(selection(2, "workspace-write", true));
    expect(permissionObservationApplied(state, observation(a)).emitAudit).toBe(false);
    expect(state.current?.observation?.turn_id).toBe("observed-prompt");
  });
  it.each(["plain", "accepted", "refused"])("handles lane failure with a %s successor", (kind) => {
    let state = requestPermission(initial(), selection(1));
    const a = capturePermission(state, "a")!;
    if (kind !== "plain") state = requestPermission(state, selection(2, "workspace-write", kind === "accepted"),
      kind === "refused" ? "unsupported_permission_pair" : undefined);
    state = permissionLaneFailed(state, a, "load", time);
    expect(state.latest?.revision).toBe(kind === "plain" ? 1 : 2);
    expect(state.latest).not.toHaveProperty("submitted");
    expect(state.latest).not.toHaveProperty("rolled_back_to");
    if (kind === "accepted") {
      expect(state.next?.revision).toBe(2);
      expect(state.gate).toBeNull();
      expect(capturePermission(state, "again")?.revision).toBe(2);
    } else {
      expect(state.next).toBeNull();
      expect(state.gate).toEqual({ status: "blocked", reason: "awaiting_server_next",
        revision: 1, step: "load", since: time });
      expect(capturePermission(state, "blocked")).toBeNull();
      const next = kind === "plain" ? launch : selection(1);
      const control = { ...state.latest!, ...(kind === "plain" ? { rolled_back_to: launch.requested } : {}) };
      state = applyPermissionSyncState(state, { version: "0", control, next } as PermissionSyncMessage, launch, time);
      expect(state.next).toEqual(next);
      expect(state.gate).toBeNull();
      expect(capturePermission(state, "retry")?.revision).toBe(next.revision);
    }
  });
  it("keeps the previous next after refusal and captures it rather than latest", () => {
    let state = requestPermission(initial(), selection(1));
    state = requestPermission(state, selection(2, "workspace-write", false), "unsupported_permission_pair");
    expect(state.latest).toMatchObject({ revision: 2, status: "failed" });
    expect(state.next).toEqual(selection(1));
    expect(capturePermission(state, "a")?.revision).toBe(1);
    expect(state.gate).toBeNull();
  });
  it("blocks missing observations across same-revision sync and recovers on a newer selection", () => {
    let state = requestPermission(initial(), selection(1));
    const a = capturePermission(state, "a")!;
    state = beginPermissionExecution(state, a);
    state = permissionObservationFailed(state, a, time);
    expect(state.latest).toMatchObject({ status: "unknown" });
    expect(state.latest).not.toHaveProperty("effective");
    const sync = { version: "0", control: state.latest!, next: selection(1) } as PermissionSyncMessage;
    state = applyPermissionSyncState(state, sync, launch, time);
    expect(capturePermission(state, "blocked")).toBeNull();
    state = requestPermission(state, selection(2));
    expect(state.gate).toBeNull();
    expect(capturePermission(state, "b")?.revision).toBe(2);
  });
  it("does not block a newer next after an older missing observation", () => {
    let state = requestPermission(initial(), selection(1));
    const a = capturePermission(state, "a")!;
    state = beginPermissionExecution(state, a);
    state = requestPermission(state, selection(2, "workspace-write", true));
    state = permissionObservationFailed(state, a, time);
    expect(state.gate).toBeNull();
    expect(state.latest).toMatchObject({ revision: 2, status: "pending" });
    expect(state.current?.status).toBe("unknown");
  });
  it("refuses an over-ceiling sync until a valid server value arrives", () => {
    let state = initial();
    state = applyPermissionSyncState(state, { version: "0", control: state.latest!, next: launch }, selection(0), time);
    expect(state.next).toBeNull();
    expect(state.gate).toMatchObject({ reason: "awaiting_server_next", step: "next_over_ceiling" });
    state = requestPermission(state, selection(1));
    expect(state.next).toEqual(selection(1));
    expect(state.gate).toBeNull();
  });
  it("adopts revision-zero history while the control stays pending", () => {
    const state = initial();
    const history = prior(4, "read-only", "restart");
    const next = state.next;
    const synced = applyPermissionSyncState(state, pending(launch, history), launch, time);
    expect(synced.current).toBeNull();
    expect(synced.lastEffective).toEqual(history);
    expect(synced.latest).toMatchObject({ revision: 0, status: "pending", last_effective: history });
    expect(synced.latest?.requested).toEqual(state.latest?.requested);
    expect(synced.latest).not.toHaveProperty("submitted");
    expect(synced.latest).not.toHaveProperty("effective");
    expect(synced.next).toEqual(next);
    expect(capturePermission(synced, "a")).toEqual(capturePermission(state, "a"));
    expect([...synced.appliedRevisions]).toEqual([]);
  });
  it("leaves history null when the sync has none", () => {
    const state = initial();
    const synced = applyPermissionSyncState(state, pending(launch), launch, time);
    expect(synced.lastEffective).toBeNull();
    expect(synced.latest).not.toHaveProperty("last_effective");
    expect(synced.current).toBeNull();
  });
  it("keeps an applying execution when a newer history arrives", () => {
    let state = applyPermissionSyncState(initial(), pending(launch, prior(1, "read-only", "older")), launch, time);
    state = requestPermission(state, selection(2, "workspace-write", true));
    const submission = capturePermission(state, "a")!;
    state = beginPermissionExecution(state, submission);
    const newer = prior(4, "danger-full-access", "newer");
    const kept = state.lastEffective;
    const current = state.current;
    const gate = state.gate;
    state = applyPermissionSyncState(state, pending(selection(2, "workspace-write", true), newer), launch, time);
    expect(state.current).toEqual(current);
    expect(state.current?.status).toBe("applying");
    expect(state.current?.observation).toBeNull();
    expect(state.lastEffective).toEqual(kept);
    expect(state.latest?.last_effective).toEqual(kept);
    expect(state.latest?.status).toBe("applying");
    expect(state.gate).toEqual(gate);
  });
  it("keeps an unknown execution when a newer history arrives", () => {
    let state = applyPermissionSyncState(initial(), pending(launch, prior(1, "read-only", "older")), launch, time);
    state = requestPermission(state, selection(2, "workspace-write", true));
    const submission = capturePermission(state, "a")!;
    state = beginPermissionExecution(state, submission);
    state = permissionObservationFailed(state, submission, time);
    const kept = state.lastEffective;
    const gate = state.gate;
    state = applyPermissionSyncState(state, pending(selection(2, "workspace-write", true),
      prior(5, "read-only", "newest")), launch, time);
    expect(state.current?.status).toBe("unknown");
    expect(state.current?.observation).toBeNull();
    expect(state.lastEffective).toEqual(kept);
    expect(state.latest?.last_effective).toEqual(kept);
    expect(state.latest?.status).toBe("unknown");
    expect(state.gate).toEqual(gate);
    expect(capturePermission(state, "blocked")).toBeNull();
  });
  it("keeps a newer request ahead of a stale sync", () => {
    let state = requestPermission(initial(), selection(3, "workspace-write", true));
    state = applyPermissionSyncState(state, pending(launch, prior(2, "read-only", "stale")), launch, time);
    expect(state.current).toBeNull();
    expect(state.lastEffective).toBeNull();
    expect(state.latest).toMatchObject({ revision: 3, status: "pending" });
    expect(state.latest).not.toHaveProperty("last_effective");
  });
  it("replaces history only when the incoming revision is newer", () => {
    let state = applyPermissionSyncState(initial(), pending(launch, prior(3, "read-only", "first")), launch, time);
    const first = state.lastEffective;
    state = applyPermissionSyncState(state, pending(launch, prior(3, "danger-full-access", "second")), launch, time);
    expect(state.lastEffective).toEqual(first);
    expect(state.latest?.last_effective).toEqual(first);
    const third = prior(6, "workspace-write", "third");
    state = applyPermissionSyncState(state, pending(launch, third), launch, time);
    expect(state.lastEffective).toEqual(third);
    expect(state.latest?.last_effective).toEqual(third);
    expect(state.latest).toMatchObject({ revision: 0, status: "pending" });
  });
  it("still audits the first observation of a backfilled revision", () => {
    let state = requestPermission(initial(), selection(2));
    state = applyPermissionSyncState(state, pending(selection(2), prior(2, "read-only", "prior")), launch, time);
    expect(state.appliedRevisions.has(2)).toBe(false);
    const submission = capturePermission(state, "live")!;
    state = beginPermissionExecution(state, submission);
    expect(permissionObservationApplied(state, observation(submission)).emitAudit).toBe(true);
  });
});
