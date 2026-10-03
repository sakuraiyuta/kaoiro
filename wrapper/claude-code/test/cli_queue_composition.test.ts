import { describe, expect, it, vi } from "vitest";
import { QueueLease } from "@kaoiro/wrapper-core";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { runClaudeCli } from "../src/cli.js";
import { AgentHost } from "../src/host.js";

// Composition through runClaudeCli: the real AgentHost, InterAgentTool,
// QueueInput and QueueLease, with a scripted server behind the lease and a
// scripted SDK query (credit-v1 root path, r8 §5.3 and §6.4).

let resultIndexCounter = 1_000_000;
const policy = { batch_max_items: 10, backlog_max_items: 100, backlog_max_bytes: 524_288 };
const counts = { queued: 0, offered: 0, native_pending: 0, waiter: 0, control: 0, charged_bytes: 0, policy };
const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

function inbound(cid: string): Envelope {
  return {
    version: "0", agent_id: "peer.agent", persona: { id: "peer", name: "Peer", sprite_set: "peer" }, display_name: "Peer",
    ts: "2026-10-04T00:00:00Z", type: "inter_agent_message", state: "tool_running",
    payload: { to: config.agent_id, conversation_id: cid, turn_number: 1, kind: "inform", body: "queued hello",
      meta: { done: false, propose_next: "" }, owner: { kind: "user", id: "operator" } },
    ext: {},
  } as unknown as Envelope;
}

async function runWithQueue(witness: boolean, fails = false) {
  const sent: Record<string, unknown>[] = [];
  const acknowledged: number[] = [];
  const prompts: string[] = [];
  const notices: Envelope[] = [];
  let lease!: QueueLease;
  let linkOptions!: Record<string, any>;
  let host!: AgentHost;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  const running = runClaudeCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _id, options) => {
      linkOptions = options as unknown as Record<string, any>;
      lease = new QueueLease({
        transport: async (payload) => {
          sent.push(payload);
          const base = { op: payload.op, operation_id: payload.operation_id, queue: counts };
          if (payload.op === "credit") {
            setImmediate(() => lease.receiveBatch({
              version: "0", queue_epoch: "e1", incarnation: "i1", generation: "g1", lease_id: "1", kind: "root",
              credit_revision: "1",
              items: [{ queue_id: "7", attempt_id: "7.1", delivery_seq: 1, class: "ordinary", byte_charge: 1, envelope: inbound("c-queue") }],
            }));
            return { ...base, credit_revision: "1" };
          }
          if (payload.op === "begin_native") return { ...base, permitted_queue_ids: payload.queue_ids };
          if (payload.op === "dispose") {
            done();
            return { ...base, disposed: ["7"], resolved_ranges: [[1, 1]], returned_ranges: [] };
          }
          return base;
        },
        onOffer: (offer) => linkOptions.onQueueOffer(offer),
      });
      lease.join({
        inter_agent_queue: "credit-v1", inter_agent_queue_policy: policy,
        inter_agent_queue_epoch: "e1", inter_agent_queue_resume_required: false,
      }, "i1", "g1");
      queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
      return {
        deliveryModes: () => ({ early: "none", yield: "none", stage_reports: true }),
        deliveryIncarnation: () => "i1", deliveryGeneration: () => "g1",
        reportDeliveryStage: () => {},
        acknowledgeInterAgentDelivery: (seq: number) => acknowledged.push(seq),
        retireInterAgentDeliveries: () => true, flushInterAgentRetirements: async () => {},
        sendInterAgent: async (envelope: Envelope) => { notices.push(envelope); return { kind: "accepted", stamp: null }; },
        send: () => {}, close: () => {}, currentSessionId: () => null, setSessionId: () => {},
        reportDisconnectIntent: async () => true,
        queueLease: () => lease,
        queueReady: () => Promise.resolve(),
      } as never;
    },
    createHost: (cfg, options) => {
      host = new AgentHost(cfg, {
        ...options,
        queryFn: (({ prompt, options: sdkOptions }: { prompt: AsyncIterable<SDKUserMessage>; options: any }) => {
          const stream = (async function* (): AsyncGenerator<SDKMessage> {
            const input = prompt[Symbol.asyncIterator]();
            const first = (await input.next()).value!;
            const text = first.message.content as string;
            prompts.push(text);
            if (witness) {
              await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
                hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: text,
              }, undefined, { signal: new AbortController().signal });
            }
            yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
            yield fails
              ? { type: "result", result_index: resultIndexCounter++, subtype: "error_during_execution", is_error: true, session_id: "s", errors: ["failed"] } as SDKMessage
              : { type: "result", result_index: resultIndexCounter++, subtype: "success", session_id: "s", result: "ok" } as SDKMessage;
            await finished;
          })();
          return Object.assign(stream, { interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query;
        }) as never,
      });
      host.probeRateLimits = async () => {};
      return host;
    },
  });

  try {
    await vi.waitFor(() => expect(sent.some((p) => p.op === "dispose")).toBe(true), { timeout: 4_000 });
    if (fails) await vi.waitFor(() => expect(notices.length).toBeGreaterThan(0), { timeout: 4_000 });
    return { sent, acknowledged, prompts, notices, stderr: stderr.mock.calls.map(([line]) => String(line)).join("") };
  } finally {
    host?.close();
    await running.catch(() => {});
    stderr.mockRestore();
  }
}

describe("Claude CLI credit-v1 root composition", () => {
  it("credits at readiness, submits the offer as the credit's turn and disposes it observed at the prompt hook", async () => {
    const { sent, acknowledged, prompts } = await runWithQueue(true);
    const credit = sent.find((p) => p.op === "credit")!;
    expect(credit).toMatchObject({ kind: "root" });
    expect(sent.find((p) => p.op === "begin_native")).toMatchObject({
      native_turn_token: credit.native_turn_token, queue_ids: ["7"],
    });
    expect(prompts[0]).toContain("[from peer.agent] inform: queued hello");
    expect(sent.find((p) => p.op === "dispose")).toMatchObject({
      items: [{ queue_id: "7", outcome: "observed", witness: "prompt_hook" }],
    });
    // A queue sequence settles only through the disposition.
    expect(acknowledged).toEqual([]);
  });

  it("a failed queue root turn tells the peer, as for pushed input", async () => {
    const { notices } = await runWithQueue(true, true);
    expect(notices.find((envelope) => envelope.payload.conversation_id === "c-queue")?.payload).toMatchObject({
      to: "peer.agent", notice_type: "turn_failure",
    });
  });

  it("a root turn that ends without a prompt-hook witness is disposed unknown (r9 S1)", async () => {
    const { sent, stderr } = await runWithQueue(false);
    expect(sent.find((p) => p.op === "dispose")).toMatchObject({
      items: [{ queue_id: "7", outcome: "unknown", reason: "root_turn_unwitnessed" }],
    });
    expect(stderr).toContain("invariant violation");
  });
});
