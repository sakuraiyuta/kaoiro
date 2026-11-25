import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { ServerLink } from "@kaoiro/wrapper-core";
import { ToolHost } from "@kaoiro/agent-common/dist/toolhost.js";
import { runMuseCli } from "../src/cli.js";
import { MuseHost } from "../src/host.js";

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
