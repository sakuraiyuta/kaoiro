import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import type {
  PermissionControlExt,
  PermissionObservation,
  PermissionSelection,
  WrapperPermissionLifecycleMessage,
} from "@kaoiro/protocol";
import { CodexHost } from "../src/host.js";
import type { CodexClientLike, CodexHostOptions, CodexThreadLike } from "../src/host.js";
import { effectiveNetworkAccess } from "../src/network_access.js";

const SESSION_ID = "permission-boundary-session";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function selection(
  revision: number,
  sandbox: PermissionSelection["requested"]["sandbox"] = "workspace-write",
  network_access = true,
): PermissionSelection {
  return { revision, requested: { sandbox, network_access } };
}

function priorObservation(selected: PermissionSelection): PermissionObservation {
  return {
    ...selected,
    execution_id: "prior-process-execution",
    session_id: SESSION_ID,
    turn_id: "prior-process-turn",
    permission: {
      sandbox: selected.requested.sandbox,
      approval: "never",
      enforcement: "os",
    },
    network_access: effectiveNetworkAccess(
      selected.requested.sandbox,
      selected.requested.network_access,
    ),
  };
}

function pending(selected: PermissionSelection): PermissionControlExt {
  return {
    ...selected,
    constraints: { approval: "never", enforcement: "os" },
    status: "pending",
  };
}

function applied(selected: PermissionSelection): PermissionControlExt {
  return {
    ...selected,
    constraints: { approval: "never", enforcement: "os" },
    status: "applied",
    submitted: { ...selected, execution_id: "prior-process-execution" },
    effective: priorObservation(selected),
  };
}

function rejected(
  selected: PermissionSelection,
  previous: PermissionSelection,
  lastEffective?: PermissionObservation,
): PermissionControlExt {
  return {
    ...selected,
    constraints: { approval: "never", enforcement: "os" },
    status: "failed",
    reason: "rejected_before_application",
    rolled_back_to: previous.requested,
    ...(lastEffective === undefined ? {} : { last_effective: lastEffective }),
  };
}

