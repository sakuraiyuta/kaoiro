import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { ServerLink } from "@kaoiro/wrapper-core";
import { CodexHost } from "../src/host.js";
import type { CodexClientLike, CodexThreadLike } from "../src/host.js";
import { runCodexCli } from "../src/cli.js";

type Receiver = (payload: unknown) => void;

const transport = {
  handlers: new Map<string, Receiver[]>(),
  joinReceivers: new Map<string, Receiver>(),
  onOpen: null as (() => void) | null,
};

class TestChannel {
  on(event: string, receiver: Receiver): void {
    const receivers = transport.handlers.get(event) ?? [];
    receivers.push(receiver);
    transport.handlers.set(event, receivers);
  }

  join(): { receive: (status: string, receiver: Receiver) => unknown } {
    const chain = {
      receive(status: string, receiver: Receiver) {
        transport.joinReceivers.set(status, receiver);
        return chain;
      },
    };
    return chain;
  }

  push(): { receive: () => unknown } {
    const chain = { receive: () => chain };
    return chain;
  }

  leave(): void {}
}

class TestSocket {
  connect(): void {}
  channel(): TestChannel {
    return new TestChannel();
  }
  onOpen(callback: () => void): void {
    transport.onOpen = callback;
  }
  disconnect(): void {}
}

vi.stubGlobal("WebSocket", class {});

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
  sandbox: "read-only",
  network_access: false,
};

function emit(event: string, payload: unknown): void {
  for (const receiver of transport.handlers.get(event) ?? []) receiver(payload);
}

function completed(): ThreadEvent {
  return {
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      cache_write_input_tokens: 0,
    },
  };
}

function permissionContext(turnId: string): string {
  return JSON.stringify({
    type: "turn_context",
    payload: {
      turn_id: turnId,
      approval_policy: "never",
      sandbox_policy: { type: "read-only" },
    },
  });
}

function createServerLink(
  serverUrl: string,
  agentId: string,
  options: ConstructorParameters<typeof ServerLink>[2],
): ServerLink {
  return new ServerLink(
    serverUrl,
    agentId,
    options,
    () => new TestSocket() as never,
  );
}

function closeCli(host: CodexHost | undefined, running: Promise<void>): void {
  host?.close();
  void running.catch(() => undefined);
}

beforeEach(() => {
  transport.handlers.clear();
  transport.joinReceivers.clear();
  transport.onOpen = null;
});

describe("Codex CLI permission-sync composition", () => {
  it("real ServerLink and CodexHost keep the first exec closed until a valid negotiated sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaoiro-codex-cli-permission-"));
    let host: CodexHost | undefined;
    let spawns = 0;
    const client: CodexClientLike = {
      startThread: () => thread,
      resumeThread: () => thread,
    };
    const thread: CodexThreadLike = {
      async runStreamed() {
        spawns += 1;
        async function* events(): AsyncGenerator<ThreadEvent> {
          yield { type: "thread.started", thread_id: "cli-gated-session" };
          yield completed();
        }
        return { events: events() };
      },
    };
    const running = runCodexCli({
      parseCliArgs: () => ({ configPath: "test", prompt: "first", resume: undefined }),
      loadConfig: () => ({ ...config }),
      loadWrapperBuildInfo: () => ({
        revision: "0123456789012345678901234567890123456789",
        dirty: false,
        version: "test",
        channel: "dev" as const,
      }),
      createServerLink,
      createHost: (hostConfig, options) => {
        host = new CodexHost(hostConfig, {
          ...options,
          codexFactory: () => client,
          permissionRolloutRoot: root,
        });
        return host;
      },
    });
    try {
      await vi.waitFor(() => expect(transport.joinReceivers.get("ok")).toBeTypeOf("function"));
      transport.joinReceivers.get("ok")?.({ permission_sync: true });
      emit("persona_prompt", { prompt: "system prompt" });
      await vi.waitFor(() => expect(host).toBeDefined());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(spawns).toBe(0);

      emit("permission_sync", { version: "0", control: null, next: {} });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(spawns).toBe(0);

      emit("permission_sync", { version: "0", control: null, next: null });
      await vi.waitFor(() => expect(spawns).toBe(1));
    } finally {
      closeCli(host, running);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("legacy join keeps the selector disabled but does not gate dispatch", async () => {
    let host: CodexHost | undefined;
    let spawns = 0;
    const thread: CodexThreadLike = {
      async runStreamed() {
        spawns += 1;
        async function* events(): AsyncGenerator<ThreadEvent> {
          yield { type: "thread.started", thread_id: "cli-legacy-session" };
          yield completed();
        }
        return { events: events() };
      },
    };
    const client: CodexClientLike = {
      startThread: () => thread,
      resumeThread: () => thread,
    };
    const running = runCodexCli({
      parseCliArgs: () => ({ configPath: "test", prompt: "first", resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink,
      createHost: (hostConfig, options) => {
        host = new CodexHost(hostConfig, { ...options, codexFactory: () => client });
        return host;
      },
    });
    try {
      await vi.waitFor(() => expect(transport.joinReceivers.get("ok")).toBeTypeOf("function"));
      transport.joinReceivers.get("ok")?.({});
      emit("persona_prompt", { prompt: "system prompt" });
      await vi.waitFor(() => expect(spawns).toBe(1));
      expect(host?.statusExtSnapshot().session_capabilities).toMatchObject({
        supports_permission_switch: false,
      });
    } finally {
      closeCli(host, running);
    }
  });

  it("rejoin gates a successor until its own sync arrives", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaoiro-codex-cli-permission-"));
    const sessionId = "cli-rejoin-session";
    const rollout = join(root, `rollout-${sessionId}.jsonl`);
    let host: CodexHost | undefined;
    let spawns = 0;
    const contexts: string[] = [];
    const thread: CodexThreadLike = {
      async runStreamed() {
        spawns += 1;
        const turn = spawns;
        async function* events(): AsyncGenerator<ThreadEvent> {
          yield { type: "thread.started", thread_id: sessionId };
          contexts.push(permissionContext(`cli-rejoin-turn-${turn}`));
          await writeFile(rollout, `${contexts.join("\n")}\n`);
          yield completed();
        }
        return { events: events() };
      },
    };
    const client: CodexClientLike = {
      startThread: () => thread,
      resumeThread: () => thread,
    };
    const running = runCodexCli({
      parseCliArgs: () => ({ configPath: "test", prompt: "first", resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink,
      createHost: (hostConfig, options) => {
        host = new CodexHost(hostConfig, {
          ...options,
          codexFactory: () => client,
          permissionRolloutRoot: root,
        });
        return host;
      },
    });
    try {
      await vi.waitFor(() => expect(transport.joinReceivers.get("ok")).toBeTypeOf("function"));
      transport.joinReceivers.get("ok")?.({ permission_sync: true });
      emit("persona_prompt", { prompt: "system prompt" });
      emit("permission_sync", { version: "0", control: null, next: null });
      await vi.waitFor(() => expect(spawns).toBe(1));
      await vi.waitFor(() => {
        expect(host?.statusExtSnapshot().permission_control).toMatchObject({
          status: "applied",
        });
      });

      transport.onOpen?.();
      transport.joinReceivers.get("ok")?.({ permission_sync: true });
      await host!.send("second");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(spawns).toBe(1);

      emit("permission_sync", { version: "0", control: null, next: null });
      await vi.waitFor(() => expect(spawns).toBe(2));
    } finally {
      closeCli(host, running);
      await rm(root, { recursive: true, force: true });
    }
  });
});
