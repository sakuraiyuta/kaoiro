// issue #287, ふじ2 round2 M3: round1's negative control spied
// console.warn/console.error, but neither is AgentHost's actual production
// sink — printLog (cli.ts) writes to process.stdout.write, and #warn
// (host.ts) defaults to process.stderr.write. Worse, host.test.ts's fixture
// replaces onLog with a plain array push, so printLog/link.send are never
// even reached there. A spy on an unused sink passes vacuously regardless
// of a real leak.
//
// This drives the REAL runClaudeCli() entrypoint end to end (real
// AgentHost, real onLog -> printLog + link.send, same pattern as
// cli_resume_composition.test.ts) with a scripted SDK stream carrying a
// token-shaped string, and captures the ACTUAL production sinks: the
// process-level stdout/stderr writes and the envelope actually handed to
// link.send (the wire payload).
//
// vi.spyOn(process.stdout, "write") does not intercept calls in this
// worker environment (measured: a direct write right after spying is never
// recorded) — replace the property directly instead, restoring in
// `finally`.
import { describe, expect, it, vi } from "vitest";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import { AgentHost } from "../src/host.js";
import type { AgentHostOptions } from "../src/host.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

type QueryFn = NonNullable<AgentHostOptions["queryFn"]>;

const TOKEN_LIKE =
  "sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

/** Captures every call to `stream.write` by replacing the method directly
 *  (vi.spyOn does not observe it in this worker environment). Returns the
 *  captured calls and a restore function. */
function captureWrites(stream: NodeJS.WriteStream): {
  calls: unknown[][];
  restore: () => void;
} {
  const original = stream.write.bind(stream);
  const calls: unknown[][] = [];
  stream.write = ((...args: unknown[]) => {
    calls.push(args);
    return true;
  }) as typeof stream.write;
  return {
    calls,
    restore: () => {
      stream.write = original;
    },
  };
}

describe("Claude CLI error surfacing — production sink negative control (issue #287, ふじ2 round2 M3)", () => {
  it("token 風の raw SDK text は process.stdout/stderr にも link.send の wire payload にも現れない", async () => {
    const sent: Envelope[] = [];
    const link = {
      close: () => {},
      currentSessionId: () => null,
      send: (envelope: Envelope) => {
        sent.push(envelope);
      },
    };

    const queryFn: QueryFn = ((_args: {
      prompt: AsyncIterable<SDKUserMessage>;
      options: Options;
    }) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // Close out the queued "kick" turn first (same backpressure
        // reasoning as cli_resume_composition.test.ts): AgentHost holds it
        // as #activeTurn until a terminal message arrives.
        yield {
          type: "result",
          subtype: "success",
          result: "kick",
        } as unknown as SDKMessage;
        yield {
          type: "assistant",
          message: { content: [{ type: "text" }] },
          error: "authentication_failed",
        } as unknown as SDKMessage;
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          result: `Failed to authenticate: ${TOKEN_LIKE}`,
        } as unknown as SDKMessage;
      }
      return Object.assign(gen(), {
        interrupt: async () => {},
      }) as unknown as Query;
    }) as unknown as QueryFn;

    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);
    try {
      await runClaudeCli({
        parseCliArgs: () => ({
          configPath: "test",
          prompt: undefined,
          resume: undefined,
        }),
        loadConfig: () => ({ ...config }),
        createServerLink: (_url, _agentId, options) => {
          queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
          return link as never;
        },
        createHost: (cfg, options) => {
          const host = new AgentHost(cfg, { ...options, queryFn });
          // cli.ts sets deferQueryUntilFirstInput when no CLI prompt
          // argument is given (our test config); run() blocks on
          // #waitForFirstInput until something is queued.
          void host.send("kick");
          return host;
        },
      });
    } finally {
      stdout.restore();
      stderr.restore();
    }

    // Sanity: printLog's own result-line format (`-> `, cli.ts:144) must
    // have actually run -- a bare `stdout.calls.length > 0` check is NOT
    // enough here (self-review round1 finding): host.send("kick") fires
    // onState -> printState independently (cli.ts:126-133, also
    // process.stdout.write), so stdout activity alone does not prove
    // onLog/printLog specifically ran, and a wiring regression that broke
    // onLog entirely would still pass a length-only check.
    const printedResultLine = stdout.calls.find((call) =>
      String(call[0]).includes(" -> "),
    );
    expect(printedResultLine).toBeDefined();
    for (const call of stdout.calls) {
      expect(String(call[0])).not.toContain(TOKEN_LIKE);
    }
    for (const call of stderr.calls) {
      expect(String(call[0])).not.toContain(TOKEN_LIKE);
    }
    const resultEnvelope = sent.find(
      (e) =>
        e.type === "result" && (e.payload as { is_error?: unknown })?.is_error,
    );
    expect(resultEnvelope).toBeDefined();
    expect(JSON.stringify(resultEnvelope?.payload)).not.toContain(TOKEN_LIKE);
  });
});
