import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  PermissionBroker,
  type Envelope,
  type PendingQuestionExt,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import { GrokHost, type GrokHostOptions } from "../src/host.js";
import { GrokProcess } from "../src/grok/process.js";
import * as events from "../src/grok/events.js";
import type { GrokWireMetadata } from "../src/grok/wire.js";
const executable = fileURLToPath(
  new URL("./fixtures/grok.mjs", import.meta.url),
);
export const config: WrapperConfig = {
  agent_id: "grok-test",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  display_name: "Grok test",
  server_url: "ws://127.0.0.1:1/agent",
};
const hosts: GrokHost[] = [];
const scratch: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) {
    host.close();
    await host.closed;
  }
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function started(options: Partial<GrokHostOptions> = {}) {
  const envelopes: Envelope[] = [];
  const host = new GrokHost({
    config: { ...config },
    cwd: process.cwd(),
    personaPrompt: "PERSONA_AND_FOOTER",
    send: (e) => envelopes.push(e),
    decidePermission: async () => ({ allow: false }),
    executable,
    ...options,
  });
  hosts.push(host);
  const run = host.run();
  void run.catch(() => {});
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
    timeout: 5_000,
  });
  await vi.waitFor(() => expect(host.statusSnapshot()).toHaveProperty("rate_limits.seven_day"));
  return { host, envelopes, run };
}
function assistantLogs(envelopes: Envelope[]) {
  return envelopes.filter(e => e.type === "log" && e.payload.kind === "assistant");
}
const pendingQuestion: PendingQuestionExt = {
  request_id: "question-fixture",
  ts: "2026-10-14T00:00:00Z",
  questions: [{ header: "Continue", question: "Continue?", multiSelect: false, options: [
    { label: "Yes", description: "Continue" },
    { label: "No", description: "Stop" },
  ] }],
};
async function waitForHeldChunks(received: { mock: { calls: [SessionNotification][] } }) {
  await vi.waitFor(() => expect(received.mock.calls.filter(([notification]) =>
    notification.update.sessionUpdate === "agent_message_chunk")).toHaveLength(3));
}
describe("assistant log projection", () => {
  it.each(["chunks", "fail-chunks"])(
    "flushes %s once before the result event with the thinking stamp",
    async input => {
      const { host, envelopes } = await started();
      if (input === "fail-chunks") await expect(host.send(input)).rejects.toThrow();
      else await host.send(input);
      const logs = assistantLogs(envelopes);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        state: "thinking", payload: { kind: "assistant", text: "Hello world" },
      });
      const result = envelopes.find(e => e.type === "result")!;
      expect(envelopes.indexOf(logs[0]!)).toBeLessThan(envelopes.indexOf(result));
      expect(result.payload).toMatchObject(input === "chunks"
        ? { text: "Hello world", is_error: false }
        : { text: "", is_error: true });
      expect(envelopes.filter(e => e.type === "log" && e.payload.kind === "user")
        .map(e => e.payload.text)).toEqual([input]);
    },
  );
  it("keeps live-shaped thought and tool updates inside their text group", async () => {
    const { host, envelopes } = await started();
    await host.send("ordered-chunks");
    expect(envelopes.filter(e => e.type === "log" && e.payload.kind !== "user")
      .map(e => e.payload)).toEqual([
        { kind: "assistant", text: "Before tool" },
        { kind: "tool_use", tool_name: "probe" },
        { kind: "assistant", text: "After tool" },
      ]);
    expect(envelopes.find(e => e.type === "result")?.payload.text)
      .toBe("Before toolAfter tool");
  });
  it("clips a joined 20 KiB log and the result to 16 KiB", async () => {
    const { host, envelopes } = await started();
    await host.send("large-chunks");
    expect(assistantLogs(envelopes).map(e => e.payload)).toEqual([
      { kind: "assistant", text: "x".repeat(16 * 1024), truncated: true },
    ]);
    expect(envelopes.find(e => e.type === "result")?.payload.text)
      .toBe("x".repeat(16 * 1024));
  });
  it("keeps a 70,000-byte reply's result envelope under the server limit", async () => {
    const { host, envelopes } = await started();
    await host.send("reply-70000");
    const result = envelopes.find(e => e.type === "result")!;
    expect(result.payload.text).toBe("x".repeat(16 * 1024));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(65_536);
    expect(assistantLogs(envelopes).map(e => e.payload)).toEqual([
      { kind: "assistant", text: "x".repeat(16 * 1024), truncated: true },
    ]);
    expect(host.state).toBe("waiting_input");
  });
  it.each([
    { size: 16_384, clipped: false },
    { size: 16_385, clipped: true },
  ])("clips a $size-byte result only above 16,384 bytes", async ({ size, clipped }) => {
    const { host, envelopes } = await started();
    await host.send(`reply-${size}`);
    expect(envelopes.find(e => e.type === "result")?.payload.text)
      .toBe("x".repeat(16 * 1024));
    expect(assistantLogs(envelopes).map(e => e.payload.truncated === true))
      .toEqual([clipped]);
  });
  it("emits no assistant log for non-text chunks or thoughts", async () => {
    const { host, envelopes } = await started();
    await host.send("non-text-chunks");
    expect(assistantLogs(envelopes)).toHaveLength(0);
    expect(envelopes.find(e => e.type === "result")?.payload.text).toBe("");
  });
  it("flushes before entering a question wait without duplicating on cancel", async () => {
    const { host, envelopes } = await started();
    const received = vi.spyOn(events, "updateEvents");
    const turn = host.send("hold-chunks");
    await waitForHeldChunks(received);
    expect(assistantLogs(envelopes)).toHaveLength(0);
    host.setPendingQuestion(pendingQuestion);
    const logs = assistantLogs(envelopes);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ state: "thinking", payload: { text: "Hello world" } });
    expect(envelopes.indexOf(logs[0]!)).toBeLessThan(
      envelopes.findIndex(e => e.type === "state_change" && e.state === "waiting_question"));
    host.setPendingQuestion(null);
    await host.interrupt();
    await turn;
    expect(assistantLogs(envelopes)).toHaveLength(1);
  });
  it("clears buffered text before sending a reentrant log", async () => {
    let host!: GrokHost;
    const envelopes: Envelope[] = [];
    let reentered = false;
    const setup = await started({ send: envelope => {
      envelopes.push(envelope);
      if (envelope.type === "log" && envelope.payload.kind === "assistant" && !reentered) {
        reentered = true;
        host.setPendingQuestion(pendingQuestion);
      }
    } });
    host = setup.host;
    await host.send("chunks");
    expect(assistantLogs(envelopes).map(e => e.payload.text)).toEqual(["Hello world"]);
    host.setPendingQuestion(null);
  });
  it.each(["cancel", "close", "inactivity"])("flushes buffered text exactly once on %s", async mode => {
    const { host, envelopes } = await started();
    const received = vi.spyOn(events, "updateEvents");
    if (mode === "inactivity") vi.useFakeTimers();
    const turn = host.send("hold-chunks");
    void turn.catch(() => {});
    await waitForHeldChunks(received);
    expect(assistantLogs(envelopes)).toHaveLength(0);
    if (mode === "cancel") {
      await host.interrupt();
      await turn;
    } else {
      if (mode === "close") host.close();
      else await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
      vi.useRealTimers();
      await expect(turn).rejects.toThrow();
      await host.closed;
    }
    const logs = assistantLogs(envelopes);
    expect(logs.map(e => e.payload.text)).toEqual(["Hello world"]);
    const results = envelopes.filter(e => e.type === "result");
    expect(results).toHaveLength(1);
    expect(envelopes.indexOf(logs[0]!)).toBeLessThan(envelopes.indexOf(results[0]!));
    if (mode === "cancel") expect(results[0]?.ext).toMatchObject({ interrupted: true });
  });
  it("puts a queued operator bubble after the running turn's assistant text", async () => {
    const { host, envelopes } = await started();
    const received = vi.spyOn(events, "updateEvents");
    const first = host.send("hold-chunks");
    await waitForHeldChunks(received);
    const next = host.send("NEXT_OPERATOR");
    expect(envelopes.filter(e => e.type === "log" && e.payload.kind === "user")
      .map(e => e.payload.text)).toEqual(["hold-chunks"]);
    await host.interrupt();
    await first;
    await next;
    expect(envelopes.filter(e => e.type === "log").map(e => e.payload)).toEqual([
      { kind: "user", text: "hold-chunks" },
      { kind: "assistant", text: "Hello world" },
      { kind: "user", text: "NEXT_OPERATOR" },
      { kind: "assistant", text: "NEXT_OPERATOR" },
    ]);
  });
});
describe("state_change publication", () => {
  const states = (envelopes: Envelope[], from = 0) =>
    envelopes.slice(from).filter(e => e.type === "state_change").map(e => e.state);
  it("publishes the first waiting_input at startup", async () => {
    const { envelopes } = await started();
    expect(states(envelopes)[0]).toBe("waiting_input");
  });
  it("publishes one thinking for a run of chunks", async () => {
    const { host, envelopes } = await started();
    const start = envelopes.length;
    await host.send("chunks");
    expect(states(envelopes, start)).toEqual(["sending", "thinking", "done", "waiting_input"]);
  });
  it("still publishes a rename, which changes only the envelope header", async () => {
    const { host, envelopes } = await started();
    const start = envelopes.length;
    host.renameDisplayName("Renamed", 1);
    const published = envelopes.slice(start).filter(e => e.type === "state_change");
    expect(published.map(e => e.display_name)).toEqual(["Renamed"]);
  });
  it("publishes waiting_question once while the same question stays pending", async () => {
    const { host, envelopes } = await started();
    const received = vi.spyOn(events, "updateEvents");
    const turn = host.send("hold-chunks");
    await waitForHeldChunks(received);
    const start = envelopes.length;
    host.setPendingQuestion(pendingQuestion);
    host.setPendingQuestion(pendingQuestion);
    expect(states(envelopes, start).filter(s => s === "waiting_question")).toHaveLength(1);
    host.setPendingQuestion(null);
    await host.interrupt();
    await turn;
  });
});
describe("resident ACP host", () => {
  it("fails when stdout ends without exiting", async () => {
    const path = mkdtempSync(join(tmpdir(), "kaoiro-grok-eof-"));
    scratch.push(path);
    const pidFile = join(path, "pid");
    const { host, run } = await started({
      env: { ...process.env, KAOIRO_TEST_GROK_PID_FILE: pidFile },
    });
    const pid = host.processId!;
    const turn = host.send("close-output");
    await expect(turn).rejects.toThrow();
    await vi.waitFor(() => expect(host.state).toBe("error"), {
      timeout: 4500,
    });
    await expect(run).rejects.toThrow("connection closed unexpectedly");
    expect(Number(readFileSync(pidFile, "utf8"))).toBe(pid);
    await expect(host.send("next turn")).rejects.toThrow("closed");
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it("keeps large tool updates on the real SDK session", async () => {
    let receivedBytes = 0;
    const original = events.updateEvents;
    vi.spyOn(events, "updateEvents").mockImplementation((notification) => {
      const update = notification.update;
      if (update.sessionUpdate === "tool_call_update") {
        for (const entry of update.content ?? []) {
          if (entry.type === "content" && entry.content.type === "text") {
            if (entry.content.text.startsWith("LARGE_TOOL_BODY_MARKER"))
              receivedBytes = Buffer.byteLength(entry.content.text);
          }
        }
      }
      return original(notification);
    });
    const metadata: unknown[] = [];
    const { host, envelopes } = await started({
      onMetadata: (m) => metadata.push(m),
    });
    await host.send("large-tool");
    expect(receivedBytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(metadata).toContainEqual({ direction: "in", oversized_lines: 1 });
    expect(JSON.stringify(metadata)).not.toContain("LARGE_TOOL_BODY_MARKER");
    await host.send("next turn");
    expect(envelopes.filter((e) => e.type === "result").at(-1)?.payload.text)
      .toBe("next turn");
    expect(host.state).toBe("waiting_input");
  });
  it("sends only trusted static launch rejection messages", async () => {
    const envelopes: Envelope[] = [];
    const host = new GrokHost({
      config: { ...config, network_access: false },
      cwd: process.cwd(), personaPrompt: "", executable,
      send: (e) => envelopes.push(e),
      decidePermission: async () => ({ allow: false }),
    });
    hosts.push(host);
    await expect(host.run()).rejects.toThrow("sandbox/network");
    expect(envelopes.filter((e) => e.type === "log").map((e) => e.payload))
      .toEqual([{ kind: "system", text:
        "unsupported grok sandbox/network pair" }]);
    const ordinaryLogs: Envelope[] = [];
    const ordinary = new GrokHost({
      config, cwd: process.cwd(), personaPrompt: "",
      executable,
      env: { ...process.env, KAOIRO_TEST_GROK_INITIALIZE_FAIL: "1" },
      send: (e) => ordinaryLogs.push(e),
      decidePermission: async () => ({ allow: false }),
    });
    hosts.push(ordinary);
    await expect(ordinary.run()).rejects.toThrow();
    expect(ordinaryLogs.filter((e) => e.type === "log")).toEqual([]);
    expect(JSON.stringify(ordinaryLogs)).not.toContain("LAUNCH_ERROR_BODY");

  });

  it("aborts startup inspect on close", async () => {
    const path = mkdtempSync(join(tmpdir(), "kaoiro-grok-inspect-"));
    scratch.push(path);
    const pidFile = join(path, "pid");
    const host = new GrokHost({
      config,
      cwd: process.cwd(),
      personaPrompt: "",
      send: () => {},
      decidePermission: async () => ({ allow: false }),
      executable,
      env: {
        ...process.env,
        KAOIRO_TEST_GROK_INSPECT_HANG: "1",
        KAOIRO_TEST_GROK_PID_FILE: pidFile,
      },
    });
    hosts.push(host);
    const run = host.run();
    void run.catch(() => {});
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), {
      timeout: 5000,
    });
    const pid = Number(readFileSync(pidFile, "utf8"));
    const start = Date.now();
    host.close();
    await host.closed;
    await run;
    expect(Date.now() - start).toBeLessThan(4500);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });
  it("keeps one session and native rules", async () => {
    const { host, envelopes } = await started();
    await host.send("remember retained");
    await host.send("recall");
    expect(
      envelopes.filter((e) => e.type === "result").at(-1)?.payload.text,
    ).toBe("retained");
    await host.send("rules");
    expect(
      envelopes.filter((e) => e.type === "result").at(-1)?.payload.text,
    ).toBe("PERSONA_AND_FOOTER");
    expect(host.state).toBe("waiting_input");
    expect(
      envelopes.filter((e) => e.type === "result").at(-1)?.ext
        ?.completion_source,
    ).toBe("vendor");
    expect(host.statusExtSnapshot()).toMatchObject({
      engine: "grok",
      permission: {
        sandbox: "workspace-write",
        approval: "on-request",
        enforcement: "os",
      },
      permission_policy: {
        inspect: "ok",
        claude_hooks: { enabled: true, source: "config" },
      },
      delivery_modes: { early: "none", yield: "none" },
    });
    expect(envelopes.some((e) => e.state === "thinking")).toBe(true);
  });
  it("round-trips a tool through the HTTP MCP server", async () => {
    const calls: unknown[] = [];
    const { host, envelopes } = await started({
      toolDescriptors: [
        {
          name: "probe",
          description: "Return a probe value",
          inputSchema: { type: "object" },
          handler: async (input) => {
            calls.push(input);
            return { content: [{ type: "text", text: "TOOL_RESULT_MARKER" }] };
          },
        },
      ],
    });
    await host.send("tool");
    expect(calls).toEqual([{ value: 7 }]);
    expect(
      envelopes.filter((e) => e.type === "result").at(-1)?.payload.text,
    ).toContain("TOOL_RESULT_MARKER");
    expect(envelopes.some((e) => e.state === "tool_running")).toBe(true);
  });
  it("omits OS enforcement for the off profile", async () => {
    const { host } = await started({
      config: {
        ...config,
        sandbox: "danger-full-access",
        network_access: true,
      },
    });
    expect(host.statusExtSnapshot().permission).toEqual({
      sandbox: "danger-full-access",
      approval: "on-request",
    });
    expect(host.statusExtSnapshot().permission_policy).toMatchObject({
      grok_sandbox_env: "off",
    });
  });
  it("delivers tool errors to the agent", async () => {
    const { host, envelopes } = await started({
      toolDescriptors: [
        {
          name: "probe",
          description: "Return an error",
          inputSchema: { type: "object" },
          handler: async () => ({
            isError: true,
            content: [{ type: "text", text: "tool failed" }],
          }),
        },
      ],
    });
    await host.send("error-tool");
    expect(
      envelopes.filter((e) => e.type === "result").at(-1)?.payload.text,
    ).toContain('"isError":true');
  });
  it("does not treat pending_interaction alone as a broker wait", async () => {
    const { host, envelopes } = await started();
    await host.send("pending-only");
    expect(envelopes.some((e) => e.state === "waiting_permission")).toBe(false);
  });
  it("keeps running until every parallel tool call has completed", async () => {
    const { host, envelopes } = await started();
    const start = envelopes.length;
    await host.send("parallel");
    expect(envelopes.slice(start).filter(e => e.type === "state_change")
      .map(e => e.state)).toEqual([
        "sending", "tool_running", "thinking", "done", "waiting_input",
      ]);
    expect(envelopes.filter(e => e.type === "log" && e.payload.kind === "assistant")
      .map(e => ({ state: e.state, payload: e.payload }))).toEqual([
        { state: "thinking", payload: { kind: "assistant", text: "B_STILL_PENDINGfinished" } },
      ]);
    expect(envelopes.find(e => e.type === "result")?.payload.text)
      .toBe("B_STILL_PENDINGfinished");
    expect(host.state).toBe("waiting_input");
  });
  it("stays tool_running while a second parallel tool call is pending", async () => {
    const { host } = await started();
    const received = vi.spyOn(events, "updateEvents");
    const turn = host.send("parallel-hold");
    await vi.waitFor(() => expect(received.mock.calls.some(([notification]) =>
      notification.update.sessionUpdate === "agent_message_chunk")).toBe(true));
    expect(host.state).toBe("tool_running");
    await host.interrupt();
    await turn;
  });
  it.each([
    { scene: "permission", beforeWaitTexts: [], toolNames: ["write fixture"] },
    {
      scene: "permission-no-tool-call",
      beforeWaitTexts: ["Before permission"],
      toolNames: [],
    },
  ])("waits for the broker and reports rejection ($scene)", async ({
    scene, beforeWaitTexts, toolNames,
  }) => {
    let host!: GrokHost;
    const envelopes: Envelope[] = [];
    const broker = new PermissionBroker({
      config,
      send: (e) => envelopes.push(e),
      onPendingChange: (pending) => host.setPendingPermission(pending),
    });
    const startedHost = await started({
      send: (e) => envelopes.push(e),
      decidePermission: (...args) => broker.decide(...args),
    });
    host = startedHost.host;
    const received = vi.spyOn(events, "updateEvents");
    vi.useFakeTimers();
    const turn = host.send(scene);
    void turn.catch(() => {});
    await vi.waitFor(() => expect(host.state).toBe("waiting_permission"));
    const request = envelopes.find((e) => e.type === "permission_request")!;
    await vi.waitFor(() => expect(received.mock.calls.some(([notification]) =>
      notification.update.sessionUpdate === "agent_message_chunk" &&
      notification.update.content.type === "text" &&
      notification.update.content.text === "BROKER_WAIT_PROGRESS")).toBe(true));
    expect(envelopes.filter(e => e.type === "state_change" && e.state === "waiting_permission"))
      .toHaveLength(1);
    const beforeWait = assistantLogs(envelopes);
    expect(beforeWait.map(e => e.payload.text)).toEqual(beforeWaitTexts);
    for (const log of beforeWait) {
      expect(log.state).toBe("thinking");
      expect(envelopes.indexOf(log)).toBeLessThan(
        envelopes.findIndex(e => e.type === "state_change" && e.state === "waiting_permission"));
    }
    expect(envelopes.filter(e => e.type === "log" && e.payload.kind === "tool_use")
      .map(e => e.payload.tool_name)).toEqual(toolNames);
    try {
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
      expect(host.state).toBe("waiting_permission");
    } finally {
      vi.useRealTimers();
    }
    broker.resolve({
      request_id: String(request.payload.request_id),
      allow: false,
    });
    await expect(turn).rejects.toThrow("permission rejected");
    expect(envelopes.filter(e => e.type === "log" && e.payload.kind === "assistant")
      .map(e => e.payload.text)).toEqual([...beforeWaitTexts, "BROKER_WAIT_PROGRESS"]);
    expect(envelopes.findIndex(e => e.type === "log" &&
      e.payload.text === "BROKER_WAIT_PROGRESS")).toBeLessThan(
      envelopes.findIndex(e => e.type === "result"));
    expect(envelopes.filter((e) => e.type === "result")).toHaveLength(1);
    expect(
      envelopes.filter((e) => e.type === "result")[0]?.payload.error_code,
    ).toBe("permission_rejected");
    expect(host.state).toBe("waiting_input");
    await host.send("AFTER_REJECT_TEXT");
    expect(
      envelopes.find(
        (e) =>
          e.type === "log" &&
          e.payload.text === "AFTER_REJECT_TEXT" &&
          e.payload.kind === "assistant",
      )?.state,
    ).toBe("thinking");
    broker.close();
  });
  it("drops unknown bodies and keeps diagnostics content-free", async () => {
    const diagnostics: unknown[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((...args) => {
      diagnostics.push(args);
    });
    const { host, envelopes } = await started({
      onMetadata: (metadata) => diagnostics.push(metadata),
      toolDescriptors: [
        {
          name: "probe",
          description: "Probe",
          inputSchema: { type: "object" },
          handler: async () => ({
            content: [{ type: "text", text: "NORMAL_TOOL_MARKER" }],
          }),
        },
      ],
    });
    await host.send("unknown");
    await host.send("NORMAL_PROMPT_MARKER");
    await host.send("tool");
    expect(JSON.stringify(diagnostics)).not.toContain("UNKNOWN_BODY_MARKER");
    expect(JSON.stringify(envelopes)).not.toContain("UNKNOWN_BODY_MARKER");
    expect(JSON.stringify(diagnostics)).not.toContain("NORMAL_PROMPT_MARKER");
    expect(JSON.stringify(diagnostics)).not.toContain("NORMAL_TOOL_MARKER");
    expect(JSON.stringify(diagnostics)).toContain("future_variant");
    expect(JSON.stringify(diagnostics)).toContain("sdk_diagnostic");
    expect(errors).not.toHaveBeenCalled();
  });
  it("rejects unsupported controls and attachments", async () => {
    const { host } = await started();
    await expect(
      host.setPermission({
        revision: 1,
        requested: { sandbox: "read-only", network_access: false },
      }),
    ).rejects.toThrow("fixed");
    await expect(host.setPermissionMode("default")).rejects.toThrow(
      "unsupported",
    );
    await expect(host.send("image", ["attachment"])).rejects.toThrow(
      "unsupported",
    );
    expect(host.state).toBe("waiting_input");
  });
  it("fails clearly when the executable is absent", async () => {
    const host = new GrokHost({
      config,
      cwd: process.cwd(),
      personaPrompt: "",
      send: () => {},
      decidePermission: async () => ({ allow: false }),
      executable: "/nonexistent/kaoiro-grok-fixture",
    });
    hosts.push(host);
    await expect(host.run()).rejects.toThrow("grok");
    expect(host.state).toBe("error");
  });
  it("fails a turn and leaves running when the child exits", async () => {
    const { host, run } = await started();
    await expect(host.send("exit")).rejects.toThrow();
    await expect(run).rejects.toThrow(
      /(?:exited|connection closed) unexpectedly/,
    );
    expect(["thinking", "tool_running"]).not.toContain(host.state);
  });
  it("cancels and closes the owned tool subtree", async () => {
    const path = mkdtempSync(join(tmpdir(), "kaoiro-grok-child-"));
    scratch.push(path);
    const pidFile = join(path, "pid");
    const { host } = await started({
      env: { ...process.env, KAOIRO_TEST_GROK_PID_FILE: pidFile },
    });
    const turn = host.send("sleep");
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const pid = Number(readFileSync(pidFile, "utf8"));
    await host.interrupt();
    await turn;
    host.close();
    await host.closed;
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it("bounds shutdown of the owned stubborn group", async () => {
    const path = mkdtempSync(join(tmpdir(), "kaoiro-grok-stubborn-"));
    scratch.push(path);
    const pidFile = join(path, "pid");
    const outside = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    try {
      const processHost = new GrokProcess(executable, process.cwd(), {
        ...process.env,
        KAOIRO_TEST_GROK_IGNORE_TERM: "1",
        KAOIRO_TEST_GROK_PID_FILE: pidFile,
      });
      const pid = processHost.child.pid!;
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), {
        timeout: 5_000,
      });
      const child = Number(readFileSync(pidFile, "utf8"));
      const start = Date.now();
      await processHost.close();
      expect(Date.now() - start).toBeLessThan(4_500);
      await vi.waitFor(() => expect(() => process.kill(-pid, 0)).toThrow());
      expect(() => process.kill(child, 0)).toThrow();
      expect(() => process.kill(outside.pid!, 0)).not.toThrow();
    } finally {
      const exited = new Promise((resolve) => outside.once("exit", resolve));
      outside.kill("SIGTERM");
      await exited;
    }
  });
  it("bounds an unanswered tool call", async () => {
    const { host } = await started({
      toolDescriptors: [
        {
          name: "probe",
          description: "Never answer",
          inputSchema: { type: "object" },
          handler: async () => new Promise(() => {}),
        },
      ],
    });
    vi.useFakeTimers();
    try {
      const turn = host.send("hang-tool");
      void turn.catch(() => {});
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
      await expect(turn).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
    await host.closed;
  });
});

describe("metadata of a loading generation (issue #633)", () => {
  const isStart = (m: GrokWireMetadata) => m.hook_event === "session_start";
  it("publishes the start-up session_start at promotion, before any prompt", async () => {
    const metadata: GrokWireMetadata[] = [];
    const { host } = await started({ onMetadata: (m) => metadata.push(m) });
    expect(metadata.filter(isStart)).toHaveLength(1);
    await host.send("hello");
    expect(metadata.filter(isStart)).toHaveLength(1);
    const prompt = metadata.findIndex(
      (m) => m.direction === "out" && m.method === "session/prompt",
    );
    expect(prompt).toBeGreaterThan(metadata.findIndex(isStart));
  });
  it("bounds what a loading generation holds and reports the rest", async () => {
    const metadata: GrokWireMetadata[] = [];
    await started({
      onMetadata: (m) => metadata.push(m),
      env: { ...process.env, KAOIRO_TEST_GROK_LOADING_FLOOD: "300" },
    });
    const marker = metadata.findIndex((m) => m.loading_lines_dropped !== undefined);
    expect(marker).toBe(256);
    const held = metadata.slice(0, marker);
    const flood = held.filter((m) => m.vendor_kind === "loading_flood").length;
    expect(flood + metadata[marker]!.loading_lines_dropped!).toBe(300);
    expect(held.some(isStart)).toBe(true);
  });
  it("neither fails the promotion nor repeats records when the observer throws", async () => {
    const seen: GrokWireMetadata[] = [];
    let thrown = false;
    const { host } = await started({
      onMetadata: (m) => {
        seen.push(m);
        if (!thrown && isStart(m)) {
          thrown = true;
          throw new Error("observer failure");
        }
      },
    });
    expect(thrown).toBe(true);
    expect(seen.filter(isStart)).toHaveLength(1);
    expect(new Set(seen).size).toBe(seen.length);
    await host.send("after");
    expect(host.state).toBe("waiting_input");
  });
});

describe("kaoiro MCP over HTTP (issue #604)", () => {
  const descriptors = [
    {
      name: "probe",
      description: "Return a probe value",
      inputSchema: { type: "object" },
      handler: async () => ({
        content: [{ type: "text" as const, text: "TOOL_RESULT_MARKER" }],
      }),
    },
  ];
  function build(mode: string, extra: Partial<GrokHostOptions> = {}) {
    const envelopes: Envelope[] = [];
    const host = new GrokHost({
      config: { ...config },
      cwd: process.cwd(),
      personaPrompt: "PERSONA_AND_FOOTER",
      send: (e) => envelopes.push(e),
      decidePermission: async () => ({ allow: false }),
      executable,
      toolDescriptors: descriptors,
      env: { ...process.env, KAOIRO_TEST_GROK_MCP_MODE: mode },
      mcpReadyTimeoutMs: 400,
      ...extra,
    });
    hosts.push(host);
    return { host, envelopes };
  }

  it("reaches waiting_input only after an authenticated tools/list", async () => {
    const listsAtWaiting: (number | undefined)[] = [];
    let host!: GrokHost;
    const built = build("ok", {
      send: (e) => {
        if (e.type === "state_change" && e.state === "waiting_input") {
          listsAtWaiting.push(host.toolHostStats()?.authenticatedLists);
        }
      },
      mcpReadyTimeoutMs: 5_000,
    });
    host = built.host;
    void host.run().catch(() => {});
    await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
      timeout: 5_000,
    });
    expect(listsAtWaiting[0]).toBeGreaterThanOrEqual(1);
  });

  it.each(["never-connect", "drop-headers", "wrong-token"])(
    "fails startup with its reason when Grok never lists the tools: %s",
    async (mode) => {
      const { host, envelopes } = build(mode);
      await expect(host.run()).rejects.toThrow(
        "kaoiro MCP server did not connect",
      );
      expect(host.state).toBe("error");
      expect(
        envelopes.filter((e) => e.type === "log").map((e) => e.payload),
      ).toContainEqual({
        kind: "system",
        text: "kaoiro MCP server did not connect",
      });
    },
  );

  it("fails startup when Grok does not support HTTP MCP servers", async () => {
    const { host, envelopes } = build("no-http");
    await expect(host.run()).rejects.toThrow(
      "grok does not support HTTP MCP servers",
    );
    expect(host.state).toBe("error");
    expect(
      envelopes.filter((e) => e.type === "log").map((e) => e.payload),
    ).toContainEqual({
      kind: "system",
      text: "grok does not support HTTP MCP servers",
    });
  });

  it("keeps the token out of every surface the wrapper writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-grok-token-"));
    scratch.push(dir);
    const tokenFile = join(dir, "token");
    const scanFile = join(dir, "scan.json");
    // A value with no secret in it, planted through each surface's real path.
    const canary = "CANARY_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const stderrChunks: Buffer[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderrChunks.push(Buffer.from(chunk));
      return true;
    }) as never);
    const envelopes: Envelope[] = [];
    const statuses: string[] = [];
    const metadata: unknown[] = [];
    let host!: GrokHost;
    const built = build("ok", {
      mcpReadyTimeoutMs: 5_000,
      send: (e) => {
        envelopes.push(e);
        if (e.type === "state_change") {
          statuses.push(JSON.stringify(host.statusExtSnapshot()));
        }
      },
      onMetadata: (m) => metadata.push(m),
      env: {
        ...process.env,
        KAOIRO_TEST_GROK_TOKEN_FILE: tokenFile,
        KAOIRO_TEST_GROK_SCAN_FILE: scanFile,
        KAOIRO_TEST_GROK_CANARY: canary,
      },
    });
    host = built.host;
    void host.run().catch(() => {});
    await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
      timeout: 5_000,
    });
    await host.send("tool");
    // The controls: a canary through stderr in two chunks split inside it,
    // through the assistant text and a notification's prompt_id, and through a
    // pending question in the status.
    process.stderr.write(canary.slice(0, 20));
    process.stderr.write(canary.slice(20));
    await host.send("canary");
    host.setPendingQuestion({
      request_id: "q-1",
      ts: "2026-10-14T00:00:00Z",
      questions: [
        { question: canary, header: "h", multiSelect: false, options: [] },
      ],
    });
    statuses.push(JSON.stringify(host.statusExtSnapshot()));
    host.setPendingQuestion(null);

    const token = readFileSync(tokenFile, "utf8");
    expect(token.length).toBeGreaterThanOrEqual(43);
    const surfaces = {
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      envelopes: JSON.stringify(envelopes),
      status: statuses.join("\n"),
      metadata: JSON.stringify(metadata),
    };
    const occurrences = (text: string, needle: string) =>
      text.split(needle).length - 1;
    for (const [name, text] of Object.entries(surfaces)) {
      expect(occurrences(text, canary), `${name} carries the canary`)
        .toBeGreaterThanOrEqual(1);
      expect(occurrences(text, token), `${name} carries the token`).toBe(0);
    }
    // And not the places a process can be read from.
    expect(JSON.parse(readFileSync(scanFile, "utf8"))).toMatchObject({
      type: "http",
      tokenInArgv: false,
      tokenInEnv: false,
      tokenInUrl: false,
    });
  });
});
