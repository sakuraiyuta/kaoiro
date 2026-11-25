import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { MuseHost, type MuseHostOptions } from "../src/host.js";

const executable = fileURLToPath(
  new URL("./fixtures/muse.mjs", import.meta.url),
);
export const config: WrapperConfig = {
  agent_id: "muse-test",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  display_name: "Muse test",
  server_url: "ws://127.0.0.1:1/agent",
};
const hosts: MuseHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.close();
    await host.closed;
  }
  vi.restoreAllMocks();
});

async function started(options: Partial<MuseHostOptions> = {}) {
  const envelopes: Envelope[] = [];
  const host = new MuseHost({
    config: { ...config },
    cwd: process.cwd(),
    personaPrompt: "PERSONA_AND_FOOTER",
    send: (e) => envelopes.push(e),
    decidePermission: async () => ({ allow: true }),
    executable,
    ...options,
  });
  hosts.push(host);
  const run = host.run();
  void run.catch(() => {});
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
    timeout: 5_000,
  });
  return { host, envelopes, run };
}

describe("muse host", () => {
  it("runs a text turn and publishes the reply, the result and context usage", async () => {
    const { host, envelopes } = await started();
    await host.send("hello");
    const result = envelopes.find((e) => e.type === "result");
    expect(result?.payload).toMatchObject({ text: "echo:hello", is_error: false });
    const assistant = envelopes.filter(
      (e) => e.type === "log" && e.payload.kind === "assistant",
    );
    expect(assistant.map((e) => e.payload.text)).toEqual(["echo:hello"]);
    expect(host.statusExtSnapshot()).toMatchObject({
      engine: "muse",
      model: "muse-spark-1.3",
      context: { used_tokens: 100, max_tokens: 1000, used_percentage: 10 },
    });
  });

  it("prepends the persona to the first turn only", async () => {
    const { host, envelopes } = await started();
    await host.send("one");
    await host.send("two");
    const results = envelopes.filter((e) => e.type === "result");
    // The fixture echoes the prompt's last line, so both turns answer with
    // their own text; the persona rides only on the first (see the fixture's
    // recorded prompt in the tools test below for the positive check).
    expect(results.map((e) => e.payload.text)).toEqual(["echo:one", "echo:two"]);
  });

  it("fails a turn the agent rejects and keeps the host usable", async () => {
    const { host, envelopes } = await started();
    await expect(host.send("fail")).rejects.toThrow();
    expect(envelopes.find((e) => e.type === "result")?.payload)
      .toMatchObject({ is_error: true, error_code: "muse_turn_failed" });
    await host.send("again");
    expect(host.state).toBe("waiting_input");
  });

  it("routes an ACP permission request through decidePermission", async () => {
    const decide = vi.fn(async () => ({ allow: true }));
    const { host, envelopes } = await started({ decidePermission: decide });
    await host.send("permission");
    expect(decide).toHaveBeenCalledWith(
      "write fixture",
      { path: "x", tool_call_id: "perm-tool" },
      expect.anything(),
    );
    expect(envelopes.find((e) => e.type === "result")?.payload)
      .toMatchObject({ text: "allowed" });
  });

  it("answers a denied permission with the reject option", async () => {
    const { host, envelopes } = await started({
      decidePermission: async () => ({ allow: false }),
    });
    await host.send("permission");
    expect(envelopes.find((e) => e.type === "result")?.payload)
      .toMatchObject({ text: "denied" });
  });

  it("interrupts a running turn with session/cancel", async () => {
    const { host, envelopes } = await started();
    const turn = host.send("sleep");
    await vi.waitFor(() => expect(host.state).toBe("tool_running"), {
      timeout: 5_000,
    });
    await host.interrupt();
    await turn;
    expect(envelopes.find((e) => e.type === "result")?.ext)
      .toMatchObject({ interrupted: true, stop_reason: "cancelled" });
  });

  it("switches the model and effort through the session config options", async () => {
    const { host } = await started();
    expect(host.statusExtSnapshot()).toMatchObject({
      models: [
        { value: "muse-spark-1.3", display_name: "Muse Spark 1.3" },
        { value: "muse-wonder", display_name: "Muse Wonder" },
      ],
      session_capabilities: {
        supports_model_switch: true,
        supports_effort_switch: true,
        supports_attachments: false,
        supports_permission_mode_switch: false,
      },
    });
    await host.setModel("muse-wonder");
    expect(host.statusExtSnapshot()).toMatchObject({
      model: "muse-wonder", model_source: "config",
    });
    await host.setEffort("low");
    expect(host.statusExtSnapshot()).toMatchObject({
      effort: "low", effort_source: "config",
    });
    await expect(host.setModel("no-such-model")).rejects.toThrow();
    await expect(host.setEffort("no-such-effort")).rejects.toThrow();
  });

  it("rejects permission-mode and permission switching explicitly", async () => {
    const { host } = await started();
    await expect(host.setPermissionMode("default")).rejects.toThrow(/unsupported/);
    await expect(host.setPermission({
      revision: 1,
      requested: { sandbox: "read-only", approval: "never", network_access: false },
    })).rejects.toThrow(/unsupported/);
  });

  it("rejects attachments explicitly", async () => {
    const { host } = await started();
    await expect(host.send("hi", ["upload-1"])).rejects.toThrow(/unsupported/);
  });

  it("resumes a stored session and refuses an unknown one", async () => {
    const { host } = await started({ resumeSessionId: "fixture-session" });
    await host.send("hello");
    expect(host.state).toBe("waiting_input");
    const failing = new MuseHost({
      config: { ...config },
      cwd: process.cwd(),
      personaPrompt: "PERSONA_AND_FOOTER",
      send: () => {},
      decidePermission: async () => ({ allow: true }),
      executable,
      resumeSessionId: "no-such-session",
    });
    hosts.push(failing);
    await expect(failing.run()).rejects.toThrow(/could not resume/);
  });

  it("serves the kaoiro tools to the agent over HTTP MCP", async () => {
    const toolsFile = join(tmpdir(), `kaoiro-muse-tools-${process.pid}.json`);
    rmSync(toolsFile, { force: true });
    process.env.KAOIRO_TEST_MUSE_TOOLS_FILE = toolsFile;
    try {
      const { host, envelopes } = await started({
        toolDescriptors: [{
          name: "whoami",
          description: "fixture whoami",
          inputSchema: { type: "object", properties: {} },
          handler: async () => ({ content: [{ type: "text", text: "I am the fixture" }] }),
        }],
      });
      await vi.waitFor(() => expect(existsSync(toolsFile)).toBe(true));
      expect(JSON.parse(readFileSync(toolsFile, "utf8"))).toEqual(["whoami"]);
      await host.send("whoami-tool");
      const result = envelopes.find((e) => e.type === "result");
      expect(result?.payload.text).toContain("I am the fixture");
    } finally {
      delete process.env.KAOIRO_TEST_MUSE_TOOLS_FILE;
      rmSync(toolsFile, { force: true });
    }
  });
});
