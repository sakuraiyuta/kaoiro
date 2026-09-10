import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

function inbound(deliverySeq: number, turnNumber: number, body = "hello"): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: { id: "peer", name: "Peer", sprite_set: "peer" },
    display_name: "Peer",
    ts: "2026-09-10T00:00:00Z",
    type: "inter_agent_message",
    state: "thinking",
    payload: {
      to: config.agent_id,
      conversation_id: `c-${deliverySeq}`,
      turn_number: turnNumber,
      kind: "inform",
      body,
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
    delivery_seq: deliverySeq,
  } as unknown as Envelope;
}

describe("Antigravity CLI delivery composition", () => {
  it("connects the server handler, agy turn start, token, and delivery acknowledgement", async () => {
    const acknowledgements: number[] = [];
    const sends: Array<{ text: string; conversationIds: readonly string[]; turnToken: string }> = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let linkOptions!: Record<string, any>;
    let hostOptions!: Record<string, any>;
    const link = {
      close: () => {},
      send: () => {},
      acknowledgeInterAgentDelivery: (sequence: number) => acknowledgements.push(sequence),
    };
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      activeInterAgentTurnToken: () => null,
      requestInterruptForTurn: () => true,
      failStopTurnForWatchdog: () => true,
      failStopForWatchdogAttributionUnknown: () => true,
      run: async () => {},
      send: async (
        text: string,
        _attachments: unknown,
        conversationIds: readonly string[],
        turnToken: string,
      ) => {
        sends.push({ text, conversationIds, turnToken });
        // Queue admission must not acknowledge delivery. The child-spawn boundary does.
        expect(acknowledgements).toEqual([2]);
        hostOptions.onTurnStart({ turnToken, conversationIds });
        hostOptions.onTurnEnd({ turnToken, conversationIds });
        hostOptions.onTurnBoundary({ turnToken });
      },
    };

    try {
      await runAntigravityCli({
        parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
        loadConfig: () => ({ ...config }),
        createServerLink: (_url, _agentId, options) => {
          linkOptions = options as unknown as Record<string, any>;
          queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
          return link as never;
        },
        createHost: (_config, options) => {
          hostOptions = options as unknown as Record<string, any>;
          return host as never;
        },
      });

      (linkOptions.onInterAgentDeliveryStatus as (status: { acked_seq: number }) => void)({
        acked_seq: 1,
      });
      // A stale delivery is intentionally non-injected and therefore acked immediately.
      await (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
        inbound(2, 0),
      );
      expect(acknowledgements).toEqual([2]);
      expect(sends).toEqual([]);

      await (linkOptions.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
        inbound(3, 1, "INBOUND_BODY_SENTINEL"),
      );
      await vi.waitFor(() => expect(acknowledgements).toEqual([2, 3]));
      expect(sends).toEqual([
        expect.objectContaining({
          text: expect.stringContaining("INBOUND_BODY_SENTINEL"),
          conversationIds: ["c-3"],
          turnToken: expect.any(String),
        }),
      ]);
      expect(stderr.mock.calls.map(([line]) => String(line))).toContainEqual(
        expect.stringMatching(/^\[kaoiro\]\[antigravity-lifecycle\] .*"event":"turn_start"/),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("runs an inbound delivery through the production default CLI and host to an agy child", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-inbound-default-"));
    const executable = join(root, "agy-fixture.mjs");
    const configPath = join(root, "wrapper.config.json");
    const hook = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;
    writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write("fixture-model\\tFixture Model\\n");
} else if (args[0] === "-p" && args[1] === "/hooks") {
  const customization = args[args.lastIndexOf("--add-dir") + 1];
  process.stdout.write(JSON.stringify({ hooks: [{ source: customization + "/.agents/hooks.json", actions: [{ event: "PreToolUse", matcher: "*", command: ${JSON.stringify(hook)}, timeout_seconds: 3600 }] }] }));
} else if (args[0] === "--print") {
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "inbound child turn" } }) + "\\n");
} else {
  process.exitCode = 2;
}
`);
    chmodSync(executable, 0o755);
    writeFileSync(configPath, JSON.stringify({
      ...config,
      antigravity_cli_path: executable,
      antigravity_probe_timeout_ms: 45_000,
    }));
    const acknowledgements: number[] = [];
    let options!: Record<string, any>;
    let host: { close(): void } | undefined;
    let resultSeen!: () => void;
    const result = new Promise<void>((resolve) => { resultSeen = resolve; });

    try {
      const run = runAntigravityCli({
        parseCliArgs: () => ({ configPath, prompt: undefined, resume: undefined }),
        onHostCreated: (created) => {
          host = created;
          queueMicrotask(() => {
            void (options.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
              inbound(1, 1, "DEFAULT_COMPOSITION_SENTINEL"),
            );
          });
        },
        createServerLink: (_url, _agentId, createdOptions) => {
          options = createdOptions as unknown as Record<string, any>;
          queueMicrotask(() => {
            options.onPersonaPrompt("persona");
            options.onInterAgentDeliveryStatus({ acked_seq: 0 });
          });
          return {
            close: () => {},
            setSessionId: () => {},
            acknowledgeInterAgentDelivery: (sequence: number) => acknowledgements.push(sequence),
            send: (envelope: Envelope) => {
              if (envelope.type === "result") resultSeen();
            },
          } as never;
        },
      });

      await result;
      host?.close();
      await run;
      expect(acknowledgements).toEqual([1]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