async function createHarness(options: {
  writeContext?: boolean;
  observedNetwork?: boolean;
  host?: Pick<CodexHostOptions, "resumeSnapshot" | "waitForPermissionSync">;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "kaoiro-permission-boundaries-"));
  const rollout = join(root, `rollout-${SESSION_ID}.jsonl`);
  function context(turnId: string, sandbox: string, network: boolean): string {
    return JSON.stringify({
      type: "turn_context",
      payload: {
        turn_id: turnId,
        approval_policy: "never",
        sandbox_policy: { type: sandbox, network_access: network },
      },
    }) + "\n";
  }
  await writeFile(rollout, context("prior-process-turn", "read-only", false));
  let sdkCalls = 0;
  let running: Promise<void> | undefined;
  let releaseCleanupWait = () => {};
  const threadOptions: ThreadOptions[] = [];
  const audits: WrapperPermissionLifecycleMessage[] = [];
  const thread: CodexThreadLike = {
    async runStreamed() {
      sdkCalls += 1;
      if (options.writeContext !== false) {
        await appendFile(rollout, context(
          `current-turn-${sdkCalls}`,
          "workspace-write",
          options.observedNetwork ?? true,
        ));
      }
      async function* events(): AsyncGenerator<ThreadEvent> {
        yield { type: "thread.started", thread_id: SESSION_ID };
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            cache_write_input_tokens: 0,
          },
        };
      }
      return { events: events() };
    },
  };
  const captureOptions = (value?: ThreadOptions): CodexThreadLike => {
    if (value !== undefined) threadOptions.push(value);
    return thread;
  };
  const client: CodexClientLike = {
    startThread: captureOptions,
    resumeThread: (_id, value) => captureOptions(value),
  };
  const host = new CodexHost({
    agent_id: "permission.boundary",
    display_name: "Permission boundary",
    persona: { id: "p", name: "P", sprite_set: "p" },
    server_url: "ws://localhost:4000/wrapper",
    sandbox: "read-only",
    network_access: false,
  }, {
    onState: () => {},
    appendSystemPrompt: "p",
    codexFactory: () => client,
    resumeSessionId: SESSION_ID,
    permissionRolloutRoot: root,
    permissionSyncSupported: true,
    turnTraceDir: join(root, "traces"),
    onPermissionLifecycle: (event) => audits.push(event),
    ...options.host,
  });
  cleanups.push(async () => {
    host.close();
    releaseCleanupWait();
    try {
      await running;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    host,
    audits,
    threadOptions,
    get sdkCalls() { return sdkCalls; },
    ext: () => host.statusExtSnapshot(),
    run() {
      running = host.run("first");
      return running;
    },
    setCleanupRelease(release: () => void) { releaseCleanupWait = release; },
  };
}

async function expectStatus(
  harness: Awaited<ReturnType<typeof createHarness>>,
  status: PermissionControlExt["status"],
): Promise<void> {
  await vi.waitFor(() => expect(harness.ext()).toMatchObject({
    permission_control: { status },
  }));
}

describe("permission state boundaries", () => {
  it("observes a matching selection with one audit and no intentional drift", async () => {
    const h = await createHarness({ host: {
      resumeSnapshot: { sandbox: "read-only", network_access: false },
    } });
    await h.host.setPermission(selection(1));
    void h.run();
    await expectStatus(h, "applied");
    expect(h.ext()).toMatchObject({
      permission: { sandbox: "workspace-write", approval: "never" },
      resume_drift: [],
    });
    expect(h.audits.filter(e => e.kind === "permission_applied")).toHaveLength(1);
  });

  it("uses authoritative prior next after an already selected request is rejected", async () => {
    const h = await createHarness();
    const request = selection(2);
    const baseline = selection(0, "read-only", false);
    await h.host.setPermission(request);
    h.host.applyPermissionSync({
      version: "0", control: rejected(request, baseline), next: baseline,
    });
    void h.run();
    await vi.waitFor(() => expect(h.threadOptions).toHaveLength(1));
    expect(h.threadOptions[0]?.sandboxMode).toBe("read-only");
  });

  it("keeps a prior process observation historical before the first exec", async () => {
    const h = await createHarness();
    const request = selection(1);
    h.host.applyPermissionSync({ version: "0", control: applied(request), next: request });
    expect(h.sdkCalls).toBe(0);
    expect(h.ext().permission).toBeUndefined();
    expect(h.ext().permission_control).not.toHaveProperty("effective");
  });

  it("does not regress a settled revision on delayed same-revision pending sync", async () => {
    const h = await createHarness();
    const request = selection(1);
    await h.host.setPermission(request);
    void h.run();
    await expectStatus(h, "applied");
    h.host.applyPermissionSync({ version: "0", control: pending(request), next: request });
    expect(h.ext()).toMatchObject({ permission_control: { status: "applied" } });
  });

  it("does not fabricate launch permissions when an unknown observation loses capability", async () => {
    const h = await createHarness({ writeContext: false });
    await h.host.setPermission(selection(1));
    void h.run();
    await expectStatus(h, "unknown");
    h.host.setPermissionSyncSupported(false);
    expect(h.ext().permission).toBeUndefined();
    expect(h.ext().effective).not.toHaveProperty("sandbox");
  });

  it("rejects a live revision older than the latest failed request", async () => {
    const h = await createHarness();
    const baseline = selection(0, "read-only", false);
    h.host.applyPermissionSync({
      version: "0", control: rejected(selection(2), baseline), next: baseline,
    });
    await h.host.setPermission(selection(1));
    expect(h.ext()).toMatchObject({ permission_control: { revision: 2 } });
  });

  it("excludes matching sandbox intent independently of mismatched network", async () => {
    const h = await createHarness({ observedNetwork: false, host: {
      resumeSnapshot: { sandbox: "read-only", network_access: true },
    } });
    await h.host.setPermission(selection(1));
    void h.run();
    await expectStatus(h, "failed");
    expect(h.ext()).toMatchObject({ permission: { sandbox: "workspace-write" } });
    const drift = h.ext().resume_drift as Array<{ field: string }>;
    expect(drift.map(entry => entry.field)).toEqual(["network_access"]);
  });

  it("close cancels the sync wait reached after waking a blocked dispatch", async () => {
    let gate: Promise<void> = Promise.resolve();
    let release = () => {};
    const h = await createHarness({ writeContext: false, host: {
      waitForPermissionSync: () => gate,
    } });
    h.setCleanupRelease(() => release());
    await h.host.setPermission(selection(1));
    const running = h.run();
    await expectStatus(h, "unknown");
    await h.host.send("second");
    await new Promise(resolve => setTimeout(resolve, 20));
    gate = new Promise<void>(resolve => { release = resolve; });
    h.host.close();
    const finished = await Promise.race([
      running.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
    ]);
    expect(finished).toBe(true);
    expect(h.sdkCalls).toBe(1);
  });

  it("does not re-audit prior applied next after a rejected successor and restart", async () => {
    const h = await createHarness();
    const previous = selection(1);
    h.host.applyPermissionSync({
      version: "0",
      control: rejected(selection(2, "read-only", false), previous, priorObservation(previous)),
      next: previous,
    });
    void h.run();
    await vi.waitFor(() => expect(h.ext()).toMatchObject({
      permission: { sandbox: "workspace-write" },
    }));
    expect(h.audits.filter(e => e.kind === "permission_applied")).toHaveLength(0);
  });
});
