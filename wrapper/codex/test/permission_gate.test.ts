import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionControlExt, PermissionSelection } from "@kaoiro/protocol";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexHost, DEFAULT_PERMISSION_GATE_TIMEOUT_MS } from "../src/host.js";
import type { CodexHostOptions, CodexLifecycleEvent } from "../src/host.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
const selected: PermissionSelection = {
  revision: 4, requested: { sandbox: "read-only", network_access: false },
};
function unknown(selection = selected): PermissionControlExt {
  return { ...selection, status: "unknown", reason: "observation_unavailable",
    submitted: { ...selection, execution_id: "unknown-execution" },
    constraints: { approval: "never", enforcement: "os" } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function harness(extra: Partial<CodexHostOptions> & { repeats?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "fuji340-gate-"));
  const path = join(root, "rollout-gate-session.jsonl");
  await writeFile(path, "");
  const start = vi.fn();
  const end = vi.fn();
  const finalized = vi.fn();
  const lifecycle: CodexLifecycleEvent[] = [];
  let calls = 0;
  const host = new CodexHost({ agent_id: "gate.agent", display_name: "Gate",
    persona: { id: "gate", name: "Gate", sprite_set: "gate" },
    server_url: "ws://localhost:1/wrapper", sandbox: "read-only", network_access: false,
  }, {
    appendSystemPrompt: "test", onState: () => {},
    onTurnStart: start, onTurnEnd: end, onTurnFinalized: finalized,
    onLifecycle: (event) => lifecycle.push(event),
    resumeSessionId: "gate-session", permissionRolloutRoot: root,
    permissionSyncSupported: true, permissionGateTimeoutMs: 150,
    turnTraceDir: join(root, "traces"), rateLimitResolver: async () => new Map(),
    codexFactory: () => {
      const thread = { async runStreamed() {
        calls++;
        await appendFile(path, (JSON.stringify({ type: "turn_context", payload: {
          turn_id: `turn-${calls}`, approval_policy: "never", sandbox_policy: { type: "read-only" },
        } }) + "\n").repeat(extra.repeats ?? 1));
        return { events: (async function* (): AsyncGenerator<ThreadEvent> {
          yield { type: "thread.started", thread_id: "gate-session" };
          yield { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0,
            reasoning_output_tokens: 0, cache_write_input_tokens: 0 } };
        })() };
      } };
      return { startThread: () => thread, resumeThread: () => thread };
    }, ...extra,
  });
  host.applyPermissionSync({ version: "0", control: unknown(), next: selected });
  const running = host.run();
  cleanup.push(async () => { host.close(); await running; await rm(root, { recursive: true, force: true }); });
  const send = (token = "blocked-token") => host.send("instruction", undefined, ["conversation-a"], token);
  return { host, send, start, end, finalized, lifecycle, calls: () => calls };
}
const waiting = (h: Awaited<ReturnType<typeof harness>>) => vi.waitFor(() => expect(h.host.state).toBe("waiting_permission"), { interval: 5 });

