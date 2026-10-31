import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it, vi } from "vitest";
import { CodexHost, initialStatusExt } from "../src/host.js";
import { runCodexCli } from "../src/cli.js";

const config = { agent_id: "default-test", persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P", server_url: "ws://fixture", codex_auth_mode: "apikey" as const };

it.each([undefined, "exec", "app-server"] as const)("resolves raw Host options and static status independently (%s)", backend => {
  const options = { appendSystemPrompt: "", onState: () => {}, ...(backend === undefined ? {} : { backend }),
    appServerApprovals: { decide: vi.fn(), deadlineMs: 123, inactivityLimitMs: 456 } };
  const host = new CodexHost(config, options);
  try {
    if (backend === undefined) expect(options).not.toHaveProperty("backend");
    else expect(options.backend).toBe(backend);
    expect(host.historyBackend).toBe(backend ?? "app-server");
    expect(host.approvalAxisSettings).toEqual(backend === "exec" ? null : { deadlineMs: 123, inactivityLimitMs: 456 });
    expect(initialStatusExt({ ...config, ...(backend === undefined ? {} : { codex_backend: backend }) }).session_capabilities)
      .toMatchObject({ supports_context_usage: backend !== "exec" });
    expect(host.statusExtSnapshot().session_capabilities).toMatchObject({ supports_context_usage: backend !== "exec" });
  } finally { host.close(); }
});

it("uses the app-server replay fallback when a CLI Host seam omits historyBackend", async () => {
  const scheduled = vi.fn(), listeners = process.listeners("SIGINT");
  try {
    await runCodexCli({
      parseCliArgs: () => ({ configPath: "fixture", prompt: undefined, resume: undefined }), loadConfig: () => config,
      prepareStartup: async () => {},
      createServerLink: (_url, _id, callbacks) => {
        queueMicrotask(() => {
          callbacks.onHydration?.({ replay_required: true, replay_id: "omitted-backend" });
          callbacks.onPersonaPrompt?.("fixture");
        });
        return { close() {}, send() {}, currentSessionId: () => null, captureHistoryReplayFence: () => () => true } as never;
      },
      createHost: () => ({ state: "idle", statusExtSnapshot: () => ({}), run: async () => {},
        scheduleHistoryReplay: scheduled } as never),
    });
    expect(scheduled).toHaveBeenCalledTimes(1);
  } finally {
    for (const listener of process.listeners("SIGINT")) if (!listeners.includes(listener)) process.removeListener("SIGINT", listener);
  }
});
