import "../../../scripts/test/fixtures/test-isolation.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { GrokHost, type GrokHostOptions } from "../src/host.js";

// An interrupt asks Grok to kill the background tasks of the cancelled turn
// (issue 594), scripted by the fake grok's bg-* scenes and KAOIRO_TEST_GROK_KILL.
const executable = fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url));
const config: WrapperConfig = {
  agent_id: "background-kill-594", display_name: "Background kill", server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  sandbox: "workspace-write", network_access: true,
};
vi.setConfig({ testTimeout: 20_000 });
const hosts: GrokHost[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) { host.close(); await host.closed; }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FAILED = "Could not stop a background task of the interrupted turn";

async function started(env: Record<string, string> = {}, extra: Partial<GrokHostOptions> = {}) {
  const root = mkdtempSync(join(homedir(), ".kaoiro-grok-594-"));
  scratch.push(root);
  const events = join(root, "events.jsonl");
  const envelopes: Envelope[] = [];
  const asked: string[] = [];
  const host = new GrokHost({
    config: { ...config }, cwd: root, personaPrompt: "fixture", executable,
    env: { ...process.env, KAOIRO_TEST_GROK_EVENTS: events, ...env },
    send: (e) => envelopes.push(e),
    decidePermission: async (title) => { asked.push(title); return { allow: true }; },
    ...extra,
  });
  hosts.push(host);
  void host.run().catch(() => {});
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 10_000 });
  const rows = () => existsSync(events)
    ? readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const system = () => envelopes.filter((e) => e.type === "log" && e.payload.kind === "system")
    .map((e) => String(e.payload.text));
  return {
    host, envelopes, asked, rows, system,
    kills: () => rows().filter((r) => r.event === "task_kill").map((r) => r.taskId),
    failures: () => system().filter((text) => text.startsWith(FAILED)),
    results: () => envelopes.filter((e) => e.type === "result"),
  };
}
type Started = Awaited<ReturnType<typeof started>>;
async function interrupted(t: Started, scene: string) {
  const turn = t.host.send(scene);
  void turn.catch(() => {});
  await sleep(200);
  const at = Date.now();
  await t.host.interrupt();
  await turn.catch(() => {});
  return Date.now() - at;
}

describe("kills on interrupt", () => {
  it("asks Grok to kill exactly the interrupted turn's tasks, with the session id", async () => {
    const t = await started();
    await interrupted(t, "bg-two");
    await vi.waitFor(() => expect(t.kills()).toEqual(["t1", "t2"]));
    expect(t.rows().filter((r) => r.event === "_x.ai/task/kill").map((r) => r.sessionId))
      .toEqual(["fixture-session", "fixture-session"]);
    expect(t.results().at(-1)?.ext).toMatchObject({ stop_reason: "cancelled", interrupted: true });
    await sleep(2_300);
    expect(t.failures()).toEqual([]);
  });

  it("never kills an earlier turn's task, even on a late notification for its call", async () => {
    const t = await started();
    await t.host.send("bg-earlier");
    await interrupted(t, "bg-late");
    await vi.waitFor(() => expect(t.kills()).toEqual(["t1"]));
    await sleep(300);
    expect(t.kills()).toEqual(["t1"]);
  });

  it("never kills a task whose call another prompt claimed after it was recorded", async () => {
    const t = await started();
    await interrupted(t, "bg-conflict");
    await vi.waitFor(() => expect(t.kills()).toEqual(["t2"]));
    await sleep(300);
    expect(t.kills()).toEqual(["t2"]);
  });

  it("ignores a task backgrounded in another session", async () => {
    const t = await started();
    await interrupted(t, "bg-other-session");
    await vi.waitFor(() => expect(t.kills()).toEqual(["t2"]));
  });

  it.each([
    ["a cancel the operator did not ask for", "bg-self-cancel", {}, false],
    ["a permission-rejected cancel", "bg-two", { KAOIRO_TEST_GROK_CANCEL_ANSWER: "rejected" }, true],
    ["a turn that ended normally despite the interrupt", "bg-two", { KAOIRO_TEST_GROK_CANCEL_ANSWER: "end_turn" }, true],
  ] as const)("sends no kill after %s", async (_label, scene, env, interrupt) => {
    const t = await started(env);
    if (interrupt) await interrupted(t, scene);
    else await t.host.send(scene);
    await sleep(500);
    expect(t.results()).toHaveLength(1);
    expect(t.kills()).toEqual([]);
  });
});

