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

it.each([
  ["high", true], [" ", true], ["x".repeat(257), true],
  ["", false], [42, false], [undefined, false],
])("loads effort %j and warns=%s", async (effort, warned) => {
  const root = mkdtempSync(join(tmpdir(), "muse-effort-cli-"));
  const path = join(root, "config.json");
  const launch = join(root, "launch.json");
  writeFileSync(path, JSON.stringify({ agent_id: "muse-test", server_url: "ws://localhost",
    persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", effort }));
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
      env: { ...process.env, KAOIRO_TEST_LAUNCH_FILE: launch } }),
    onMetadata: (event) => { if (event.direction === "out" && event.method) methods.push(event.method); },
    onHostCreated: (value) => { host = value; },
  });
  try {
    await vi.waitFor(() => expect(host?.state).toBe("waiting_input"), { timeout: 5_000 });
    await host.send("hello");
    const warnings = envelopes.filter((e) => e.type === "log" &&
      e.payload.kind === "system" && String(e.payload.text).includes("ignores the configured effort"));
    expect(warnings).toHaveLength(warned ? 1 : 0);
    expect(JSON.parse(readFileSync(launch, "utf8")).args).toEqual(["acp"]);
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
      expect(state.ext).toMatchObject({ model: "muse-spark-1.3", effort: "high",
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
