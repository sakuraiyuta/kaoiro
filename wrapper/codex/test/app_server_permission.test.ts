import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PermissionSelection } from "@kaoiro/protocol";
import { assessCodexPermission, captureAppServerPermission, observeAppServerPermission } from "../src/app_server_permission.js";
import { beginPermissionExecution, createPermissionState, permissionObservationApplied, projectPermissionState, requestPermission } from "../src/permission_state.js";
import { codexPermissionContextAfter } from "../src/rollout.js";

const selection: PermissionSelection = { revision: 1, requested: { sandbox: "workspace-write", network_access: true } };
const dispatch = { threadId: "session", hostTurnToken: "host" };
const terminal = { ...dispatch, turnId: "turn", requestId: 77 };
const context = (turnId = "turn", network_access = true) => JSON.stringify({ type: "turn_context", payload: {
  turn_id: turnId, approval_policy: "never", sandbox_policy: { type: "workspace-write", network_access },
} });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });vi.useRealTimers(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "fuji-348-permission-"));roots.push(root);
  const path = join(root, "rollout-session.jsonl");writeFileSync(path, context("old") + "\n");
  let state = createPermissionState(selection, true);
  const attempt = captureAppServerPermission(root, state, selection, dispatch);
  state = beginPermissionExecution(state, attempt.submission);
  return { root, path, attempt, get state() { return state; }, set state(value) { state = value; } };
}

it("requires the terminal turn id while preserving exec's omitted-id behavior", async () => {
  const f = setup();appendFileSync(f.path, context("foreign") + "\n");
  expect(codexPermissionContextAfter(f.attempt.cursor, "session")?.turnId).toBe("foreign");
  expect(codexPermissionContextAfter(f.attempt.cursor, "session", "turn")).toBeNull();
  expect(await observeAppServerPermission(f.attempt, terminal, () => f.state)).toEqual({ applied: false, observation: null, reason: "observation_unavailable" });
});

it("captures a separate execution id and accepts compaction repeats without promoting an RPC acknowledgment", async () => {
  const f = setup();expect(f.attempt.submission.execution_id).not.toBe(dispatch.hostTurnToken);
  expect(f.state.current?.status).toBe("applying");
  appendFileSync(f.path, context() + "\n" + context() + "\n");
  expect(await observeAppServerPermission(f.attempt, terminal, () => f.state)).toEqual({ applied: true, observation: {
    ...f.attempt.submission, session_id: "session", turn_id: "turn", permission: { sandbox: "workspace-write", approval: "never", enforcement: "os" }, network_access: true,
  } });
});

it.each(["revision", "axes", "blocked"])("rejects a superseded %s before capturing a submission", kind => {
  const f = setup();
  if (kind === "revision") f.state = requestPermission(f.state, { ...selection, revision: 2 });
  if (kind === "axes") f.state = { ...f.state, next: { ...selection, requested: { ...selection.requested, network_access: false } } };
  if (kind === "blocked") f.state = { ...f.state, blocked: { revision: 1, reason: "policy_mismatch" } };
  expect(() => captureAppServerPermission(f.root, f.state, selection, dispatch)).toThrow(expect.objectContaining({ reason: "permission_superseded" }));
});

it("retains valid current evidence under a newer pending selection and leaves the newer revision pending", async () => {
  const f = setup();appendFileSync(f.path, context() + "\n");
  f.state = requestPermission(f.state, { ...selection, revision: 2 });
  const result = await observeAppServerPermission(f.attempt, terminal, () => f.state);
  expect(result?.applied).toBe(true);if (!result?.applied) throw new Error("Expected observation");
  const applied = permissionObservationApplied(f.state, result.observation);
  expect(applied.emitAudit).toBe(true);
  expect(projectPermissionState(applied.state).control).toMatchObject({ revision: 2, status: "pending", effective: { revision: 1 } });
});

it.each(["execution", "revision", "requested"])("ignores obsolete completion when current %s differs", async kind => {
  const f = setup();appendFileSync(f.path, context() + "\n");
  const submission = { ...f.attempt.submission };
  if (kind === "execution") submission.execution_id = "next";
  if (kind === "revision") submission.revision = 2;
  if (kind === "requested") submission.requested = { sandbox: "read-only", network_access: false };
  f.state = beginPermissionExecution(f.state, submission);
  expect(await observeAppServerPermission(f.attempt, terminal, () => f.state)).toBeNull();
});

it.each(["threadId", "hostTurnToken"] as const)("ignores a terminal with a different %s", key => {
  const f = setup();appendFileSync(f.path, context() + "\n");
  return expect(observeAppServerPermission(f.attempt, { ...terminal, [key]: "other" }, () => f.state)).resolves.toBeNull();
});

it("rechecks execution ownership after a delayed flush and accepts a completed partial record", async () => {
  vi.useFakeTimers();const f = setup();appendFileSync(f.path, context());
  const waiting = observeAppServerPermission(f.attempt, terminal, () => f.state);
  await vi.advanceTimersByTimeAsync(25);appendFileSync(f.path, "\n");
  await vi.advanceTimersByTimeAsync(25);expect((await waiting)?.applied).toBe(true);
  const second = setup();const obsolete = observeAppServerPermission(second.attempt, terminal, () => second.state);
  second.state = beginPermissionExecution(second.state, { ...second.attempt.submission, execution_id: "next" });
  appendFileSync(second.path, context() + "\n");await vi.advanceTimersByTimeAsync(25);
  expect(await obsolete).toBeNull();
});

it("never chooses a latest context among conflicting fresh evidence", async () => {
  const f = setup();appendFileSync(f.path, context() + "\n" + context("turn", false) + "\n");
  expect(await observeAppServerPermission(f.attempt, terminal, () => f.state)).toMatchObject({ reason: "observation_unavailable" });
});

it("shares exec's exact observation, diagnostic and failure vocabulary", () => {
  const f = setup();const observed = { sessionId: "session", turnId: "turn", sandbox: "workspace-write" as const, networkAccess: true, approvalPolicy: "on-request" };
  expect(assessCodexPermission(f.attempt.submission, observed)).toEqual({ applied: false, reason: "approval_policy_mismatch", observation: {
    ...f.attempt.submission, session_id: "session", turn_id: "turn", permission: { sandbox: "workspace-write", approval: "on-request", enforcement: "os" }, network_access: true,
  }, diagnostic: "codex: permission policy mismatch: expected approval=never; observed approval=on-request\n" });
  expect(assessCodexPermission(f.attempt.submission, { ...observed, approvalPolicy: "future" })).toMatchObject({ observation: null, reason: "approval_policy_mismatch" });
  expect(assessCodexPermission(f.attempt.submission, { ...observed, approvalPolicy: "never", networkAccess: false })).toMatchObject({ reason: "policy_mismatch",
    diagnostic: "codex: permission policy mismatch: expected sandbox=workspace-write network_access=true; observed sandbox=workspace-write network_access=false\n" });
});

it("requires explicit fresh-thread provenance when no rollout exists at dispatch", async () => {
  const f = setup();rmSync(f.path);
  const resumed = captureAppServerPermission(f.root, f.state, selection, dispatch);
  const fresh = captureAppServerPermission(f.root, f.state, selection, dispatch, true);
  writeFileSync(f.path, context() + "\n");
  f.state = beginPermissionExecution(f.state, resumed.submission);
  expect(await observeAppServerPermission(resumed, terminal, () => f.state)).toMatchObject({ reason: "observation_unavailable" });
  f.state = beginPermissionExecution(f.state, fresh.submission);
  expect((await observeAppServerPermission(fresh, terminal, () => f.state))?.applied).toBe(true);
});
