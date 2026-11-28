import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import type { Envelope } from "@kaoiro/agent-common";
import { ToolHost } from "@kaoiro/agent-common/dist/toolhost.js";
import { runMuseCli } from "../src/cli.js";
import { MuseHost } from "../src/host.js";

it.each(["data", "message", "code", "generic"])(
  "keeps the failed instruction and peer notice generic: %s", async (scenario) => {
  let host!: MuseHost;
  let callbacks!: ServerLinkOptions;
  const { RecoveryReporter } = await import("@kaoiro/wrapper-core");
  const recovery = new RecoveryReporter({ agent_id: "muse-test",
    server_url: "ws://localhost", persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P" }, undefined, () => {});
  const wireError = scenario === "message"
    ? { code: -32603, message: { marker: "MESSAGE_MARKER_1278" } }
    : scenario === "code"
      ? { code: { marker: "CODE_MARKER_1278" }, message: "rate limit" }
      : { code: -32603, message: "rate limit", data: "DATA_MARKER_1278" };
  const envelopes: Envelope[] = [];
  const work = runMuseCli({
    parseCliArgs: () => ({ configPath: "unused" }),
    loadConfig: () => ({ agent_id: "muse-test", server_url: "ws://localhost",
      persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P" }),
    loadWrapperBuildInfo: () => ({ revision: "unknown", dirty: false,
      built_at: "unknown", version: "unknown", channel: "dev" }),
    createServerLink: (_url, _id, options) => {
      callbacks = options;
      queueMicrotask(() => callbacks.onPersonaPrompt?.("persona"));
      return { send: (e: Envelope) => envelopes.push(e), close() {},
        deliveryIncarnation: () => null, deliveryGeneration: () => null,
        acknowledgeInterAgentDelivery: () => {},
        setSessionId() {}, reportDisconnectIntent: async () => {} } as unknown as ServerLink;
    },
    createHost: (options) => new MuseHost({ ...options, recovery,
      executable: fileURLToPath(new URL("./fixtures/muse.mjs", import.meta.url)),
      env: { ...process.env, ...(scenario === "generic" ? {} : {
        KAOIRO_TEST_MUSE_PROMPT_ERROR: JSON.stringify(wireError),
      }) } }),
    onHostCreated: (value) => { host = value; },
  });
  try {
    await vi.waitFor(() => expect(host?.state).toBe("waiting_input"), { timeout: 5_000 });
    if (scenario === "generic") vi.spyOn(recovery, "confirm")
      .mockImplementation(() => { throw new Error("GENERIC_MARKER_1278"); });
    callbacks.onInstruction?.("hello");
    await vi.waitFor(() => expect(envelopes.some((e) => e.type === "log" &&
      e.payload.text === "muse turn failed")).toBe(true), { timeout: 5_000 });
    expect(JSON.stringify(envelopes)).not.toMatch(/(?:DATA|MESSAGE|CODE|GENERIC)_MARKER_1278/);
    const logs = envelopes.filter((e) => e.type === "log" &&
      e.payload.kind === "system" && String(e.payload.text).includes("turn failed"));
    expect(logs.map((e) => e.payload.text)).toEqual(["muse turn failed"]);
    callbacks.onInterAgentMessage?.({ version: "0", agent_id: "peer",
      persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "Peer",
      ts: "2026-11-28T00:00:00Z", type: "inter_agent_message", state: "thinking",
      payload: { to: "muse-test", conversation_id: "test-conversation",
        turn_number: 1, kind: "request", body: "hello",
        meta: { done: false, propose_next: "" } } } as unknown as Envelope);
    await vi.waitFor(() => expect(envelopes.some((e) =>
      e.type === "inter_agent_message" && e.payload.error)).toBe(true), { timeout: 5_000 });
    const notice = envelopes.find((e) =>
      e.type === "inter_agent_message" && e.payload.error)!;
    expect(notice.payload.error).toMatchObject({ code: "api_error" });
    expect(JSON.stringify(notice)).not.toMatch(/(?:DATA|MESSAGE|CODE|GENERIC)_MARKER_1278/);
  } finally {
    host?.close();
    await work;
  }
});

it.each(["low", undefined])("loads fresh effort %j", async (effort) => {
  const root = mkdtempSync(join(tmpdir(), "muse-effort-cli-"));
  const path = join(root, "config.json");
  const launch = join(root, "launch.json");
  writeFileSync(path, JSON.stringify({ agent_id: "muse-test", server_url: "ws://localhost",
    persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", model: "muse-spark-1.2", effort }));
  const envelopes: Envelope[] = [];
  const methods: string[] = [];
  let host!: MuseHost;
  const work = runMuseCli({
    parseCliArgs: () => ({ configPath: path }),
    loadWrapperBuildInfo: () => ({ revision: "unknown", dirty: false,
      built_at: "unknown", version: "unknown", channel: "dev" }),
    createServerLink: (_url, _id, options) => {
      queueMicrotask(() => options.onPersonaPrompt?.("persona"));
      return { send: (envelope: Envelope) => envelopes.push(envelope), close() {},
        setSessionId() {}, reportDisconnectIntent: async () => {} } as unknown as ServerLink;
    },
    createHost: (options) => new MuseHost({ ...options,
      executable: fileURLToPath(new URL("./fixtures/muse.mjs", import.meta.url)),
      env: { ...process.env, KAOIRO_TEST_LAUNCH_FILE: launch, KAOIRO_TEST_MUSE_EFFORT: "xhigh" } }),
    onMetadata: (event) => { if (event.direction === "out" && event.method) methods.push(event.method); },
    onHostCreated: (value) => { host = value; },
  });
  try {
    await vi.waitFor(() => expect(host?.state).toBe("waiting_input"), { timeout: 5_000 });
    const warnings = envelopes.filter((e) => e.type === "log" &&
      e.payload.kind === "system" && String(e.payload.text).includes("Muse effort configured at launch"));
    expect(warnings).toHaveLength(effort ? 1 : 0);
    expect(host.statusExtSnapshot()).not.toHaveProperty("effort");
    expect(host.statusExtSnapshot()).not.toHaveProperty("effort_source");
    if (effort) {
      const stateIndex = envelopes.findIndex((e) =>
        e.type === "state_change" && e.state === "waiting_input");
      expect(stateIndex).toBeGreaterThanOrEqual(0);
      expect(envelopes.findIndex((e) => warnings.includes(e))).toBe(stateIndex + 1);
      expect(methods).not.toContain("session/prompt");
    }
    await host.send("hello");
    const argv = ["acp", "--model", "muse-spark-1.2"];
    if (effort) argv.push("-c", 'model_reasoning_efforts={"muse-spark-1.2":"low"}');
    expect(JSON.parse(readFileSync(launch, "utf8")).args).toEqual(argv);
    expect(methods).not.toContain("session/set_config_option");
  } finally {
    host?.close();
    await work;
    rmSync(root, { recursive: true, force: true });
  }
});

it("republishes the unchanged response after rejected live controls", async () => {
  let host!: MuseHost;
  let callbacks!: ServerLinkOptions;
  const envelopes: Envelope[] = [];
  const work = runMuseCli({
    parseCliArgs: () => ({ configPath: "unused" }),
    loadConfig: () => ({ agent_id: "muse-test", server_url: "ws://localhost",
      persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P" }),
    loadWrapperBuildInfo: () => ({ revision: "unknown", dirty: false,
      built_at: "unknown", version: "unknown", channel: "dev" }),
    createServerLink: (_url, _id, options) => {
      callbacks = options;
      queueMicrotask(() => callbacks.onPersonaPrompt?.("persona"));
      return { send: (envelope: Envelope) => envelopes.push(envelope), close() {},
        setSessionId() {},
        reportDisconnectIntent: async () => {} } as unknown as ServerLink;
    },
    createHost: (options) => new MuseHost({ ...options,
      executable: fileURLToPath(new URL("./fixtures/muse.mjs", import.meta.url)) }),
    onHostCreated: (value) => { host = value; },
  });
  try {
    await vi.waitFor(() => expect(host?.state).toBe("waiting_input"), {
      timeout: 5_000,
    });
    const count = envelopes.filter((e) => e.type === "state_change").length;
    callbacks.onSetModel?.("muse-wonder");
    callbacks.onSetEffort?.("low");
    await vi.waitFor(() => expect(envelopes.filter((e) => e.type === "state_change"))
      .toHaveLength(count + 2));
    const states = envelopes.filter((e) => e.type === "state_change").slice(-2);
    for (const state of states) {
      expect(state.ext).not.toHaveProperty("effort");
      expect(state.ext).toMatchObject({ model: "muse-spark-1.3",
        session_capabilities: { supports_model_switch: false, supports_effort_switch: false } });
    }
  } finally {
    host?.close();
    await work;
  }
});

it("leaves the CLI after close interrupts a pending listener", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const actualListen = ToolHost.listen.bind(ToolHost);
  let entered!: () => void;
  const listening = new Promise<void>((resolve) => { entered = resolve; });
  let late!: ToolHost;
  const listen = vi.spyOn(ToolHost, "listen").mockImplementation(async (...args) => {
    entered();
    await gate;
    late = await actualListen(...args);
    vi.spyOn(late, "close");
    return late;
  });
  let host!: MuseHost;
  let disconnected = false;
  const work = runMuseCli({
    parseCliArgs: () => ({ configPath: "unused" }),
    loadConfig: () => ({ agent_id: "muse-test", server_url: "ws://localhost",
      persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P" }),
    loadWrapperBuildInfo: () => ({ revision: "unknown", dirty: false,
      built_at: "unknown", version: "unknown", channel: "dev" }),
    createServerLink: (_url, _id, callbacks) => {
      queueMicrotask(() => callbacks.onPersonaPrompt?.("persona"));
      return { send() {}, close() {}, reportDisconnectIntent: async () => {
        disconnected = true;
      } } as unknown as ServerLink;
    },
    onHostCreated: (value) => { host = value; },
  });
  try {
    await listening;
    host.close();
    await work;
    expect(disconnected).toBe(true);
  } finally {
    release();
    await vi.waitFor(() => expect(late?.close).toHaveBeenCalledOnce());
    listen.mockRestore();
  }
});

it("leaves the CLI after close interrupts a pending ACP request", async () => {
  let host!: MuseHost;
  let disconnected = false;
  let initialized = false;
  const work = runMuseCli({
    parseCliArgs: () => ({ configPath: "unused" }),
    loadConfig: () => ({ agent_id: "muse-test", server_url: "ws://localhost",
      persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P" }),
    loadWrapperBuildInfo: () => ({ revision: "unknown", dirty: false,
      built_at: "unknown", version: "unknown", channel: "dev" }),
    createServerLink: (_url, _id, callbacks) => {
      queueMicrotask(() => callbacks.onPersonaPrompt?.("persona"));
      return { send() {}, close() {}, reportDisconnectIntent: async () => {
        disconnected = true;
      } } as unknown as ServerLink;
    },
    createHost: (options) => new MuseHost({ ...options,
      executable: fileURLToPath(new URL("./fixtures/muse.mjs", import.meta.url)),
      env: { ...process.env, KAOIRO_TEST_MUSE_HANG_NEW: "1" } }),
    onHostCreated: (value) => { host = value; },
    onMetadata: (event) => {
      if (event.direction === "out" && event.method === "session/new") initialized = true;
    },
  });
  try {
    await vi.waitFor(() => expect(initialized).toBe(true), { timeout: 4_000 });
    host.close();
    await work;
    expect(disconnected).toBe(true);
  } finally {
    host?.close();
  }
});