describe("a kill that fails", () => {
  it("never holds the turn's result, and reports a missing answer after 2 s", async () => {
    const t = await started({ KAOIRO_TEST_GROK_KILL: "hang" });
    expect(await interrupted(t, "bg-two")).toBeLessThan(1_000);
    expect(t.results().at(-1)?.ext).toMatchObject({ interrupted: true });
    expect(t.failures()).toEqual([]);
    await sleep(2_300);
    expect(t.failures()).toEqual([`${FAILED} (no answer within 2 s)`, `${FAILED} (no answer within 2 s)`]);
    expect(t.host.state).toBe("waiting_input");
  });

  it.each([["other", "unexpected answer"], ["error", "the request failed"]])(
    "reports an answer of %s once per task and keeps the result", async (mode, why) => {
      const t = await started({ KAOIRO_TEST_GROK_KILL: mode });
      await interrupted(t, "bg-two");
      await vi.waitFor(() => expect(t.failures()).toEqual([`${FAILED} (${why})`, `${FAILED} (${why})`]));
      expect(t.results().at(-1)?.ext).toMatchObject({ interrupted: true });
      await sleep(2_300);
      expect(t.failures()).toHaveLength(2);
    });

  it("settles once: a failure answered after the deadline adds nothing", async () => {
    const t = await started({ KAOIRO_TEST_GROK_KILL: "late-error" });
    await interrupted(t, "bg-two");
    await sleep(2_900);
    expect(t.failures()).toEqual([`${FAILED} (no answer within 2 s)`, `${FAILED} (no answer within 2 s)`]);
  });

  it("survives Grok exiting with kills pending, and writes nothing after", async () => {
    const t = await started({ KAOIRO_TEST_GROK_KILL: "exit" });
    await interrupted(t, "bg-two");
    await t.host.closed;
    await sleep(2_300);
    expect(t.failures()).toEqual([]);
  });

  it("writes nothing once the host is closed", async () => {
    const t = await started({ KAOIRO_TEST_GROK_KILL: "hang" });
    await interrupted(t, "bg-two");
    const before = t.envelopes.length;
    t.host.close();
    await t.host.closed;
    await sleep(2_300);
    expect(t.envelopes).toHaveLength(before);
  });

  it("writes nothing for a kill pending when the Grok process is replaced", async () => {
    const t = await started({ KAOIRO_TEST_GROK_KILL: "hang" },
      { permissionSyncSupported: true, permissionGateTimeoutMs: 150 });
    const old = t.host.processId;
    await interrupted(t, "bg-two");
    await t.host.setPermission({ revision: 1, requested: { sandbox: "read-only", network_access: false } });
    await t.host.send("after-replace").catch(() => {});
    expect(t.host.processId).not.toBe(old);
    await sleep(2_300);
    expect(t.failures()).toEqual([]);
  });

  // Relies on the ACP SDK rejecting pending requests when the connection
  // closes: the rejection clears the kill's 2 s timer. Uses the built dist.
  it.each(["hang-close", "grok-exit"])(
    "lets the process end soon after close with a kill unanswered (%s)", async (scenario) => {
      const root = mkdtempSync(join(homedir(), ".kaoiro-grok-594x-"));
      scratch.push(root);
      const child = spawn(process.execPath,
        [fileURLToPath(new URL("./fixtures/kill-exit-child.mjs", import.meta.url))],
        { env: { ...process.env, SCENARIO: scenario, KAOIRO_TEST_ROOT: root }, stdio: ["ignore", "pipe", "ignore"] });
      let closedAt = 0;
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (!closedAt && out.includes("closed\n")) closedAt = Date.now();
      });
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
      expect(code).toBe(0);
      expect(closedAt).toBeGreaterThan(0);
      expect(Date.now() - closedAt).toBeLessThan(1_000);
    });
});

describe("the turn Grok starts after a kill", () => {
  it("stays out of the interrupted turn and gets no permission", async () => {
    const t = await started({ KAOIRO_TEST_GROK_KILL_WAKE: "1" });
    await interrupted(t, "bg-two");
    const result = t.results().at(-1)!;
    expect(String(result.payload.text)).toContain("OWN_TEXT");
    expect(String(result.payload.text)).not.toContain("FOREIGN_TEXT");
    await vi.waitFor(() => expect(t.system()).toContain("Grok's own turn ended"));
    const opened = t.envelopes.findIndex((e) => e.type === "log" && e.payload.kind === "system" &&
      String(e.payload.text).startsWith("Grok started a turn on its own"));
    expect(opened).toBeGreaterThan(t.envelopes.indexOf(result));
    expect(t.envelopes.filter((e) => e.type === "permission_request")).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(t.rows().find((r) => r.event === "foreign-permission-response")?.outcome).toBe("cancelled");
    expect(t.kills()).toEqual(["t1", "t2"]);
  });
});
