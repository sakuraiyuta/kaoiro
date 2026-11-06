import "../../../scripts/test/fixtures/test-isolation.mjs";
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
    const link = { deliveryModes: () => undefined,
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

it.each([
  { reason: "blocking_limit", errorClass: "invalid_request", code: "context_overflow", summary: "コンテキストの上限に達しました。" },
  { reason: "api_error", errorClass: "rate_limit", code: "rate_limit", summary: "レート制限に達しました。" },
] as const)("sends a $code notice for Claude failure", async scenario => {
  vi.stubEnv("KAOIRO_CLAUDE_NATIVE_CONTINUATIONS", "0");
  let linkOptions!: Record<string, any>;
  const sent: Envelope[] = [];
  const notices: Envelope[] = [];
  const stderr = captureWrites(process.stderr);
  const queryFn: QueryFn = ((args: { prompt: AsyncIterable<SDKUserMessage>; options: any }) => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      const input = args.prompt[Symbol.asyncIterator]();
      const root = (await input.next()).value!;
      await args.options.hooks.UserPromptSubmit.at(-1).hooks[0]({ hook_event_name: "UserPromptSubmit",
        session_id: "s", prompt_id: "p", prompt: root.message.content as string }, undefined, { signal: new AbortController().signal });
      yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
      yield { type: "assistant", message: { content: [] }, error: scenario.errorClass } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", is_error: true, result_index: 0, session_id: "s",
        terminal_reason: scenario.reason, result: "private content" } as SDKMessage;
    }
    return Object.assign(gen(), { interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query;
  }) as QueryFn;
  let host!: AgentHost;
  const running = runClaudeCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _agentId, options) => {
      linkOptions = options as unknown as Record<string, any>;
      queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
      return { deliveryModes: () => undefined, close: () => {}, currentSessionId: () => null, setSessionId: () => {},
        send: (e: Envelope) => sent.push(e), sendInterAgent: async (e: Envelope) => { notices.push(e); return { kind: "accepted", stamp: null }; },
        acknowledgeInterAgentDelivery: () => {}, retireInterAgentDeliveries: () => true,
        flushInterAgentRetirements: async () => {}, reportDisconnectIntent: async () => true } as never;
    },
    createHost: (cfg, options) => { host = new AgentHost(cfg, { ...options, queryFn }); host.probeRateLimits = async () => {}; return host; },
  });
  try {
    await vi.waitFor(() => expect(host).toBeDefined());
    linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
    await linkOptions.onInterAgentMessage({ version: "0", agent_id: "peer", persona: config.persona, display_name: "Peer",
      ts: "T", type: "inter_agent_message", state: "thinking", delivery_seq: 1,
      payload: { to: config.agent_id, conversation_id: "c1", turn_number: 1, kind: "request", body: "hello" } });
    await running;
    await vi.waitFor(() => expect(notices).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ conversation_id: "c1", error: expect.objectContaining({ code: scenario.code }) }),
    })));
    expect(sent.find(e => e.type === "result")?.payload).toMatchObject({ error_code: scenario.errorClass, error_summary: scenario.summary });
    expect(stderr.calls.some(call => String(call[0]).includes(`"terminal_reason":"${scenario.reason}","assistant_error_class":"${scenario.errorClass}"`))).toBe(true);
    if (scenario.code === "rate_limit") {
      const notice = notices.find(e => e.payload.conversation_id === "c1")!;
      expect(notice.payload.error).not.toHaveProperty("reset_delay_seconds");
    }
    expect(JSON.stringify(stderr.calls)).not.toContain("private content");
  } finally { host?.close(); await running; stderr.restore(); vi.unstubAllEnvs(); }
}, 10_000);
