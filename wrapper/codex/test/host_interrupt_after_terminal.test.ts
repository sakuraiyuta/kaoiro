// An abandonment (interrupt / close) that lands after the SDK terminal was
// observed — while the host is still finishing the turn (here: the
// permission observation's retry window) — must not mark a finished turn
// as abandoned, or an approved reset would be dropped for a turn nobody
// cut short (issue #347 reviews R2 / R3, the post-terminal boundary).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionControlExt, PermissionSelection } from "@kaoiro/protocol";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexHost } from "../src/host.js";
import type { CodexLifecycleEvent } from "../src/host.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

const selected: PermissionSelection = {
  revision: 4,
  requested: { sandbox: "read-only", network_access: false },
};
// A pending (not failed/unknown) control keeps the dispatch gate open, so
// the turn runs and the selection is observed at its terminal.
const pendingControl: PermissionControlExt = {
  ...selected,
  status: "pending",
  constraints: { approval: "never", enforcement: "os" },
};

describe("CodexHost — abandonment after the terminal was observed", () => {
  const entries: Record<string, (host: CodexHost) => void> = {
    interrupt: (host) => {
      void host.interrupt();
    },
    close: (host) => host.close(),
  };
  for (const [entry, act] of Object.entries(entries)) {
    it(`${entry}: reports the terminal without \`abandoned\` when it lands in the post-terminal window`, async () => {
      const root = await mkdtemp(join(tmpdir(), "kuroe347-post-terminal-"));
      // An empty rollout: the permission observation finds no turn_context
      // and retries (4 x 25 ms), which is the window under test.
      await writeFile(join(root, "rollout-gate-session.jsonl"), "");
      const ends: unknown[] = [];
      const lifecycle: CodexLifecycleEvent[] = [];
      const host = new CodexHost(
        {
          agent_id: "gate.agent",
          display_name: "Gate",
          persona: { id: "gate", name: "Gate", sprite_set: "gate" },
          server_url: "ws://localhost:1/wrapper",
          sandbox: "read-only",
          network_access: false,
        },
        {
          appendSystemPrompt: "test",
          onState: () => {},
          onTurnEnd: (info) => ends.push(info),
          onLifecycle: (event) => lifecycle.push(event),
          resumeSessionId: "gate-session",
          permissionRolloutRoot: root,
          permissionSyncSupported: true,
          turnTraceDir: join(root, "traces"),
          rateLimitResolver: async () => new Map(),
          codexFactory: () => {
            const thread = {
              async runStreamed() {
                return {
                  events: (async function* (): AsyncGenerator<ThreadEvent> {
                    yield { type: "thread.started", thread_id: "gate-session" };
                    yield {
                      type: "turn.completed",
                      usage: {
                        input_tokens: 0,
                        cached_input_tokens: 0,
                        output_tokens: 0,
                        reasoning_output_tokens: 0,
                        cache_write_input_tokens: 0,
                      },
                    };
                  })(),
                };
              },
            };
            return { startThread: () => thread, resumeThread: () => thread };
          },
        },
      );
      host.applyPermissionSync({ version: "0", control: pendingControl, next: selected });
      const running = host.run();
      cleanup.push(async () => {
        host.close();
        await running;
        await rm(root, { recursive: true, force: true });
      });
      await host.send("go", undefined, [], "token-1");
      // The `terminal` lifecycle event fires when turn.completed is observed,
      // before the host enters the permission observation retries.
      await vi.waitFor(
        () => expect(lifecycle.some((e) => e.kind === "terminal")).toBe(true),
        { interval: 2 },
      );
      expect(ends).toHaveLength(0);
      act(host);
      await vi.waitFor(() => expect(ends).toHaveLength(1), { timeout: 2000 });
      expect(ends[0]).toMatchObject({ turnToken: "token-1", terminal: "turn.completed" });
      expect((ends[0] as { abandoned?: unknown }).abandoned).toBeUndefined();
    });
  }
});