describe("unstarted permission dispatch", () => {
  it("bounds repeated same-revision sync by one deadline and cancels exactly once without SDK acknowledgement", async () => {
    expect(DEFAULT_PERMISSION_GATE_TIMEOUT_MS).toBe(30_000);
    const h = await harness();
    await h.send(); await waiting(h);
    const repeat = setInterval(() => h.host.applyPermissionSync({ version: "0", control: unknown(), next: selected }), 20);
    try {
      await vi.waitFor(() => expect(h.end).toHaveBeenCalledTimes(1), { timeout: 600, interval: 5 });
      expect(h.end).toHaveBeenCalledWith({ turnToken: "blocked-token", conversationIds: ["conversation-a"],
        error: { reason: "permission_gate_blocked", detail: expect.stringContaining("same sandbox/network") },
        cancellation: { kind: "permission_gate", started: false } });
      expect(h.host.state).toBe("waiting_input");
      expect(h.calls()).toBe(0); expect(h.start).not.toHaveBeenCalled();
      expect(h.finalized).toHaveBeenCalledTimes(1);
      expect(h.finalized).toHaveBeenCalledWith({ turnToken: "blocked-token" });
      expect(h.host.statusExtSnapshot()).toMatchObject({ permission_control: { status: "unknown", revision: 4 } });
      expect(h.lifecycle.map((e) => e.kind)).toEqual(["permission_gate_blocked", "permission_gate_timeout"]);
      // Recovery cannot resurrect the cancelled input.
      await h.host.setPermission({ ...selected, revision: 5 });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(h.calls()).toBe(0);
      await h.send("resend-token");
      await vi.waitFor(() => expect(h.finalized).toHaveBeenCalledTimes(2));
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(h.start).toHaveBeenCalledWith({ turnToken: "resend-token", conversationIds: ["conversation-a"] });
    } finally { clearInterval(repeat); }
  });

  it.each(["interrupt", "close"] as const)("%s wakes the unstarted gate without waiting for its timeout", async (action) => {
    const h = await harness({ permissionGateTimeoutMs: 10_000 });
    await h.send(); await waiting(h);
    await h.host[action]();
    await vi.waitFor(() => expect(h.end).toHaveBeenCalledTimes(1), { timeout: 500, interval: 5 });
    expect(h.end.mock.calls[0]![0]).toMatchObject({ error: { reason: "interrupted" }, cancellation: { started: false } });
    expect(h.finalized).toHaveBeenCalledTimes(1); expect(h.start).not.toHaveBeenCalled(); expect(h.calls()).toBe(0);
  });

  it.each(["relay", "sync"] as const)("a newer identical selection via %s releases only after current sync readiness", async (route) => {
    let barrier = Promise.resolve();
    const h = await harness({ waitForPermissionSync: () => barrier, permissionGateTimeoutMs: 1500 });
    await h.send(); await waiting(h);
    const rejoin = deferred(); barrier = rejoin.promise;
    const next = { ...selected, revision: 5 };
    if (route === "relay") await h.host.setPermission(next);
    else h.host.applyPermissionSync({ version: "0", next, control: { ...next, status: "pending", constraints: { approval: "never", enforcement: "os" } } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.calls()).toBe(0);
    rejoin.resolve();
    await vi.waitFor(() => expect(h.finalized).toHaveBeenCalledTimes(1));
    expect(h.calls()).toBe(1); expect(h.end.mock.calls[0]![0]).not.toHaveProperty("cancellation");
    expect(h.lifecycle.map((e) => e.kind)).toContain("permission_gate_released");
  });

  it("a rejoin during diagnostics cancels the never-started token and releases its finalization", async () => {
    let host!: CodexHost;
    const h = await harness({ afterDiagnosticsBegin: async () => {
      host.applyPermissionSync({ version: "0", next: { ...selected, revision: 5 }, control: unknown({ ...selected, revision: 5 }) });
    } });
    host = h.host;
    await host.setPermission({ ...selected, revision: 5 });
    await h.send();
    await vi.waitFor(() => expect(h.finalized).toHaveBeenCalledTimes(1));
    expect(h.end.mock.calls[0]![0]).toMatchObject({ cancellation: { started: false } });
    expect(h.calls()).toBe(0); expect(h.start).not.toHaveBeenCalled();
  });
});


describe("permission gate lifetime boundaries", () => {
  it("repeated consistent contexts settle applied and admit a successor without a new revision", async () => {
    const h = await harness({ repeats: 3 });
    await h.host.setPermission({ ...selected, revision: 5 });
    await h.send("first");
    await vi.waitFor(() => expect(h.finalized).toHaveBeenCalledTimes(1));
    expect(h.host.statusExtSnapshot()).toMatchObject({ permission_control: { revision: 5, status: "applied" } });
    await h.send("second");
    await vi.waitFor(() => expect(h.finalized).toHaveBeenCalledTimes(2));
    expect(h.calls()).toBe(2);
    expect(h.lifecycle.map((e) => e.kind)).not.toContain("permission_gate_blocked");
  });

  it("keeps an unconfirmed launch baseline blocked after the dispatch cancellation", async () => {
    // A fresh Host is needed: an older baseline cannot replace revision 4.
    // Its resume snapshot deliberately has no prior operator request.
    const baseline = { ...selected, revision: 0 };
    const root = await mkdtemp(join(tmpdir(), "fuji340-rev0-"));
    const finalized = vi.fn();
    const host = new CodexHost({ agent_id: "baseline", display_name: "Baseline",
      persona: { id: "p", name: "P", sprite_set: "p" }, server_url: "ws://localhost:1/wrapper",
      sandbox: "read-only", network_access: false,
    }, { onState: () => {}, appendSystemPrompt: "test", permissionSyncSupported: true,
      permissionGateTimeoutMs: 40, turnTraceDir: root, onTurnFinalized: finalized,
      codexFactory: () => ({ startThread: () => { throw new Error("must stay blocked"); },
        resumeThread: () => { throw new Error("must stay blocked"); } }),
    });
    host.applyPermissionSync({ version: "0", next: baseline, control: unknown(baseline) });
    const running = host.run("baseline input");
    try {
      await vi.waitFor(() => expect(finalized).toHaveBeenCalledTimes(1));
      expect(host.state).toBe("waiting_input");
      expect(host.statusExtSnapshot()).toMatchObject({ permission_control: { revision: 0, status: "unknown" } });
    } finally { host.close(); await running; await rm(root, { recursive: true, force: true }); }
  });

  it("cleans a materialized image when its dequeued turn times out before SDK start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fuji340-image-"));
    const image = join(dir, "image.png"); await writeFile(image, "image");
    const h = await harness({ materializeImages: async () => ({ dir, paths: [image] }) });
    h.host.attachOpen({ upload_id: "image", filename: "image.png", mime: "image/png", size: 1, chunks: 1 });
    const id = new TextEncoder().encode("image");
    const chunk = new Uint8Array(4 + id.length + 4 + 1);
    new DataView(chunk.buffer).setUint32(0, id.length, false); chunk.set(id, 4); chunk[chunk.length - 1] = 1;
    h.host.attachChunk(chunk); h.host.attachClose("image");
    try {
      await h.host.send("with image", ["image"], [], "image-token");
      await waiting(h);
      expect(await stat(image)).toBeDefined();
      await vi.waitFor(() => expect(h.finalized).toHaveBeenCalledTimes(1));
      await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(h.calls()).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("permission gate during an already-started repair retry", () => {
  it("keeps settlement and finalization with the outer started turn", async () => {
    let host!: CodexHost;
    const runStreamed = vi.fn(async () => { throw new Error("stream did not contain valid UTF-8 (code -32603)"); });
    const h = await harness({
      permissionGateTimeoutMs: 40,
      codexFactory: () => ({ startThread: () => ({ runStreamed }), resumeThread: () => ({ runStreamed }) }),
      rolloutCorruptionVerifier: () => "corrupted",
      rolloutCorruptionRepairer: () => {
        const next = { ...selected, revision: 5 };
        host.applyPermissionSync({ version: "0", next, control: unknown(next) });
        return { repaired: true, backupPath: "/unused/fixture-repair-backup" };
      },
    });
    host = h.host;
    await host.setPermission({ ...selected, revision: 5 });
    await h.send("repair-token");
    await vi.waitFor(() => expect(h.finalized).toHaveBeenCalledTimes(1));
    expect(h.start).toHaveBeenCalledTimes(1); expect(runStreamed).toHaveBeenCalledTimes(1);
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.end.mock.calls[0]![0]).not.toHaveProperty("cancellation");
    expect(h.end.mock.calls[0]![0]).toMatchObject({ error: { reason: "permission_gate_blocked" } });
  });
});
