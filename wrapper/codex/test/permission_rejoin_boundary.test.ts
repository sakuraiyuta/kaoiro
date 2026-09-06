import { CodexTurnDiagnostics } from "../src/turn_diagnostics.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
afterAll(() => vi.unstubAllGlobals());

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

beforeEach(() => {
  transport.handlers.clear();
  transport.joinReceivers.clear();
  transport.onOpen = null;
});

describe("permission rejoin during startup diagnostics", () => {
  it.each([false, true])("respects the current join after diagnostic I/O (rejoin=%s)", async (rejoin) => {
    const root = await mkdtemp(join(tmpdir(), "kaoiro-permission-rejoin-"));
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
    let releaseDiagnostic!: () => void;
    let enteredDiagnostic!: () => void;
    const diagnosticHeld = new Promise<void>(resolve => { releaseDiagnostic = resolve; });
    const diagnosticEntered = new Promise<void>(resolve => { enteredDiagnostic = resolve; });
    const originalBegin = CodexTurnDiagnostics.prototype.begin;
    // Delay completion of real diagnostic I/O so reconnect can land after
    // the initial sync wait but before the SDK execution boundary.
    const diagnosticSpy = vi.spyOn(CodexTurnDiagnostics.prototype, "begin")
      .mockImplementation(async function(this: CodexTurnDiagnostics) {
        await originalBegin.call(this);
        enteredDiagnostic();
        await diagnosticHeld;
      });
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
          turnTraceDir: join(root, "traces"),
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
      await diagnosticEntered;
      if (rejoin) {
        transport.onOpen?.();
        transport.joinReceivers.get("ok")?.({ permission_sync: true });
      }
      releaseDiagnostic();
      if (rejoin) {
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(spawns).toBe(0);
      } else {
        await vi.waitFor(() => expect(spawns).toBe(1));
      }
    } finally {
      releaseDiagnostic();
      diagnosticSpy.mockRestore();
      host?.close();
      try {
        await running;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

});
