import "../../../scripts/test/fixtures/test-isolation.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyInterAgentError, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { nonInteractiveToolEnv } from "../src/tool_child_env.js";
import { createTestHost, fakeHookList, hookGroups, type FakeAgy, type TestHost } from "./acp_fake.js";

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    agent_id: "a1",
    persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P",
    server_url: "ws://localhost:4000",
    sandbox: "workspace-write",
    approval: "on-request",
    network_access: false,
    ...overrides,
  } as WrapperConfig;
}

async function waitFor(predicate: () => boolean, diagnostic: () => unknown = () => "", timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out: ${JSON.stringify(diagnostic())}`);
}

interface Recorded {
  test: TestHost;
  states: Envelope[];
  logs: Envelope[];
  acks: string[];
  ends: { turnToken: string; error?: { reason?: string; detail?: string }; cancellation?: unknown; terminal: boolean }[];
  rejected: { turnToken?: string; reason: string }[];
  outOfTurn: { eventKind: string; callId?: string }[];
  progress: string[];
  faults: { reason: string; detail: string }[];
  results(): Record<string, any>[];
}

const hosts: TestHost[] = [];

afterEach(async () => {
  for (const test of hosts.splice(0)) {
    for (const agy of test.agys) agy.exit(0);
    await test.host.close();
  }
});

function setup(overrides: Partial<WrapperConfig> = {}, options: Record<string, unknown> = {}): Recorded {
  const recorded = {
    states: [] as Envelope[],
    logs: [] as Envelope[],
    acks: [] as string[],
    ends: [] as Recorded["ends"],
    rejected: [] as Recorded["rejected"],
    outOfTurn: [] as Recorded["outOfTurn"],
    progress: [] as string[],
    faults: [] as Recorded["faults"],
  } as Recorded;
  recorded.test = createTestHost(config(overrides), {
    onState: (envelope) => recorded.states.push(envelope),
    onLog: (envelope) => recorded.logs.push(envelope),
    onTurnStart: ({ turnToken }) => recorded.acks.push(turnToken),
    onTurnEnd: (info) => recorded.ends.push(info as never),
    onSendRejected: (info) => recorded.rejected.push(info),
    onOutOfTurnEvent: (info) => recorded.outOfTurn.push(info),
    onTurnProgress: ({ turnToken }) => recorded.progress.push(turnToken),
    onGateFault: (info) => recorded.faults.push(info),
    abortGraceMs: 200,
    closeGraceMs: 50,
    preAckBoundMs: 2_000,
    ...options,
  });
  recorded.results = () => recorded.logs.filter((e) => e.type === "result").map((e) => e.payload as Record<string, any>);
  hosts.push(recorded.test);
  return recorded;
}

/** Waits for the prompt of the latest process and returns that process. */
async function prompted(r: Recorded, count = r.test.agys.length || 1): Promise<FakeAgy> {
  await waitFor(() => r.test.agys.length >= count && r.test.agys[count - 1]!.promptOpen, () => r.test.agys.map((a) => a.requests.map((q) => q.method)));
  return r.test.agys[count - 1]!;
}

describe("AntigravityHost over ACP: start", () => {
  it("launches agy acp with the customization directory, the sandbox and no permission prompts", async () => {
    const r = setup();
    await r.test.host.send("hi", undefined, undefined, "t1");
    const agy = await prompted(r);
    expect(agy.args[0]).toBe("acp");
    expect(agy.args).toContain("--dangerously-skip-permissions");
    expect(agy.sandboxed).toBe(true);
    const custom = agy.args[agy.args.indexOf("--add-dir") + 1]!;
    expect(r.test.hookLists[0]).toEqual(["-p", "/hooks", "--add-dir", process.cwd(), "--add-dir", custom, "--output-format", "json"]);
    expect(agy.count("initialize")).toBe(1);
    const created = agy.requests.find((q) => q.method === "session/new")!;
    expect(created.params._meta).toEqual({ antigravity: { systemPrompt: { append: "persona" } } });
    expect(agy.env.KAOIRO_GATE_SOCKET).toBeTruthy();
    expect(agy.env.CODEX_HOME).toBeUndefined();
    for (const [key, value] of Object.entries(nonInteractiveToolEnv(process.env).additions)) expect(agy.env[key]).toBe(value);
  });

  it("drops --sandbox only for danger-full-access", async () => {
    for (const [sandbox, expected] of [["read-only", true], ["workspace-write", true], ["danger-full-access", false]] as const) {
      const r = setup({ sandbox });
      await r.test.host.send("hi");
      expect((await prompted(r)).sandboxed).toBe(expected);
    }
  });

  it("runs one prompt per process and resumes the session on the next process (L4, P10)", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const first = await prompted(r, 1);
    first.message("reply one");
    first.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    await r.test.host.send("two", undefined, undefined, "t2");
    const second = await prompted(r, 2);
    expect(first.exitCode !== null || first.signalCode !== null).toBe(true);
    expect(second.count("session/new")).toBe(0);
    expect(second.requests.find((q) => q.method === "session/resume")?.params.sessionId).toBe("session-1");
    second.respond("end_turn");
    await waitFor(() => r.ends.length === 2);
    expect(r.results().map((result) => result.text)).toEqual(["reply one", ""]);
    expect(r.ends.map((end) => end.terminal)).toEqual([true, true]);
  });

  it("spawns the next process only after the previous one exited (L4)", async () => {
    const { r, clock, killed } = clocked();
    await r.test.host.send("one", undefined, undefined, "t1");
    const first = await prompted(r, 1);
    first.survivesTerm = true;
    await r.test.host.send("two", undefined, undefined, "t2");
    first.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(killed(first)).toEqual(["SIGTERM"]);
    expect(r.test.agys).toHaveLength(1);
    await clock.advance(2_000);
    expect(killed(first)).toEqual(["SIGTERM", "SIGKILL"]);
    await prompted(r, 2);
  });
});

describe("AntigravityHost over ACP: one prompt at a time (L1)", () => {
  it("writes the next prompt only after the previous one settled", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const first = await prompted(r, 1);
    await r.test.host.send("two", undefined, undefined, "t2");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.test.agys.reduce((n, agy) => n + agy.count("session/prompt"), 0)).toBe(1);
    first.respond("end_turn");
    const second = await prompted(r, 2);
    expect(second.count("session/prompt")).toBe(1);
  });
});

describe("AntigravityHost over ACP: settlement and terminal states (L2)", () => {
  it("close settles the active input as stale and every queued input as closed; no process starts afterwards", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    await prompted(r, 1);
    await r.test.host.send("two", undefined, ["c2"], "t2");
    await r.test.host.close();
    expect(r.rejected).toEqual([{ turnToken: "t2", conversationIds: ["c2"], reason: "closed" }]);
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]).toMatchObject({ turnToken: "t1", terminal: false });
    expect(r.ends[0]!.error).toBeUndefined();
    expect(r.results()).toEqual([]);
    await r.test.host.send("three", undefined, undefined, "t3");
    expect(r.rejected.at(-1)).toMatchObject({ turnToken: "t3", reason: "closed" });
    expect(r.test.agys).toHaveLength(1);
  });

  it("watchdog fail-stop kills the process group, settles queued input once and stops admission", async () => {
    const fails: unknown[] = [];
    const r = setup({}, { onWatchdogFailStop: (info: unknown) => fails.push(info) });
    await r.test.host.send("one", undefined, ["c1"], "t1");
    const agy = await prompted(r, 1);
    await r.test.host.send("two", undefined, ["c2"], "t2");
    expect(r.test.host.failStopTurnForWatchdog("t1")).toBe(true);
    expect(r.test.signals).toContainEqual({ pid: agy.pid, destination: "process_group", signal: "SIGKILL" });
    expect(r.ends).toEqual([expect.objectContaining({ turnToken: "t2", cancellation: { kind: "watchdog_fail_stop", started: false }, terminal: false })]);
    expect(fails).toEqual([{ turnToken: "t1", conversationIds: ["c1"], attribution: "exact" }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.ends).toHaveLength(1);
    await r.test.host.send("three", undefined, undefined, "t3");
    expect(r.rejected.at(-1)).toMatchObject({ turnToken: "t3", reason: "watchdog_fail_stopped" });
  });

  it("an interrupt keeps queued input; the next input runs on a new process", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const first = await prompted(r, 1);
    await r.test.host.send("two", undefined, undefined, "t2");
    await r.test.host.interrupt();
    await waitFor(() => first.count("session/cancel") === 1);
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]).toMatchObject({ turnToken: "t1", error: { reason: "interrupted" }, cancellation: { kind: "interrupt", reason: "interrupted" } });
    const second = await prompted(r, 2);
    second.respond("end_turn");
    await waitFor(() => r.ends.length === 2);
    expect(r.ends[1]).toMatchObject({ turnToken: "t2", terminal: true });
  });

  it("an interrupt during a held hook list writes no prompt and no ACK, settles once, and the queue continues", async () => {
    const r = setup();
    r.test.holdHookList = true;
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.test.hookLists.length === 1);
    await r.test.host.send("two", undefined, undefined, "t2");
    r.test.holdHookList = false;
    await r.test.host.interrupt();
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]).toMatchObject({ turnToken: "t1", error: { reason: "interrupted" } });
    expect(r.acks).not.toContain("t1");
    const agy = await prompted(r, 1);
    expect(agy.count("session/prompt")).toBe(1);
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 2);
    expect(r.ends.map((end) => end.turnToken)).toEqual(["t1", "t2"]);
  });

  it("an interrupt during a held attach sends no cancel, ends the child on the abort grace and settles once", async () => {
    const r = setup();
    r.test.onSpawn = (agy) => { agy.hold.add("session/new"); agy.survivesTerm = true; };
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.test.agys[0]?.requests.some((q) => q.method === "session/new") === true);
    const agy = r.test.agys[0]!;
    await r.test.host.interrupt();
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]).toMatchObject({ turnToken: "t1", error: { reason: "interrupted" } });
    expect(r.acks).toEqual([]);
    expect(agy.count("session/prompt")).toBe(0);
    expect(agy.count("session/cancel")).toBe(0);
    expect(r.test.signals.filter((s) => s.pid === agy.pid).map((s) => s.signal)).toEqual(["SIGTERM"]);
    await waitFor(() => r.test.signals.some((s) => s.pid === agy.pid && s.signal === "SIGKILL"));
  });
});

describe("AntigravityHost over ACP: the window (L5)", () => {
  it("inside the window projects activity; after settlement it records kind and call ID only, and the closed gate fails hooks closed", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.survivesTerm = true;
    agy.toolCall("c1", "read_file", { Path: "a.txt" });
    await expect(agy.preToolUse("c1", "read_file", { Path: "a.txt" })).resolves.toEqual({ decision: "allow" });
    agy.toolDone("c1", "read_file", { Path: "a.txt" });
    agy.message("done");
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    const projected = r.logs.filter((e) => e.type === "log").map((e) => (e.payload as { kind: string }).kind);
    expect(projected).toEqual(expect.arrayContaining(["tool_use", "tool_result", "assistant"]));
    const logsBefore = r.logs.length;
    agy.toolCall("c9", "run_command", { CommandLine: "ls" });
    await waitFor(() => r.outOfTurn.length === 1);
    expect(r.outOfTurn).toEqual([{ eventKind: "tool_call", callId: "c9" }]);
    await expect(agy.preToolUse("c9", "run_command", { CommandLine: "ls" })).rejects.toThrow();
    await expect(agy.stop(false)).rejects.toThrow();
    expect(r.logs.length).toBe(logsBefore);
  });

  it("before the prompt is written, a hook is denied with a reason and a Stop is answered stop, before any cell (L5, review r13)", async () => {
    const decide: unknown[] = [];
    const r = setup({ sandbox: "danger-full-access", approval: "never" }, {
      permissionBroker: { decide: async (...args: unknown[]) => { decide.push(args); return { allow: true }; }, close: () => {} },
    });
    r.test.onSpawn = (agy) => agy.hold.add("session/new");
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.test.agys[0]?.requests.some((q) => q.method === "session/new") === true);
    const agy = r.test.agys[0]!;
    await expect(agy.preToolUse("s1", "run_command", { CommandLine: "ls" }, "session-sub")).resolves.toEqual({
      decision: "deny", reason: "kaoiro: no turn is open for this tool call",
    });
    await expect(agy.preToolUse("c1", "read_file", { Path: "a" })).resolves.toMatchObject({ decision: "deny" });
    await expect(agy.stop(false)).resolves.toEqual({ decision: "stop" });
    expect(r.outOfTurn).toEqual([{ eventKind: "pre_tool_use", callId: "s1" }, { eventKind: "pre_tool_use", callId: "c1" }]);
    expect(decide).toEqual([]);
    agy.release("session/new");
    await prompted(r, 1);
  });

  it("records another session's updates without projecting them", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "elsewhere" } }, "session-other");
    await waitFor(() => r.outOfTurn.length === 1);
    expect(r.outOfTurn[0]).toEqual({ eventKind: "other:agent_message_chunk" });
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    expect(r.results()[0]?.text).toBe("");
  });

  it("answers an unexpected permission request cancelled, cancels the prompt and fails the turn with its own reason (D17)", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.message("working");
    agy.requestPermission();
    await waitFor(() => r.ends.length === 1);
    expect(agy.count("session/cancel")).toBe(1);
    expect(r.ends[0]!.error).toEqual({ detail: "antigravity_unexpected_permission_request" });
  });
});

describe("AntigravityHost over ACP: verification (L6, 4.3)", () => {
  it("a completed call with an allowed hook is fine; a late matching completed before exit is fine too", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.survivesTerm = true;
    agy.toolCall("c1", "read_file", { Path: "a" });
    await agy.preToolUse("c1", "read_file", { Path: "a" });
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    agy.toolDone("c1", "read_file", { Path: "a" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.faults).toEqual([]);
    expect(r.ends[0]!.error).toBeUndefined();
  });

  it("a late completed with no hook record latches the fault for later input and keeps the published outcome", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.survivesTerm = true;
    agy.toolCall("c1", "run_command", { CommandLine: "sleep 9" });
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    agy.toolDone("c1", "run_command", { CommandLine: "sleep 9" });
    await waitFor(() => r.faults.length === 1);
    expect(r.faults[0]).toEqual({ reason: "antigravity_gate_unobserved_tool", detail: "antigravity_gate_unobserved_tool:run_command" });
    expect(r.ends).toHaveLength(1);
    await r.test.host.send("two", undefined, undefined, "t2");
    expect(r.rejected.at(-1)).toMatchObject({ turnToken: "t2", reason: "gate_broken" });
    expect(r.test.host.state).toBe("error");
  });

  it("a fault in the turn fails it with the gate reason; later input is rejected as gate_broken (review r11)", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    await r.test.host.send("two", undefined, undefined, "t2");
    agy.toolCall("c1", "run_command", { CommandLine: "ls" });
    agy.toolDone("c1", "run_command", { CommandLine: "ls" });
    await waitFor(() => r.ends.length === 1);
    expect(agy.count("session/cancel")).toBe(1);
    expect(r.ends[0]!.error!.detail).toMatch(/^antigravity_gate_unobserved_tool:/);
    expect(r.rejected).toEqual([{ turnToken: "t2", reason: "gate_broken" }]);
    await r.test.host.send("three", undefined, undefined, "t3");
    expect(r.rejected.at(-1)).toEqual({ turnToken: "t3", reason: "gate_broken" });
    expect(r.test.agys).toHaveLength(1);
  });

  it("an open call at settlement with no hook is a fault and takes the gate row of the outcome", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.toolCall("c1", "run_command", { CommandLine: "ls" });
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error!.detail).toBe("antigravity_gate_unobserved_tool:run_command");
  });

  it("decides a subagent's hook by the same cell, records it, and needs no ACP call for it (V7)", async () => {
    const r = setup({ sandbox: "workspace-write", network_access: false });
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    await expect(agy.preToolUse("s1", "read_file", { Path: "a" }, "session-sub")).resolves.toEqual({ decision: "allow" });
    await expect(agy.preToolUse("s2", "run_command", { CommandLine: "ls" }, "session-sub")).resolves.toMatchObject({ decision: "deny" });
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    expect(r.faults).toEqual([]);
    expect(r.ends[0]!.error).toBeUndefined();
  });

  it("negative controls: a duplicate hook key, and a parent call whose only hook has another conversation ID", async () => {
    for (const variant of ["duplicate", "foreign-only"] as const) {
      const r = setup();
      await r.test.host.send("one", undefined, undefined, "t1");
      const agy = await prompted(r, 1);
      if (variant === "duplicate") {
        await agy.preToolUse("s1", "read_file", { Path: "a" }, "session-sub");
        await expect(agy.preToolUse("s1", "read_file", { Path: "a" }, "session-sub")).resolves.toEqual({ decision: "deny", reason: "kaoiro: duplicate tool call" });
      } else {
        agy.toolCall("c1", "read_file", { Path: "a" });
        await agy.preToolUse("c1", "read_file", { Path: "a" }, "session-sub");
        agy.toolDone("c1", "read_file", { Path: "a" });
      }
      await waitFor(() => r.ends.length === 1);
      expect(r.ends[0]!.error!.detail).toMatch(/^antigravity_gate_unobserved_tool:/);
    }
  });

});

describe("AntigravityHost over ACP: the Stop answer (L10)", () => {
  it("continues while the turn's own loop reports background work, up to ten times", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    for (let i = 0; i < 10; i += 1) await expect(agy.stop(false)).resolves.toMatchObject({ decision: "continue" });
    await expect(agy.stop(false)).resolves.toEqual({ decision: "stop" });
  });

  it("answers stop for idle work, another reason, a subagent (not counted), and after a stop latched", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    await expect(agy.stop(true)).resolves.toEqual({ decision: "stop" });
    await expect(agy.stop(false, agy.sessionId, "MAX_TURNS")).resolves.toEqual({ decision: "stop" });
    for (let i = 0; i < 12; i += 1) await expect(agy.stop(false, "session-sub")).resolves.toEqual({ decision: "stop" });
    for (let i = 0; i < 10; i += 1) await expect(agy.stop(false)).resolves.toMatchObject({ decision: "continue" });
    await expect(agy.stop(false)).resolves.toEqual({ decision: "stop" });
    const r2 = setup();
    await r2.test.host.send("one", undefined, undefined, "t1");
    const agy2 = await prompted(r2, 1);
    agy2.hold.add("session/cancel");
    await r2.test.host.interrupt();
    await expect(agy2.stop(false)).resolves.toEqual({ decision: "stop" });
  });

  it("refuses the start when the hook list shows another enabled Stop, naming its file (D18)", async () => {
    const r = setup();
    r.test.extraHookGroups.push({ name: "other", enabled: true, source: "/elsewhere/.agents/hooks.json", actions: [{ event: "Stop", type: "command", command: "x", timeout_seconds: 30 }] });
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error!.detail).toBe("antigravity_hooks_refused:foreign_stop_hook:/elsewhere/.agents/hooks.json");
    expect(r.test.agys).toHaveLength(0);
    r.test.extraHookGroups.length = 0;
    r.test.extraHookGroups.push({ name: "off", enabled: false, source: "/elsewhere/.agents/hooks.json", actions: [{ event: "Stop", type: "command", command: "x", timeout_seconds: 30 }] });
    await r.test.host.send("two", undefined, undefined, "t2");
    await prompted(r, 1);
  });
});

describe("AntigravityHost over ACP: delivery ACK (L7)", () => {
  it("ACKs once when the response arrives before a held write callback, and a later write failure does not withdraw it", async () => {
    for (const outcome of ["ok", "failed"] as const) {
      const r = setup();
      r.test.onSpawn = (agy) => { agy.holdPromptWrite = true; };
      await r.test.host.send("one", undefined, undefined, "t1");
      const agy = await prompted(r, 1);
      expect(r.acks).toEqual([]);
      agy.respond("end_turn");
      await waitFor(() => r.ends.length === 1);
      expect(r.acks).toEqual(["t1"]);
      agy.releasePromptWrite(outcome === "failed" ? new Error("EPIPE") : undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(r.acks).toEqual(["t1"]);
      expect(r.ends[0]!.error).toBeUndefined();
    }
  });

  it("ACKs once on first-seen activity while the write callback is held; later confirmations add nothing", async () => {
    const r = setup();
    r.test.onSpawn = (agy) => { agy.holdPromptWrite = true; };
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.message("hi");
    await waitFor(() => r.acks.length === 1);
    agy.update({ sessionUpdate: "usage_update", used: 1, size: 2 });
    agy.message("more");
    agy.releasePromptWrite();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.acks).toEqual(["t1"]);
  });

  it("an error response confirms delivery: one ACK, and the turn fails with the API error", async () => {
    const r = setup();
    r.test.onSpawn = (agy) => { agy.holdPromptWrite = true; };
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.fail(-32603, "boom");
    await waitFor(() => r.ends.length === 1);
    expect(r.acks).toEqual(["t1"]);
    expect(r.ends[0]!.error).toEqual({ detail: "antigravity_api_error: boom", reason: "api_error" });
  });

  it("an error response that mentions 429 stays an API error (design 4.7)", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    (await prompted(r, 1)).fail(-32603, "upstream returned 429 Too Many Requests");
    await waitFor(() => r.ends.length === 1);
    const error = r.ends[0]!.error!;
    expect(error).toEqual({ detail: "antigravity_api_error: upstream returned 429 Too Many Requests", reason: "api_error" });
    expect(classifyInterAgentError(error).code).toBe("api_error");
    // Without the reason, the shared classifier reads the text as a rate limit.
    expect(classifyInterAgentError({ detail: error.detail! }).code).toBe("rate_limit");
  });

  it("a callback that returns after the pre-ACK bound settled the input changes nothing", async () => {
    const r = setup({}, { preAckBoundMs: 60, closeGraceMs: 500 });
    r.test.onSpawn = (agy) => { agy.holdPromptWrite = true; agy.survivesTerm = true; };
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    await waitFor(() => r.ends.length === 1);
    agy.releasePromptWrite();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.acks).toEqual([]);
    expect(r.ends).toHaveLength(1);
  });

  it("a prompt the closed connection never wrote settles as unacknowledged and unread", async () => {
    const r = setup();
    r.test.onSpawn = (agy) => { agy.listOnAttach = false; };
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.test.agys[0]?.count("session/new") === 1);
    const agy = r.test.agys[0]!;
    await new Promise((resolve) => setTimeout(resolve, 10));
    agy.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await agy.listTools();
    await waitFor(() => r.ends.length === 1);
    expect(agy.count("session/prompt")).toBe(0);
    expect(r.acks).toEqual([]);
    expect(r.ends[0]!.error).toEqual({ detail: "antigravity_delivery_unconfirmed" });
  });

  it("a control update is not a confirmation; a callback that never returns hits the pre-ACK bound", async () => {
    const r = setup({}, { preAckBoundMs: 60 });
    r.test.onSpawn = (agy) => { agy.holdPromptWrite = true; };
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.update({ sessionUpdate: "session_info_update", title: "x" });
    await waitFor(() => r.ends.length === 1);
    expect(r.acks).toEqual([]);
    expect(r.ends[0]!.error).toEqual({ detail: "antigravity_delivery_unconfirmed", reason: "receipt_unknown" });
    expect(r.test.signals.some((s) => s.pid === agy.pid && s.signal === "SIGTERM")).toBe(true);
  });

  it("a failed write before any confirmation settles as unacknowledged and ambiguous; it is not resent", async () => {
    const r = setup();
    r.test.onSpawn = (agy) => { agy.holdPromptWrite = true; };
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.releasePromptWrite(new Error("EPIPE"));
    await waitFor(() => r.ends.length === 1);
    expect(r.acks).toEqual([]);
    expect(r.ends[0]!.error).toEqual({ detail: "antigravity_delivery_unconfirmed", reason: "receipt_unknown" });
    expect(agy.count("session/prompt")).toBe(1);
  });

  it("close with the callback pending settles once without an ACK; a late callback changes nothing", async () => {
    const r = setup();
    r.test.onSpawn = (agy) => { agy.holdPromptWrite = true; };
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    await r.test.host.close();
    await waitFor(() => r.ends.length === 1);
    agy.releasePromptWrite();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.acks).toEqual([]);
    expect(r.ends).toHaveLength(1);
  });
});

function switching(overrides: Partial<WrapperConfig> = {}) {
  const lifecycle: Record<string, any>[] = [];
  const r = setup({ max_sandbox: "danger-full-access", max_approval: "never", max_network_access: true, ...overrides } as Partial<WrapperConfig>, {
    permissionSyncSupported: true,
    onPermissionLifecycle: (event: Record<string, any>) => lifecycle.push(event),
  });
  const control = () => (r.states.at(-1)!.ext as Record<string, any>).permission_control as Record<string, any>;
  return { r, lifecycle, control };
}

describe("AntigravityHost over ACP: permission evidence (L8)", () => {
  it("publishes applying with the submission at the start and applied on the response with the observed session", async () => {
    const { r, lifecycle, control } = switching();
    await r.test.host.setPermission({ revision: 3, requested: { sandbox: "danger-full-access", network_access: true, approval: "never" } });
    expect(control()).toMatchObject({ revision: 3, status: "pending" });
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    expect(agy.sandboxed).toBe(false);
    expect(control()).toMatchObject({ revision: 3, status: "applying", submitted: { revision: 3, execution_id: "t1" } });
    agy.update({ sessionUpdate: "config_option_update", configOptions: [] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(control().status).toBe("applying");
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    expect(control()).toMatchObject({ status: "applied", effective: { session_id: "session-1", execution_id: "t1" } });
    expect(lifecycle.map((event) => event.kind)).toEqual(["permission_applied"]);
  });

  it("a resume that echoes the ID gives applied; one that does not gives unknown and keeps the submission", async () => {
    for (const echo of [true, false]) {
      const { r, control } = switching();
      await r.test.host.send("one", undefined, undefined, "t1");
      const first = await prompted(r, 1);
      first.respond("end_turn");
      await waitFor(() => r.ends.length === 1);
      r.test.onSpawn = (agy) => { agy.echoResume = echo; };
      await r.test.host.setPermission({ revision: 4, requested: { sandbox: "read-only", network_access: false, approval: "on-request" } });
      await r.test.host.send("two", undefined, undefined, "t2");
      const second = await prompted(r, 2);
      second.message("x");
      await waitFor(() => control().status !== "applying");
      expect(control()).toMatchObject(echo
        ? { status: "applied", effective: { session_id: "session-1" } }
        : { status: "unknown", reason: "no_observed_session", submitted: { revision: 4, execution_id: "t2" } });
    }
  });

  it("a failed start gives failed without rolled_back_to; the next turn captures the selection again", async () => {
    const { r, control } = switching();
    await r.test.host.setPermission({ revision: 5, requested: { sandbox: "read-only", network_access: false, approval: "on-request" } });
    r.test.extraHookGroups.push({ name: "x", enabled: true, source: "/x/hooks.json", actions: [{ event: "Stop", command: "x" }] });
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.ends.length === 1);
    expect(control()).toMatchObject({ status: "failed", reason: "restart_failed", submitted: { revision: 5 } });
    expect(control().rolled_back_to).toBeUndefined();
    r.test.extraHookGroups.length = 0;
    await r.test.host.send("two", undefined, undefined, "t2");
    await prompted(r, 1);
    expect(control()).toMatchObject({ status: "applying", submitted: { revision: 5, execution_id: "t2" } });
  });

  it("an ambiguous write, a JSON-RPC error or a closed connection gives unknown with the reason", async () => {
    for (const how of ["write", "rpc", "closed"] as const) {
      const { r, control } = switching();
      await r.test.host.setPermission({ revision: 6, requested: { sandbox: "read-only", network_access: false, approval: "on-request" } });
      if (how === "write") r.test.onSpawn = (agy) => { agy.holdPromptWrite = true; };
      await r.test.host.send("one", undefined, undefined, "t1");
      const agy = await prompted(r, 1);
      if (how === "write") agy.releasePromptWrite(new Error("EPIPE"));
      if (how === "rpc") agy.fail(-32603, "Internal error");
      if (how === "closed") agy.exit(1);
      await waitFor(() => r.ends.length === 1);
      expect(control()).toMatchObject({ status: "unknown", submitted: { revision: 6 }, reason: { write: "delivery_unconfirmed", rpc: "rpc_error", closed: "connection_closed" }[how] });
    }
  });

  it("a newer selection while applying stays pending and is captured by the next turn", async () => {
    const { r, control } = switching();
    await r.test.host.setPermission({ revision: 7, requested: { sandbox: "read-only", network_access: false, approval: "on-request" } });
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    await r.test.host.setPermission({ revision: 8, requested: { sandbox: "danger-full-access", network_access: true, approval: "never" } });
    expect(control()).toMatchObject({ revision: 8, status: "pending" });
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    expect(control()).toMatchObject({ revision: 8, status: "pending", last_effective: { revision: 7 } });
    await r.test.host.send("two", undefined, undefined, "t2");
    const second = await prompted(r, 2);
    expect(second.sandboxed).toBe(false);
    expect(control()).toMatchObject({ revision: 8, status: "applying" });
  });
});

/** A clock a test advances by hand; only the host's own timers use it. */
class ManualClock {
  now = 0;
  #timers = new Map<number, { at: number; callback: () => void }>();
  #next = 1;
  set = (callback: () => void, delayMs: number): unknown => {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };
  clear = (timer: unknown): void => { this.#timers.delete(timer as number); };
  nowMs = (): number => this.now;
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    this.now = until;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function clocked(overrides: Partial<WrapperConfig> = {}, options: Record<string, unknown> = {}) {
  const clock = new ManualClock();
  const r = setup(overrides, { setTimer: clock.set, clearTimer: clock.clear, nowMs: clock.nowMs, abortGraceMs: 60_000, closeGraceMs: 2_000, preAckBoundMs: 1_800_000, ...options });
  const killed = (agy: FakeAgy) => r.test.signals.filter((s) => s.pid === agy.pid).map((s) => s.signal);
  return { r, clock, killed };
}

describe("AntigravityHost over ACP: stop deadlines (L3)", () => {
  it("an interrupt cancels and arms the abort grace; with no response the group is killed at the deadline", async () => {
    const { r, clock, killed } = clocked();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.hold.add("session/cancel");
    agy.survivesTerm = true;
    await r.test.host.interrupt();
    await clock.advance(30_000);
    agy.message("still going");
    await clock.advance(29_990);
    expect(killed(agy)).toEqual([]);
    await clock.advance(10);
    expect(killed(agy)).toEqual(["SIGKILL"]);
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ reason: "interrupted" });
  });

  it("a cancelled response 20 ms before the deadline keeps the outcome; the child gets at most those 20 ms", async () => {
    const { r, clock, killed } = clocked();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.hold.add("session/cancel");
    agy.survivesTerm = true;
    await r.test.host.interrupt();
    await clock.advance(59_980);
    agy.respond("cancelled");
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ reason: "interrupted" });
    expect(killed(agy)).toEqual(["SIGTERM"]);
    await clock.advance(19);
    expect(killed(agy)).toEqual(["SIGTERM"]);
    await clock.advance(1);
    expect(killed(agy)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("ordinary retirement sends SIGTERM, then SIGKILL after the close grace", async () => {
    const { r, clock, killed } = clocked();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.survivesTerm = true;
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    expect(killed(agy)).toEqual(["SIGTERM"]);
    await clock.advance(2_000);
    expect(killed(agy)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("ordinary retirement keeps the close grace when the abort grace is shorter", async () => {
    const { r, clock, killed } = clocked({}, { abortGraceMs: 1_000 });
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.survivesTerm = true;
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    await clock.advance(1_999);
    expect(killed(agy)).toEqual(["SIGTERM"]);
    await clock.advance(1);
    expect(killed(agy)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("close during a pending abort grace shortens it to the close grace and never lengthens it", async () => {
    const { r, clock, killed } = clocked();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.hold.add("session/cancel");
    agy.survivesTerm = true;
    await r.test.host.interrupt();
    await clock.advance(1_000);
    void r.test.host.close();
    await waitFor(() => r.ends.length === 1);
    expect(killed(agy)).toEqual(["SIGTERM"]);
    await clock.advance(2_000);
    expect(killed(agy)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("the watchdog interrupt cancels and arms no grace of its own", async () => {
    const { r, clock, killed } = clocked();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.hold.add("session/cancel");
    agy.message("x");
    await waitFor(() => r.acks.length === 1);
    expect(r.test.host.requestInterruptForTurn("t1", { kind: "inactivity", idleMs: 1 })).toBe(true);
    await waitFor(() => agy.requests.some((q) => q.method === "session/cancel"));
    await clock.advance(600_000);
    expect(killed(agy)).toEqual([]);
    expect(r.ends).toHaveLength(0);
    expect(r.test.host.failStopTurnForWatchdog("t1")).toBe(true);
    expect(killed(agy)).toEqual(["SIGKILL"]);
  });

  it("before the prompt is written, an interrupt ends the child on the abort grace and close on the close grace, without a cancel", async () => {
    for (const route of ["interrupt", "close"] as const) {
      const { r, clock, killed } = clocked();
      r.test.onSpawn = (agy) => { agy.hold.add("session/new"); agy.survivesTerm = true; };
      await r.test.host.send("one", undefined, undefined, "t1");
      await waitFor(() => r.test.agys[0]?.requests.some((q) => q.method === "session/new") === true);
      const agy = r.test.agys[0]!;
      if (route === "interrupt") await r.test.host.interrupt();
      else void r.test.host.close();
      await waitFor(() => r.ends.length === 1);
      expect(agy.count("session/cancel")).toBe(0);
      const grace = route === "interrupt" ? 60_000 : 2_000;
      await clock.advance(grace - 1);
      expect(killed(agy)).toEqual(["SIGTERM"]);
      await clock.advance(1);
      expect(killed(agy)).toEqual(["SIGTERM", "SIGKILL"]);
    }
  });

  it("a gate fault cancels and arms the abort grace; the pre-ACK bound ends the child on the close grace", async () => {
    const { r, clock, killed } = clocked();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.hold.add("session/cancel");
    agy.survivesTerm = true;
    agy.toolCall("c1", "run_command", { CommandLine: "ls" });
    agy.toolDone("c1", "run_command", { CommandLine: "ls" });
    await waitFor(() => agy.requests.some((q) => q.method === "session/cancel"));
    await clock.advance(59_999);
    expect(killed(agy)).toEqual([]);
    await clock.advance(1);
    expect(killed(agy)).toEqual(["SIGKILL"]);

    const second = clocked();
    second.r.test.onSpawn = (a) => { a.holdPromptWrite = true; a.survivesTerm = true; };
    await second.r.test.host.send("one", undefined, undefined, "t1");
    const held = await prompted(second.r, 1);
    await second.clock.advance(1_800_000);
    await waitFor(() => second.r.ends.length === 1);
    expect(second.killed(held)).toEqual(["SIGTERM"]);
    await second.clock.advance(2_000);
    expect(second.killed(held)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("an unexpected permission request cancels and arms the abort grace; with no response the group is killed at the deadline", async () => {
    const { r, clock, killed } = clocked();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.hold.add("session/cancel");
    agy.survivesTerm = true;
    agy.requestPermission();
    await waitFor(() => agy.count("session/cancel") === 1);
    await clock.advance(59_999);
    expect(killed(agy)).toEqual([]);
    await clock.advance(1);
    expect(killed(agy)).toEqual(["SIGKILL"]);
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ detail: "antigravity_unexpected_permission_request" });
  });

  it("a later route sends no second cancel and keeps the first deadline (D19)", async () => {
    const { r, clock, killed } = clocked();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.hold.add("session/cancel");
    agy.survivesTerm = true;
    await r.test.host.interrupt();
    await clock.advance(30_000);
    agy.requestPermission();
    // The host's answer to the request follows any cancel it wrote.
    await waitFor(() => agy.requests.some((q) => q.id === "perm-1"));
    expect(agy.count("session/cancel")).toBe(1);
    await clock.advance(29_999);
    expect(killed(agy)).toEqual([]);
    await clock.advance(1);
    expect(killed(agy)).toEqual(["SIGKILL"]);
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ reason: "interrupted" });
  });

  it("before the prompt is written, close right after an interrupt shortens the child's grace to the close grace", async () => {
    const { r, clock, killed } = clocked();
    r.test.onSpawn = (agy) => { agy.hold.add("session/new"); agy.survivesTerm = true; };
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.test.agys[0]?.requests.some((q) => q.method === "session/new") === true);
    const agy = r.test.agys[0]!;
    void r.test.host.interrupt();
    void r.test.host.close();
    await waitFor(() => r.ends.length === 1);
    expect(killed(agy)).toEqual(["SIGTERM"]);
    await clock.advance(1_999);
    expect(killed(agy)).toEqual(["SIGTERM"]);
    await clock.advance(1);
    expect(killed(agy)).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("AntigravityHost over ACP: kaoiro tools (L9, D13)", () => {
  function signalTool(seen: { aborted: boolean; closedLater: boolean }[]) {
    return {
      name: "probe_signal",
      description: "records its signal",
      inputSchema: { type: "object", properties: {} },
      handler: async (_input: Record<string, unknown>, context: { signal?: AbortSignal }) => {
        const record = { aborted: context.signal?.aborted ?? false, closedLater: false };
        seen.push(record);
        if (!record.aborted) {
          await new Promise<void>((resolve) => {
            context.signal?.addEventListener("abort", () => { record.closedLater = true; resolve(); }, { once: true });
            setTimeout(resolve, 200);
          });
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
  }

  it("a handler gets the open window's signal, which aborts when the window closes", async () => {
    const seen: { aborted: boolean; closedLater: boolean }[] = [];
    const r = setup({}, { toolDescriptors: [signalTool(seen)] });
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    const call = agy.callTool("probe_signal", {}).catch(() => undefined);
    await waitFor(() => seen.length === 1);
    agy.respond("end_turn");
    await call;
    expect(seen).toEqual([{ aborted: false, closedLater: true }]);
  });

  it("a call before the window opens gets an already aborted signal", async () => {
    const seen: { aborted: boolean; closedLater: boolean }[] = [];
    const r = setup({ model: "gemini-4-neon" }, { toolDescriptors: [signalTool(seen)] });
    r.test.onSpawn = (agy) => agy.hold.add("session/set_config_option");
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.test.agys[0]?.mcp !== undefined && r.test.agys[0]!.requests.some((q) => q.method === "session/set_config_option"));
    await r.test.agys[0]!.callTool("probe_signal", {});
    expect(seen).toEqual([{ aborted: true, closedLater: false }]);
  });

  it("refuses the previous process's bearer after retirement; a bad bearer changes nothing in a healthy turn", async () => {
    const seen: { aborted: boolean; closedLater: boolean }[] = [];
    const r = setup({}, { toolDescriptors: [signalTool(seen)] });
    await r.test.host.send("one", undefined, undefined, "t1");
    const first = await prompted(r, 1);
    const old = first.mcp!;
    first.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    await expect(first.callTool("probe_signal", {}, { mcp: old })).rejects.toThrow();
    await r.test.host.send("two", undefined, undefined, "t2");
    const second = await prompted(r, 2);
    const bad = await second.callTool("probe_signal", {}, { headers: { Authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
    await expect(second.callTool("probe_signal", {}, { mcp: old })).rejects.toThrow();
    second.respond("end_turn");
    await waitFor(() => r.ends.length === 2);
    expect(r.ends[1]!.error).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("fails the start when agy does not list the kaoiro tools in time", async () => {
    const r = setup({}, { mcpReadyTimeoutMs: 50 });
    r.test.onSpawn = (agy) => { agy.listOnAttach = false; };
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ detail: "kaoiro MCP server did not connect" });
    expect(r.test.agys[0]!.count("session/prompt")).toBe(0);
  });

  it("closes a held question when agy cuts its call, and at the latest when the turn settles (D13)", async () => {
    const { QuestionBroker, askUserQuestionDescriptor } = await import("@kaoiro/agent-common");
    for (const end of ["cut", "settle"] as const) {
      const pendings: unknown[] = [];
      const broker = new QuestionBroker({ config: config(), send: () => {}, onPendingChange: (pending: unknown) => pendings.push(pending) });
      const r = setup({}, { toolDescriptors: [askUserQuestionDescriptor((questions, signal) => broker.decide(questions, signal))] });
      await r.test.host.send("one", undefined, undefined, "t1");
      const agy = await prompted(r, 1);
      const cut = new AbortController();
      const call = agy.callTool("ask_user_question", { questions: [{ question: "Go?", header: "Go", options: [{ label: "Yes", description: "y" }, { label: "No", description: "n" }], multiSelect: false }] }, { signal: cut.signal }).catch(() => undefined);
      await waitFor(() => pendings.length === 1 && pendings[0] !== null, () => pendings);
      if (end === "cut") cut.abort();
      else agy.respond("end_turn");
      await waitFor(() => pendings.at(-1) === null, () => pendings);
      await call;
    }
  });
});

describe("AntigravityHost over ACP: model and level (4.8)", () => {
  function modelSetup(model: string | undefined, pending?: string) {
    const r = setup(model === undefined ? {} : { model });
    const ext = () => r.states.at(-1)!.ext as Record<string, any>;
    if (pending !== undefined) void r.test.host.setModel(pending);
    return { r, ext };
  }

  it("applies a listed slug, and a <model>-<level> slug as two verified steps", async () => {
    const { r } = modelSetup(undefined, "gemini-4-neon-high");
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    expect(agy.requests.filter((q) => q.method === "session/set_config_option").map((q) => [q.params.configId, q.params.value]))
      .toEqual([["model", "gemini-4-neon"], ["thought_level", "high"]]);
    expect((r.states.at(-1)!.ext as Record<string, any>).model).toBe("gemini-4-neon-high");
  });

  it("sends nothing for the account default", async () => {
    const { r } = modelSetup(undefined, "");
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    expect(agy.count("session/set_config_option")).toBe(0);
  });

  it("re-applies the committed slug at every start, also after resume", async () => {
    const { r } = modelSetup("gemini-4-neon");
    for (const n of [1, 2]) {
      await r.test.host.send(`turn ${n}`, undefined, undefined, `t${n}`);
      const agy = await prompted(r, n);
      expect(agy.requests.filter((q) => q.method === "session/set_config_option").map((q) => q.params.value)).toEqual(["gemini-4-neon"]);
      agy.respond("end_turn");
      await waitFor(() => r.ends.length === n);
    }
  });

  it("an extra value the option list lacks is sent as a model value; a refused first step applies nothing (control_rejected)", async () => {
    const { r, ext } = modelSetup(undefined, "gemini-4-argon");
    r.test.onSpawn = (agy) => { agy.models.push("gemini-4-argon"); };
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    expect(agy.config.get("model")).toBe("gemini-4-argon");
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    await r.test.host.setModel("not-a-model");
    await r.test.host.send("two", undefined, undefined, "t2");
    const second = await prompted(r, 2);
    expect(second.config.get("model")).toBe("gemini-4-argon");
    const states = r.states.map((s) => (s.ext as Record<string, any>).switch_error).filter(Boolean);
    expect(states.at(-1)).toEqual({ kind: "model", requested: "not-a-model", reason: "control_rejected" });
    expect(ext().model).toBe("gemini-4-argon");
  });

  it("a level that is not offered rolls back to the previous pair and reports it", async () => {
    const { r } = modelSetup("gemini-4-neon", "gemini-4-carbon-ultra");
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    expect(agy.config.get("model")).toBe("gemini-4-neon");
    const errors = r.states.map((s) => (s.ext as Record<string, any>).switch_error).filter(Boolean);
    expect(errors.at(-1)).toEqual({ kind: "model", requested: "gemini-4-carbon-ultra", reason: "level not offered", rolled_back_to: "gemini-4-neon" });
  });

  it("fails the start when the committed slug can no longer be applied", async () => {
    const { r } = modelSetup("gone-model");
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ detail: "antigravity_model_not_applied:gone-model" });
  });
});

describe("AntigravityHost over ACP: start failures", () => {
  it("a resume refused with -32603 fails the start visibly and tells the recovery checkpoint", async () => {
    const refused: string[] = [];
    const r = setup({}, {
      resumeSessionId: "stored",
      recovery: { accept: () => true, confirm: () => true, observe: () => true, refuseLaunch: () => refused.push("refused"), failure: undefined },
    });
    r.test.onSpawn = (agy) => { agy.rejectResume = true; };
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ detail: "antigravity_resume_failed" });
    expect(refused).toEqual(["refused"]);
  });

  it("classifies the captured Authentication required error, and only that exact form", async () => {
    for (const [message, detail] of [["Authentication required", "antigravity_auth_required"], ["Authentication required.", undefined]] as const) {
      const r = setup();
      await r.test.host.send("one", undefined, undefined, "t1");
      const agy = await prompted(r, 1);
      agy.fail(-32000, message);
      await waitFor(() => r.ends.length === 1);
      expect(r.ends[0]!.error!.detail).toBe(detail ?? "antigravity_api_error: Authentication required.");
    }
  });

  it("a prepareInput that returns null skips the input without a prompt", async () => {
    const r = setup({}, { prepareInput: () => null });
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.test.agys[0]?.exitCode !== null || r.test.agys[0]?.signalCode !== null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.test.agys[0]!.count("session/prompt")).toBe(0);
    expect(r.ends).toEqual([]);
  });
});

function tamper(agy: FakeAgy): void {
  const custom = agy.args[agy.args.indexOf("--add-dir") + 1]!;
  writeFileSync(join(custom, ".agents", "hooks.json"), "{}\n");
}

describe("AntigravityHost over ACP: outcome precedence (L2 rows)", () => {
  it("(1) over (2): close outranks tampering; no result is fabricated", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    tamper(agy);
    await r.test.host.close();
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toBeUndefined();
    expect(r.results()).toEqual([]);
  });

  it("(2) over (3): tampering outranks an interrupt", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    tamper(agy);
    await r.test.host.interrupt();
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ detail: "antigravity_customization_tampered" });
    expect(r.faults.map((fault) => fault.reason)).toEqual(["antigravity_customization_tampered"]);
  });

  it("(3) over (4): an interrupt before the ACK settles as interrupted", async () => {
    const r = setup();
    r.test.onSpawn = (agy) => { agy.holdPromptWrite = true; agy.hold.add("session/cancel"); };
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    await r.test.host.interrupt();
    agy.release("session/cancel");
    await waitFor(() => r.ends.length === 1);
    expect(r.acks).toEqual([]);
    expect(r.ends[0]!.error).toEqual({ reason: "interrupted" });
  });

  it("(4) over (5): an unconfirmed delivery outranks a gate fault", async () => {
    const r = setup({}, { preAckBoundMs: 80 });
    r.test.onSpawn = (agy) => { agy.holdPromptWrite = true; agy.hold.add("session/cancel"); };
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    await agy.preToolUse("s1", "read_file", { Path: "a" }, "session-sub");
    await agy.preToolUse("s1", "read_file", { Path: "a" }, "session-sub");
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ detail: "antigravity_delivery_unconfirmed", reason: "receipt_unknown" });
    expect(r.faults).toHaveLength(1);
  });

  it("(5) over (6): a gate fault outranks the tool deadline", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.hold.add("session/cancel");
    agy.message("x");
    await waitFor(() => r.acks.length === 1);
    r.test.host.requestInterruptForTurn("t1", { kind: "tool_timeout", stepIndex: 1, toolName: "run_command", elapsedMs: 1, toolTimeoutMs: 1 });
    agy.toolCall("c1", "run_command", { CommandLine: "ls" });
    agy.toolDone("c1", "run_command", { CommandLine: "ls" });
    await waitFor(() => r.faults.length === 1);
    agy.release("session/cancel");
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error!.detail).toBe("antigravity_gate_unobserved_tool:run_command");
  });

  it("(6) over (7): the tool deadline outranks an unexpected permission request", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.hold.add("session/cancel");
    agy.message("x");
    await waitFor(() => r.acks.length === 1);
    r.test.host.requestInterruptForTurn("t1", { kind: "tool_timeout", stepIndex: 1, toolName: "run_command", elapsedMs: 1, toolTimeoutMs: 1 });
    agy.requestPermission();
    await new Promise((resolve) => setTimeout(resolve, 10));
    agy.release("session/cancel");
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ reason: "timeout" });
  });

  it("(7) over (8): an unexpected permission request outranks a closed connection", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.hold.add("session/cancel");
    agy.message("x");
    agy.requestPermission();
    await waitFor(() => agy.requests.some((q) => q.method === "session/cancel") || agy.hold.has("session/cancel"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    agy.exit(1);
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ detail: "antigravity_unexpected_permission_request" });
  });

  it("(7) over (8): a process error outranks the closed connection it causes", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.emit("error", new Error("write EPIPE"));
    agy.exit(1);
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ detail: "antigravity_cli_process_error: write EPIPE" });
  });

  it("(8): a closed connection without a response; (9): the response decides; another stop reason is an error", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    (await prompted(r, 1)).exit(1);
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toEqual({ detail: "agy_exit_without_result" });
    await r.test.host.send("two", undefined, undefined, "t2");
    (await prompted(r, 2)).respond("max_tokens");
    await waitFor(() => r.ends.length === 2);
    expect(r.ends[1]).toMatchObject({ error: { detail: "antigravity_stop_reason:max_tokens" }, terminal: true });
  });

  it("an interrupt after the outcome was decided changes nothing", async () => {
    const settled: unknown[] = [];
    const r = setup({}, { onInterruptSettled: (info: unknown) => settled.push(info) });
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.survivesTerm = true;
    agy.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    await r.test.host.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.ends).toHaveLength(1);
    expect(r.ends[0]!.error).toBeUndefined();
    expect(settled).toEqual([]);
  });
});

describe("AntigravityHost over ACP: failures that are not terminal (L2)", () => {
  it("a failed start, a closed connection and an expired pre-ACK bound fail only their input; the queue continues", async () => {
    for (const failure of ["start", "closed", "pre_ack"] as const) {
      const r = setup({}, { preAckBoundMs: 60, mcpReadyTimeoutMs: 50 });
      if (failure === "start") r.test.onSpawn = (agy) => { agy.listOnAttach = r.test.agys.length !== 1; };
      if (failure === "pre_ack") r.test.onSpawn = (agy) => { agy.holdPromptWrite = r.test.agys.length === 1; };
      await r.test.host.send("one", undefined, undefined, "t1");
      await r.test.host.send("two", undefined, undefined, "t2");
      if (failure === "closed") (await prompted(r, 1)).exit(1);
      await waitFor(() => r.ends.length === 1);
      expect(r.ends[0]!.error).toBeDefined();
      const next = await prompted(r, 2);
      next.respond("end_turn");
      await waitFor(() => r.ends.length === 2);
      expect(r.ends[1]).toMatchObject({ turnToken: "t2", terminal: true });
      expect(r.ends[1]!.error).toBeUndefined();
    }
  });

  it("close during the start settles the active input and every queued input as closed", async () => {
    const r = setup();
    r.test.onSpawn = (agy) => agy.hold.add("session/new");
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.test.agys[0]?.requests.some((q) => q.method === "session/new") === true);
    await r.test.host.send("two", undefined, undefined, "t2");
    void r.test.host.close();
    await waitFor(() => r.ends.length === 1);
    expect(r.rejected).toEqual([{ turnToken: "t2", reason: "closed" }]);
    expect(r.ends[0]).toMatchObject({ turnToken: "t1", terminal: false });
    expect(r.test.agys[0]!.count("session/prompt")).toBe(0);
  });
});

describe("AntigravityHost over ACP: termination ownership", () => {
  it("an earlier process's deadline never signals the next process (pin 6)", async () => {
    const r = setup({}, { abortGraceMs: 80 });
    await r.test.host.send("one", undefined, undefined, "t1");
    const first = await prompted(r, 1);
    await r.test.host.interrupt();
    await waitFor(() => r.ends.length === 1);
    await r.test.host.send("two", undefined, undefined, "t2");
    const second = await prompted(r, 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(r.test.signals.filter((s) => s.pid === second.pid)).toEqual([]);
    expect(first.exitCode !== null || first.signalCode !== null).toBe(true);
  });

  it("the hook list and model probes are not started detached (they stay out of the group kill)", async () => {
    const probeOptions: unknown[] = [];
    const r = setup({}, {
      probeSpawn: (_command: string, args: string[], options: unknown) => {
        probeOptions.push(options);
        return fakeHookList(hookGroups(args));
      },
    });
    await r.test.host.send("one", undefined, undefined, "t1");
    await prompted(r, 1);
    expect(probeOptions).toHaveLength(1);
    for (const options of probeOptions) expect(options).not.toHaveProperty("detached");
  });
});

describe("AntigravityHost over ACP: single confirmations and late input", () => {
  it("ACKs on the write callback alone, before any activity or response (L7)", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    await prompted(r, 1);
    await waitFor(() => r.acks.length === 1);
    expect(r.acks).toEqual(["t1"]);
    expect(r.ends).toEqual([]);
  });

  it("denies a hook that arrives after a stop latched, while the prompt is still open", async () => {
    const r = setup();
    await r.test.host.send("one", undefined, undefined, "t1");
    const agy = await prompted(r, 1);
    agy.hold.add("session/cancel");
    await r.test.host.interrupt();
    await expect(agy.preToolUse("c1", "read_file", { Path: "a" })).resolves.toEqual({ decision: "deny", reason: "kaoiro: the turn is stopping" });
  });

  it("records a permission request outside the window without cancelling anything", async () => {
    const r = setup();
    r.test.onSpawn = (agy) => agy.hold.add("session/new");
    await r.test.host.send("one", undefined, undefined, "t1");
    await waitFor(() => r.test.agys[0]?.requests.some((q) => q.method === "session/new") === true);
    const agy = r.test.agys[0]!;
    agy.requestPermission();
    await waitFor(() => r.outOfTurn.length === 1);
    expect(r.outOfTurn).toEqual([{ eventKind: "session/request_permission" }]);
    agy.release("session/new");
    const opened = await prompted(r, 1);
    opened.respond("end_turn");
    await waitFor(() => r.ends.length === 1);
    expect(r.ends[0]!.error).toBeUndefined();
    expect(opened.count("session/cancel")).toBe(0);
  });
});
