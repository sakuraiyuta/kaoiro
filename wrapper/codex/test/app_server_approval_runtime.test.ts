import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionSelection, PermissionSubmission } from "@kaoiro/protocol";
import { AppServerHostRuntime, type AppServerHostSession, type AppServerRuntimeHooks } from "../src/app_server_host_runtime.js";
import { assessCodexPermission } from "../src/app_server_permission.js";
import { appServerTurnSettings, type AppServerTurnSettings } from "../src/app_server_settings.js";
import type { AppServerProjection } from "../src/app_server_projection.js";
import {
  beginPermissionExecution, createPermissionState, permissionObservationApplied, requestPermission,
  type PermissionState,
} from "../src/permission_state.js";

// Submission and assessment of the approval axis (ADR-0064): the value in
// turn/start is the captured selection, only while the axis is advertised.

const roots: string[] = [], runtimes: AppServerHostRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(r => r.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const observed = { sessionId: "s", turnId: "t", sandbox: "workspace-write" as const, networkAccess: false };
function submission(approval?: "untrusted" | "on-request" | "never"): PermissionSubmission {
  return { revision: 2, requested: { sandbox: "workspace-write", network_access: false, ...(approval === undefined ? {} : { approval }) }, execution_id: "e" };
}

describe("assessCodexPermission against the submitted approval", () => {
  it("applies when the observed policy equals the submitted one", () => {
    expect(assessCodexPermission(submission("on-request"), { ...observed, approvalPolicy: "on-request" })).toMatchObject({ applied: true });
    expect(assessCodexPermission(submission(), { ...observed, approvalPolicy: "never" })).toMatchObject({ applied: true });
  });

  it("is an approval_policy_mismatch otherwise, naming the submitted value", () => {
    expect(assessCodexPermission(submission("on-request"), { ...observed, approvalPolicy: "never" })).toMatchObject({
      applied: false, reason: "approval_policy_mismatch",
      diagnostic: "codex: permission policy mismatch: expected approval=on-request; observed approval=never\n",
    });
    expect(assessCodexPermission(submission(), { ...observed, approvalPolicy: "untrusted" })).toMatchObject({ reason: "approval_policy_mismatch" });
  });
});

function fixture(approvalAxis: boolean, requestedApproval?: "untrusted" | "on-request" | "never") {
  const root = mkdtempSync(join(tmpdir(), "kuroe367-runtime-"));roots.push(root);
  const path = join(root, "rollout-thread.jsonl");
  writeFileSync(path, "");
  const baseline: PermissionSelection = { revision: 1, requested: { sandbox: "workspace-write", network_access: false } };
  let permission: PermissionState = createPermissionState(baseline, true);
  permission = requestPermission(permission, { revision: 2, requested: { ...baseline.requested, ...(requestedApproval === undefined ? {} : { approval: requestedApproval }) } });
  const settingsSeen: AppServerTurnSettings[] = [];
  const afterDispatch: Array<() => void> = [];
  const session: AppServerHostSession = {
    initialSettings: { model: "m", effort: "low" },
    readHistory: vi.fn(async () => ({ coverage: "full" as const, logs: [] })),
    startThread: vi.fn(async () => "thread"), resumeThread: vi.fn(async () => "thread"),
    interrupt: vi.fn(async () => true), close: vi.fn(async () => {}),
    startProjectedTurn: vi.fn(async request => {
      const settings = await appServerTurnSettings(request.settings ?? {}, async () => ({}));
      request.onDispatch?.(request, settings);
      for (const hook of afterDispatch.splice(0)) hook();
      settingsSeen.push(request.settings!);
      // Codex honours the policy it is given.
      const written = request.settings?.permission?.approval ?? "never";
      appendFileSync(path, JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-1", approval_policy: written,
        sandbox_policy: { type: "workspace-write", network_access: false } } }) + "\n");
      return { identity: { threadId: "thread", turnId: "turn-1", hostTurnToken: request.hostTurnToken, requestId: 1 }, usage: null,
        events: (async function* (): AsyncGenerator<AppServerProjection> {
          yield { kind: "result", status: "completed", payload: { text: "DONE", is_error: false } };
        })() };
    }),
  };
  const runtime = new AppServerHostRuntime({ session: { turnSignal: () => null }, effortIntent: "explicit", rolloutRoot: root,
    approvalAxis, createSession: vi.fn(async () => session) });
  runtimes.push(runtime);
  const hooks: AppServerRuntimeHooks = {
    snapshot: () => ({ pending: { model: null, effort: null, effortReset: false }, permission }),
    waitForPermissionSync: vi.fn(async () => {}),
    onDispatch: vi.fn(attempt => { if (attempt.permission) permission = beginPermissionExecution(permission, attempt.permission.submission); }),
    onPermission: vi.fn(result => { if (result.applied) permission = permissionObservationApplied(permission, result.observation).state; }),
    onProjection: vi.fn(),
  };
  return { runtime, hooks, settingsSeen, afterDispatch,
    get permission() { return permission; }, set permission(value) { permission = value; } };
}

describe("AppServerHostRuntime approval submission", () => {
  it("submits and assesses the selected approval when the axis is advertised", async () => {
    const f = fixture(true, "on-request");
    const result = await f.runtime.run({ input: "x", hostTurnToken: "h" }, f.hooks);
    expect(f.settingsSeen[0]!.permission).toEqual({ sandbox: "workspace-write", networkAccess: false, approval: "on-request" });
    expect(result.attempt.permission!.submission.requested.approval).toBe("on-request");
    expect(result.permission).toMatchObject({ applied: true, observation: { permission: { approval: "on-request" } } });
  });

  it("drops a requested approval when the axis is not advertised, so the turn stays never", async () => {
    const f = fixture(false, "on-request");
    const result = await f.runtime.run({ input: "x", hostTurnToken: "h" }, f.hooks);
    expect(f.settingsSeen[0]!.permission).toEqual({ sandbox: "workspace-write", networkAccess: false });
    expect(result.attempt.permission!.submission.requested.approval).toBeUndefined();
    expect(result.permission).toMatchObject({ applied: true, observation: { permission: { approval: "never" } } });
  });

  it("keeps the dispatched turn's approval when the selection changes after dispatch", async () => {
    const f = fixture(true, "never");
    f.afterDispatch.push(() => {
      f.permission = requestPermission(f.permission, { revision: 3, requested: { sandbox: "workspace-write", network_access: false, approval: "on-request" } });
    });
    const result = await f.runtime.run({ input: "x", hostTurnToken: "h" }, f.hooks);
    expect(f.settingsSeen[0]!.permission!.approval).toBe("never");
    expect(result.attempt.permission!.submission.requested.approval).toBe("never");
  });
});
