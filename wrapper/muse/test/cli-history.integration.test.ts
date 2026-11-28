import "../../../scripts/test/fixtures/test-isolation.mjs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { phoenixLoopback } from "../../../runner/test/fixtures/phoenix_loopback.js";
import { MuseHost } from "../src/host.js";
import { runMuseCli } from "../src/cli.js";

const executable = fileURLToPath(new URL("./fixtures/muse.mjs", import.meta.url));

it("hydrates through ServerLink, preserves reset capability and skips a false verdict", async () => {
  const wire = await phoenixLoopback(n => ({ hydration: n === 2
    ? { replay_required: false } : { replay_required: true, replay_id: `r${n}` } }));
  let host: MuseHost | undefined;
  const running = runMuseCli({
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => ({ agent_id: "history-cli", display_name: "History",
      persona: { id: "default", name: "Default", sprite_set: "default" },
      server_url: wire.url, resume_session_id: "fixture-session" }),
    createHost: options => {
      host = new MuseHost({ ...options, executable,
        env: { ...process.env, KAOIRO_TEST_HISTORY: "ok" } });
      return host;
    },
  });
  void running.catch(() => {});
  try {
    await vi.waitFor(() => expect(wire.joins).toBe(1), { timeout: 10_000 });
    wire.push("persona_prompt", { prompt: "persona" });
    const completed = () => wire.received.filter(e => e.event === "history_replay_complete");
    await vi.waitFor(() => expect(completed()).toHaveLength(1), { timeout: 10_000 });
    const begin = wire.received.findIndex(e => e.event === "history_reset");
    const end = wire.received.findIndex(e => e.event === "history_replay_complete");
    const logs = wire.received.slice(begin + 1, end)
      .filter(e => e.event === "envelope")
      .map(e => (e.payload.payload as { text?: string }).text);
    expect(logs).toEqual(["hello world", "answer"]);
    const capability = wire.received.some(e => e.event === "envelope" &&
      (e.payload.ext as any)?.session_capabilities?.supports_session_reset === true);
    expect(capability).toBe(true);
    wire.drop();
    await vi.waitFor(() => expect(wire.joins).toBe(2), { timeout: 10_000 });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(completed()).toHaveLength(1);
    expect(wire.received.filter(e => e.event === "history_reset")).toHaveLength(1);
    wire.push("instruction", { version: "0", text: "next" });
    await vi.waitFor(() => expect(wire.received.some(e => e.event === "envelope" &&
      (e.payload.payload as { text?: string })?.text === "next")).toBe(true));
  } finally {
    host?.close();
    await running.catch(() => {});
    await wire.close();
  }
}, 30_000);

it("does not publish a reset or completion after a failed partial load", async () => {
  const wire = await phoenixLoopback(() => ({ hydration: {
    replay_required: true, replay_id: "failed",
  } }));
  let host: MuseHost | undefined;
  const running = runMuseCli({
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => ({ agent_id: "history-failure", display_name: "History",
      persona: { id: "default", name: "Default", sprite_set: "default" },
      server_url: wire.url, resume_session_id: "fixture-session" }),
    createHost: options => {
      host = new MuseHost({ ...options, executable,
        env: { ...process.env, KAOIRO_TEST_HISTORY: "error" } });
      return host;
    },
  });
  const failure = running.then(() => false, () => true);
  try {
    await vi.waitFor(() => expect(wire.joins).toBe(1), { timeout: 10_000 });
    wire.push("persona_prompt", { prompt: "persona" });
    expect(await failure).toBe(true);
    expect(wire.received.filter(e => e.event === "history_reset" ||
      e.event === "history_replay_complete")).toEqual([]);
  } finally {
    host?.close();
    await failure;
    await wire.close();
  }
}, 30_000);
