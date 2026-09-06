import { describe, expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Codex CLI permission-sync composition", () => {
  it("buffers pre-host sync and does not admit the first exec before the negotiated barrier", async () => {
    const barrier = deferred<void>();
    let hostOptions!: Record<string, unknown>;
    let spawns = 0;
    const applyPermissionSync = vi.fn();
    const setPermission = vi.fn(async () => {});
    const host = {
      state: "idle" as const,
      statusExtSnapshot: () => ({}),
      initializeRateLimits: async () => {},
      setPermissionSyncSupported: () => {},
      applyPermissionSync,
      setPermission,
      run: async () => {
        await (hostOptions.waitForPermissionSync as () => Promise<void>)();
        spawns += 1;
      },
    };
    const link = {
      close: () => {},
      currentSessionId: () => null,
      setSessionId: () => {},
      send: () => {},
      waitForPermissionSyncNegotiation: async () => true,
      waitForPermissionSync: () => barrier.promise,
      reportPermissionLifecycle: () => {},
    };

    const running = runCodexCli({
      parseCliArgs: () => ({ configPath: "test", prompt: "first", resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        options.permissionSync?.onNegotiated?.(true);
        options.permissionSync?.onSync?.({
          version: "0",
          control: null,
          next: null,
        }, 1);
        options.onSetPermission?.({
          revision: 1,
          requested: { sandbox: "workspace-write", network_access: true },
        });
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, unknown>;
        return host as never;
      },
      prepareStartup: async () => {},
    });

    await vi.waitFor(() => expect(hostOptions).toBeDefined());
    expect(applyPermissionSync).toHaveBeenCalledWith({
      version: "0",
      control: null,
      next: null,
    });
    expect(setPermission).toHaveBeenCalledWith({
      revision: 1,
      requested: { sandbox: "workspace-write", network_access: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawns).toBe(0);

    barrier.resolve();
    await running;
    expect(spawns).toBe(1);
  });
});
