import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";

// A kill request that throws synchronously (issue 594) must not fail the
// interrupted turn.
vi.mock("../src/grok/wire.js", async (original) => ({
  ...(await original<typeof import("../src/grok/wire.js")>()),
  grokKillTask: () => { throw new Error("synchronous kill failure"); },
}));
const { GrokHost } = await import("../src/host.js");

const executable = fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url));
const config: WrapperConfig = {
  agent_id: "background-kill-throw-594", display_name: "Kill throw", server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  sandbox: "workspace-write", network_access: true,
};

it("keeps the interrupted result when the kill request throws", async () => {
  const root = mkdtempSync(join(homedir(), ".kaoiro-grok-594t-"));
  const envelopes: Envelope[] = [];
  const host = new GrokHost({ config: { ...config }, cwd: root, personaPrompt: "fixture", executable,
    send: (e) => envelopes.push(e), decidePermission: async () => ({ allow: true }) });
  void host.run().catch(() => {});
  try {
    await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 10_000 });
    const turn = host.send("bg-two");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await host.interrupt();
    await turn;
    const results = envelopes.filter((e) => e.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]?.ext).toMatchObject({ stop_reason: "cancelled", interrupted: true });
    expect(results[0]?.payload).toMatchObject({ is_error: false });
    expect(envelopes.filter((e) => e.type === "log" && e.payload.kind === "system" &&
      String(e.payload.text).endsWith("(the request failed)"))).toHaveLength(2);
  } finally {
    host.close();
    await host.closed;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
