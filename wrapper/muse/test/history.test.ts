import "../../../scripts/test/fixtures/test-isolation.mjs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseHost } from "../src/host.js";
import { MuseHistoryCollector } from "../src/history.js";
import type { WrapperConfig } from "@kaoiro/agent-common";
const config: WrapperConfig = {
  agent_id: "muse-history-test",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  display_name: "Muse history test",
  server_url: "ws://127.0.0.1:1/agent",
};

const executable = fileURLToPath(new URL("./fixtures/muse.mjs", import.meta.url));
const hosts: MuseHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.close();
    await host.closed;
  }
});

async function start(mode: string, timeout = 1000,
  handler = vi.fn(async () => ({ content: [] }))) {
  const host = new MuseHost({ config, cwd: process.cwd(), personaPrompt: "test",
    send: () => {}, decidePermission: async () => ({ allow: true }), executable,
    resumeSessionId: "fixture-session", historyTimeoutMs: timeout,
    toolDescriptors: [{ name: "past", description: "test",
      inputSchema: { type: "object" }, handler }],
    env: { ...process.env, KAOIRO_TEST_HISTORY: mode } });
  hosts.push(host);
  void host.run().catch(() => {});
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"));
  return host;
}

describe("Muse history", () => {
  it("collects ordered text without executing past tool calls", async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    const host = await start("ok", 1000, handler);
    const logs = await new Promise<unknown[]>((resolve, reject) => {
      host.scheduleHistoryReplay(async read => {
        try { resolve((await read()).logs); } catch (error) { reject(error); }
      });
    });
    expect(logs.map((x: any) => [x.payload.kind, x.payload.text])).toEqual([
      ["user", "hello world"], ["assistant", "answer"],
    ]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("holds a turn until the load completes", async () => {
    const host = await start("delay");
    let completed = false;
    const load = new Promise<void>(resolve => host.scheduleHistoryReplay(async read => {
      await read(); completed = true; resolve();
    }));
    const turn = host.send("hello").then(() => expect(completed).toBe(true));
    await Promise.all([load, turn]);
  });

  it.each(["error", "hang", "permission"])("closes after %s without returning partial history", async mode => {
    const host = await start(mode, 100);
    const result = new Promise<boolean>(resolve => host.scheduleHistoryReplay(async read => {
      try { await read(); resolve(false); } catch { resolve(true); }
    }));
    expect(await result).toBe(true);
    await host.closed;
    await expect(host.send("after")).rejects.toThrow();
  });


  it("discards an in-flight load when the host closes", async () => {
    const host = await start("hang");
    let begun!: () => void;
    const started = new Promise<void>(resolve => { begun = resolve; });
    const result = new Promise<boolean>(resolve => host.scheduleHistoryReplay(async read => {
      const pending = read();
      begun();
      try { await pending; resolve(false); } catch { resolve(true); }
    }));
    await started;
    const turn = host.send("queued");
    host.close();
    expect(await result).toBe(true);
    await expect(turn).rejects.toThrow();
  });

  it("omits injected inter-agent messages and image blocks", () => {
    const collector = new MuseHistoryCollector(config, "s");
    collector.update({ sessionId: "s", update: { sessionUpdate: "user_message_chunk",
      content: { type: "text", text:
        '[Inter-agent message — to reply, call send_to_agent with conversation_id="x".]' },
    } });
    collector.update({ sessionId: "s", update: { sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "YQ==", mimeType: "image/png" },
    } });
    collector.update({ sessionId: "s", update: { sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "visible" },
    } });
    expect(collector.finish().map(log => log.payload.text)).toEqual(["visible"]);
  });

  it("keeps only the newest 200 display rows", () => {
    const collector = new MuseHistoryCollector(config, "s");
    for (let i = 0; i < 205; i++) collector.update({ sessionId: "s", update: {
      sessionUpdate: i % 2 ? "agent_message_chunk" : "user_message_chunk",
      content: { type: "text", text: String(i) },
    } });
    const logs = collector.finish();
    expect(logs).toHaveLength(200);
    expect(logs[0]?.payload.text).toBe("5");
  });
});
