import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import type { Envelope } from "@kaoiro/agent-common";
import { runMuseCli } from "../src/cli.js";
import { MuseHost } from "../src/host.js";

it.each([
  ["new", "allow", "end", 1],
  ["clear", "allow", "end", 1],
  ["new", "deny", "end", 0],
  ["new", "allow", "cancel", 0],
  ["new", "allow", "fail", 0],
  ["new", "none", "end", 0],
])("reset %s with %s and %s dispatches %i times", async (mode, answer, end, count) => {
  const root = mkdtempSync(join(tmpdir(), "muse-reset-cli-"));
  const envelopes: Envelope[] = [];
  const resets: string[] = [];
  const timeline: string[] = [];
  let host!: MuseHost;
  const work = runMuseCli({
    parseCliArgs: () => ({ configPath: "unused" }),
    loadConfig: () => ({ agent_id: "muse-test", server_url: "ws://localhost",
      persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
      ...(answer === "none" ? { permission_timeout_ms: 100 } : {}) }),
    loadWrapperBuildInfo: () => ({ revision: "unknown", dirty: false,
      built_at: "unknown", version: "unknown", channel: "dev" }),
    createServerLink: (_url, _id, options: ServerLinkOptions) => {
      queueMicrotask(() => options.onPersonaPrompt?.("persona"));
      return {
        send: (e: Envelope) => {
          envelopes.push(e);
          timeline.push(e.type);
          if (e.type === "permission_request" && answer !== "none") queueMicrotask(() =>
            options.onPermissionDecision?.({ request_id: String(e.payload.request_id),
              allow: answer === "allow" }));
        },
        requestSessionReset: async (value: string) => {
          timeline.push("reset");
          resets.push(value);
          return { requestId: "reset-1" };
        },
        close() {}, setSessionId() {}, reportDisconnectIntent: async () => {},
      } as unknown as ServerLink;
    },
    createHost: options => new MuseHost({ ...options, cwd: root,
      executable: fileURLToPath(new URL("./fixtures/muse.mjs", import.meta.url)),
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") } }),
    onHostCreated: value => { host = value; },
  });
  try {
    await vi.waitFor(() => expect(host?.state).toBe("waiting_input"), { timeout: 5_000 });
    expect(host.statusExtSnapshot().session_capabilities).toMatchObject({
      supports_session_reset: true, session_reset_modes: ["new", "clear"],
    });
    await host.send(`reset:${mode}:${end}`).catch(() => {});
    if (count) await vi.waitFor(() => expect(resets).toHaveLength(count));
    else await new Promise(resolve => setTimeout(resolve, 250));
    expect(resets).toHaveLength(count);
    if (count) {
      expect(resets).toEqual([mode]);
      expect(timeline.indexOf("result")).toBeGreaterThanOrEqual(0);
      expect(timeline.indexOf("result")).toBeLessThan(timeline.indexOf("reset"));
    }
    expect(envelopes.filter(e => e.type === "permission_request")).toHaveLength(1);
  } finally {
    host?.close();
    await work;
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
