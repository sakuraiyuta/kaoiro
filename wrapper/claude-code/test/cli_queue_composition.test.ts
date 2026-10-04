import { describe, expect, it, vi } from "vitest";
import { QueueLease } from "@kaoiro/wrapper-core";
import { INTER_AGENT_TOOL_FQN } from "@kaoiro/agent-common";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import type { McpSdkServerConfigWithInstance, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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

async function runWithQueue(witness: boolean, fails = false, reply = false, refuseFirstBegin = false) {
  const sent: Record<string, unknown>[] = [];
  const acknowledged: number[] = [];
  const prompts: string[] = [];
  const notices: Envelope[] = [];
  const toolResults: string[] = [];
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
            const leaseId = String(sent.filter((p) => p.op === "credit").length);
            setImmediate(() => lease.receiveBatch({
              version: "0", queue_epoch: "e1", incarnation: "i1", generation: "g1", lease_id: leaseId, kind: "root",
              credit_revision: "1",
              items: [{ queue_id: "7", attempt_id: "7.1", delivery_seq: 1, class: "ordinary", byte_charge: 1, envelope: inbound("c-queue") }],
            }));
            return { ...base, credit_revision: "1" };
          }
          if (payload.op === "begin_native") {
            if (refuseFirstBegin && sent.filter((p) => p.op === "begin_native").length === 1) throw { reason: "queue_resume_required" };
            return { ...base, permitted_queue_ids: payload.queue_ids };
          }
          if (payload.op === "return") return { ...base, returned_ranges: [[1, 1]] };
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
            if (reply) {
              // The model answers the queued input with a plain reply in the same turn.
              const mcp = sdkOptions.mcpServers.kaoiro as McpSdkServerConfigWithInstance;
              type Transport = Parameters<typeof mcp.instance.connect>[0];
              const responses: Array<Record<string, any>> = [];
              const transport: Transport = { start: async () => {}, close: async () => {}, send: async (message) => { responses.push(message as Record<string, any>); } };
              await mcp.instance.connect(transport);
              try {
                const signal = { signal: new AbortController().signal };
                await sdkOptions.hooks.PreToolUse.at(-1).hooks[0]({
                  hook_event_name: "PreToolUse", session_id: "s", prompt_id: "p1", tool_name: INTER_AGENT_TOOL_FQN, tool_use_id: "queued-reply",
                }, "queued-reply", signal);
                transport.onmessage!({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                  name: "send_to_agent", arguments: { to: "peer.agent", conversation_id: "c-queue", kind: "response", body: "answer" },
                  _meta: { "claudecode/toolUseId": "queued-reply" },
                } });
                await vi.waitFor(() => expect(responses).toHaveLength(1));
                toolResults.push(JSON.stringify(responses[0]!.result));
              } finally { await mcp.instance.close(); }
            }
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
    return { sent, acknowledged, prompts, notices, toolResults, stderr: stderr.mock.calls.map(([line]) => String(line)).join("") };
  } finally {
    host?.close();
    await running.catch(() => {});
    stderr.mockRestore();
  }
}

function yieldInbound(cid: string): Envelope {
  const envelope = earlyInbound(cid);
  (envelope.payload as Record<string, unknown>).delivery_authority = {
    requested: "yield", granted: "yield", yield_token: "yt", work_id: "w1", authority_epoch: 1,
  };
  return envelope;
}

function earlyInbound(cid: string): Envelope {
  const envelope = inbound(cid);
  (envelope.payload as Record<string, unknown>).delivery_authority = { requested: "early", granted: "early" };
  (envelope.payload as Record<string, unknown>).body = "early hello";
  return envelope;
}

/** A running operator turn; the server offers one early item under the
 *  wrapper's early credit. With `slowPermit`, the permit for it is held until
 *  the turn has ended and root credit is asked for. */
async function runEarlyFold(slowPermit: boolean, rejoinFirst = false, yieldGranted = false) {
  const sent: Record<string, unknown>[] = [];
  const acknowledged: number[] = [];
  const prompts: string[] = [];
  const stages: Record<string, unknown>[] = [];
  let lease!: QueueLease;
  let linkOptions!: Record<string, any>;
  let host!: AgentHost;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  let turnOver!: () => void;
  const ended = new Promise<void>((resolve) => { turnOver = resolve; });
  let earlyOffered = false;
  let rootOffered = false;
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const batch = (leaseId: string, kind: "root" | "early") => lease.receiveBatch({
    version: "0", queue_epoch: "e1", incarnation: "i1", generation: "g1", lease_id: leaseId, kind,
    credit_revision: "1",
    items: [{
      queue_id: "8", attempt_id: `8.${leaseId}`, delivery_seq: Number(leaseId), class: "ordinary", byte_charge: 1,
      envelope: yieldGranted ? yieldInbound("c-early") : earlyInbound("c-early"),
    }],
  });

  const running = runClaudeCli({
    parseCliArgs: () => ({ configPath: "test", prompt: "operator task", resume: undefined }),
    loadConfig: () => ({ ...config, phase2_delivery: true }),
    createServerLink: (_url, _id, options) => {
      linkOptions = options as unknown as Record<string, any>;
      lease = new QueueLease({
        transport: async (payload) => {
          sent.push(payload);
          const base = { op: payload.op, operation_id: payload.operation_id, queue: counts };
          if (payload.op === "credit") {
            const earlyCredits = sent.filter((p) => p.op === "credit" && p.kind === "early").length;
            if (payload.kind === "early" && !earlyOffered && (!rejoinFirst || earlyCredits === 2)) {
              earlyOffered = true;
              setImmediate(() => batch("1", "early"));
            }
            if (payload.kind === "root" && earlyOffered) {
              turnOver();
              if (slowPermit && !rootOffered) {
                rootOffered = true;
                // The returned item comes back in the next root batch.
                setTimeout(() => batch("2", "root"), 20);
              }
            }
            return { ...base, credit_revision: String(payload.operation_id) };
          }
          if (payload.op === "begin_native") {
            if (slowPermit && payload.lease_id === "1") await ended;
            return { ...base, permitted_queue_ids: payload.queue_ids };
          }
          if (payload.op === "return") return { ...base, returned_ranges: [[1, 1]] };
          if (payload.op === "dispose") {
            done();
            return { ...base, disposed: ["8"], resolved_ranges: [[1, 1]], returned_ranges: [] };
          }
          if (payload.op === "withdraw") return { ...base, withdrawn: true };
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
        deliveryModes: () => ({ early: "fold", yield: yieldGranted ? "tool_boundary" : "none", stage_reports: true }),
        deliveryIncarnation: () => "i1", deliveryGeneration: () => "g1",
        reportDeliveryStage: (report: Record<string, unknown>) => stages.push(report),
        acknowledgeInterAgentDelivery: (seq: number) => acknowledged.push(seq),
        retireInterAgentDeliveries: () => true, flushInterAgentRetirements: async () => {},
        sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
        send: () => {}, close: () => {}, currentSessionId: () => null, setSessionId: () => {},
        reportDisconnectIntent: async () => true,
        requestYieldClaim: async () => ({ granted: false, reason: "unused" }),
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
            const signal = { signal: new AbortController().signal };
            const hook = (promptId: string, text: string) => sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
              hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: promptId, prompt: text,
            }, undefined, signal);
            const first = (await input.next()).value!;
            prompts.push(first.message.content as string);
            await hook("p1", first.message.content as string);
            yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
            if (rejoinFirst) {
              // A join during the turn drops the early credit on the server.
              await vi.waitFor(() => expect(sent.some((p) => p.op === "credit" && p.kind === "early")).toBe(true), { timeout: 4_000 });
              linkOptions.onQueueRejoined();
            }
            if (!slowPermit) {
              const fold = (await input.next()).value!;
              prompts.push(fold.message.content as string);
              await hook("p1", fold.message.content as string);
            } else {
              await vi.waitFor(() => expect(sent.some((p) => p.op === "begin_native")).toBe(true), { timeout: 4_000 });
            }
            yield { type: "result", result_index: resultIndexCounter++, subtype: "success", session_id: "s", result: "ok" } as SDKMessage;
            if (slowPermit) {
              const next = (await input.next()).value!;
              prompts.push(next.message.content as string);
              await hook("p2", next.message.content as string);
              yield { type: "result", result_index: resultIndexCounter++, subtype: "success", session_id: "s", result: "ok" } as SDKMessage;
            }
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
    return { sent, acknowledged, prompts, stages };
  } finally {
    host?.close();
    await running.catch(() => {});
    stderr.mockRestore();
  }
}

describe("Claude CLI credit-v1 early fold composition", () => {
  it("folds an early offer into the running turn under its token and disposes it at the fold hook", async () => {
    const { sent, acknowledged, prompts } = await runEarlyFold(false);
    const credit = sent.find((p) => p.op === "credit" && p.kind === "early")!;
    expect(credit).toMatchObject({ mechanism: "fold" });
    expect(sent.find((p) => p.op === "begin_native")).toMatchObject({ native_turn_token: credit.native_turn_token, queue_ids: ["8"] });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Mid-turn peer delivery");
    expect(prompts[1]).toContain("early hello");
    expect(sent.find((p) => p.op === "dispose")).toMatchObject({ items: [{ queue_id: "8", outcome: "observed", witness: "fold_hook" }] });
    expect(acknowledged).toEqual([]);
    // The turn can still fold, so early credit is asked for again, and the
    // turn end withdraws it.
    const earlyCredits = sent.filter((p) => p.op === "credit" && p.kind === "early");
    expect(earlyCredits).toHaveLength(2);
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ op: "withdraw", credit_revision: String(earlyCredits[1]!.operation_id) })));
  });

  it("a yield-granted item in a turn with no work input is downgraded on its offered sequence and folded", async () => {
    const { sent, stages } = await runEarlyFold(false, false, true);
    // The queue envelope has no delivery_seq: the report names the offer's.
    expect(stages).toContainEqual(expect.objectContaining({
      delivery_seq: 1, stage: "queued", incarnation: "i1", generation: "g1",
      yield_disposition: expect.objectContaining({ outcome: "downgraded", reason: "no_work_input" }),
    }));
    expect(sent.find((p) => p.op === "dispose")).toMatchObject({ items: [{ queue_id: "8", outcome: "observed", witness: "fold_hook" }] });
  });

  it("a rejoin during the turn asks for early credit again", async () => {
    const { sent } = await runEarlyFold(false, true);
    // The server offers only under the credit asked for after the rejoin.
    expect(sent.filter((p) => p.op === "credit" && p.kind === "early").length).toBeGreaterThanOrEqual(2);
    expect(sent.find((p) => p.op === "dispose")).toMatchObject({ items: [{ queue_id: "8", outcome: "observed", witness: "fold_hook" }] });
  });

  it("a permit that arrives after the fold window closed returns the item, which arrives once in the next root batch", async () => {
    const { sent, prompts } = await runEarlyFold(true);
    expect(sent.find((p) => p.op === "return")).toMatchObject({
      lease_id: "1", items: [{ queue_id: "8", reason: "early_ineligible", sub_reason: "fold_unavailable" }],
    });
    expect(sent.find((p) => p.op === "dispose")).toMatchObject({ lease_id: "2", items: [{ queue_id: "8", outcome: "observed", witness: "prompt_hook" }] });
    expect(prompts.filter((text) => text.includes("early hello"))).toHaveLength(1);
    expect(prompts.some((text) => text.includes("Mid-turn peer delivery"))).toBe(false);
  });
});

describe("Claude CLI credit-v1 root composition", () => {
  it("credits at readiness, submits the offer as the credit's turn and disposes it observed at the prompt hook", async () => {
    const { sent, acknowledged, prompts, stderr } = await runWithQueue(true);
    expect(stderr).not.toContain("invariant violation");
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

  it("the model can answer a queued input with a plain reply in that turn", async () => {
    const { notices, toolResults } = await runWithQueue(true, false, true);
    expect(toolResults[0]).not.toContain("isError\":true");
    expect(notices.find((envelope) => envelope.payload.conversation_id === "c-queue")?.payload).toMatchObject({
      to: "peer.agent", kind: "response", body: "answer", in_reply_to: 1,
    });
  });

  it("an item offered again after a refused permit is injected, not dropped as a stale duplicate", async () => {
    const { sent, prompts } = await runWithQueue(true, false, false, true);
    expect(sent.filter((p) => p.op === "begin_native")).toHaveLength(2);
    expect(sent.find((p) => p.op === "return")).toMatchObject({ items: [{ queue_id: "7", reason: "turn_abandoned" }] });
    expect(prompts[0]).toContain("queued hello");
    expect(sent.find((p) => p.op === "dispose")).toMatchObject({
      items: [{ queue_id: "7", outcome: "observed", witness: "prompt_hook" }],
    });
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

  it("another turn starting withdraws the root credit; a rejoin asks for it again, held or not", async () => {
    const sent: Record<string, unknown>[] = [];
    let lease!: QueueLease;
    let linkOptions!: Record<string, any>;
    let hostOptions!: Record<string, any>;
    let finish!: () => void;
    let start!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { start = resolve; });
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _id, options) => {
        linkOptions = options as unknown as Record<string, any>;
        lease = new QueueLease({
          transport: async (payload) => {
            sent.push(payload);
            return { op: payload.op, operation_id: payload.operation_id, queue: counts, credit_revision: String(sent.length) };
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
          acknowledgeInterAgentDelivery: () => {}, retireInterAgentDeliveries: () => true,
          flushInterAgentRetirements: async () => {},
          sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
          send: () => {}, close: () => {}, currentSessionId: () => null, setSessionId: () => {},
          reportDisconnectIntent: async () => true,
          queueLease: () => lease,
          queueReady: () => Promise.resolve(),
        } as never;
      },
      createHost: (_cfg, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return {
          state: "idle", statusExtSnapshot: () => ({}), isIdleForInput: () => true,
          run: async () => { start(); await finished; },
          send: async () => {}, close: () => {},
        } as never;
      },
    });
    try {
      await started;
      await vi.waitFor(() => expect(sent.filter((p) => p.op === "credit")).toHaveLength(1));
      hostOptions.onTurnStart({ turnToken: "operator-turn", kind: "wrapper_input" });
      await vi.waitFor(() => expect(sent.find((p) => p.op === "withdraw")).toMatchObject({ credit_revision: "1" }));
      linkOptions.onQueueRejoined();
      await vi.waitFor(() => expect(sent.filter((p) => p.op === "credit")).toHaveLength(2));
      // A join drops a granted credit too; the shared slot must forget it.
      linkOptions.onQueueRejoined();
      await vi.waitFor(() => expect(sent.filter((p) => p.op === "credit")).toHaveLength(3));
    } finally {
      finish();
      await running.catch(() => {});
    }
  });
});

/** A queued root input the model answers with a waiting send_to_agent; the
 *  peer's reply comes back as a `waiter` offer (credit-v1 W path). */
async function runWaiterReply(noReply = false) {
  const sent: Record<string, unknown>[] = [];
  const outers: unknown[] = [];
  const toolResults: string[] = [];
  let lease!: QueueLease;
  let linkOptions!: Record<string, any>;
  let host!: AgentHost;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const peerReply = inbound("c-queue");
  (peerReply.payload as Record<string, unknown>).turn_number = 3;
  (peerReply.payload as Record<string, unknown>).body = "peer answer";

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
            if (sent.filter((p) => p.op === "credit").length === 1) {
              setImmediate(() => lease.receiveBatch({
                version: "0", queue_epoch: "e1", incarnation: "i1", generation: "g1", lease_id: "1", kind: "root",
                credit_revision: "1",
                items: [{ queue_id: "7", attempt_id: "7.1", delivery_seq: 1, class: "ordinary", byte_charge: 1, envelope: inbound("c-queue") }],
              }));
            }
            return { ...base, credit_revision: String(payload.operation_id) };
          }
          if (payload.op === "waiter_close") {
            done();
            return { ...base, closed: true, claimed: false };
          }
          if (payload.op === "begin_native") return { ...base, permitted_queue_ids: payload.queue_ids };
          if (payload.op === "return") return { ...base, returned_ranges: [] };
          if (payload.op === "dispose") {
            if ((payload.items as { queue_id: string }[]).some((i) => i.queue_id === "9")) done();
            return { ...base, disposed: (payload.items as { queue_id: string }[]).map((i) => i.queue_id), resolved_ranges: [], returned_ranges: [] };
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
        acknowledgeInterAgentDelivery: () => {}, retireInterAgentDeliveries: () => true,
        flushInterAgentRetirements: async () => {},
        sendInterAgent: async (_envelope: Envelope, _generation: number, outer: unknown) => {
          outers.push(outer);
          // The server routes the peer's reply to the registration as W.
          if (!noReply) setImmediate(() => lease.receiveBatch({
            version: "0", queue_epoch: "e1", incarnation: "i1", generation: "g1", lease_id: "2", kind: "waiter",
            registration_id: "reg-1",
            items: [{ queue_id: "9", attempt_id: "9.1", delivery_seq: 2, class: "waiter", byte_charge: 1, envelope: peerReply }],
          }));
          return { kind: "accepted", stamp: null, waiter_registration_id: "reg-1" };
        },
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
            const signal = { signal: new AbortController().signal };
            await sdkOptions.hooks.UserPromptSubmit.at(-1).hooks[0]({
              hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: first.message.content as string,
            }, undefined, signal);
            yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
            const mcp = sdkOptions.mcpServers.kaoiro as McpSdkServerConfigWithInstance;
            type Transport = Parameters<typeof mcp.instance.connect>[0];
            const responses: Array<Record<string, any>> = [];
            const transport: Transport = { start: async () => {}, close: async () => {}, send: async (message) => { responses.push(message as Record<string, any>); } };
            await mcp.instance.connect(transport);
            try {
              await sdkOptions.hooks.PreToolUse.at(-1).hooks[0]({
                hook_event_name: "PreToolUse", session_id: "s", prompt_id: "p1", tool_name: INTER_AGENT_TOOL_FQN, tool_use_id: "waiting-reply",
              }, "waiting-reply", signal);
              transport.onmessage!({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: "send_to_agent",
                arguments: { to: "peer.agent", conversation_id: "c-queue", kind: "request", body: "and then?", wait_for_response: true, timeout_ms: noReply ? 200 : 3_000 },
                _meta: { "claudecode/toolUseId": "waiting-reply" },
              } });
              await vi.waitFor(() => expect(responses).toHaveLength(1), { timeout: 4_000 });
              toolResults.push(JSON.stringify(responses[0]!.result));
            } finally { await mcp.instance.close(); }
            yield { type: "result", result_index: resultIndexCounter++, subtype: "success", session_id: "s", result: "ok" } as SDKMessage;
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
    await vi.waitFor(() => expect(sent.some((p) => noReply ? p.op === "waiter_close" : p.op === "dispose" &&
      (p.items as { queue_id: string }[]).some((i) => i.queue_id === "9"))).toBe(true), { timeout: 5_000 });
    return { sent, outers, toolResults };
  } finally {
    host?.close();
    await running.catch(() => {});
    stderr.mockRestore();
  }
}

describe("Claude CLI credit-v1 W path composition", () => {
  it("a waiting send registers a waiter, and its W reply is permitted under the tool's turn and observed at the result return", async () => {
    const { sent, outers, toolResults } = await runWaiterReply();
    const rootToken = sent.find((p) => p.op === "credit")!.native_turn_token;
    expect(outers[outers.length - 1]).toMatchObject({ waiter_registration: { call_token: rootToken, expires_in_ms: 3_000 } });
    expect(sent.filter((p) => p.op === "begin_native" && p.lease_id === "2")).toEqual([
      expect.objectContaining({ queue_ids: ["9"], native_turn_token: rootToken }),
    ]);
    expect(sent.find((p) => p.op === "dispose" && p.lease_id === "2")).toMatchObject({
      items: [{ queue_id: "9", outcome: "observed", witness: "tool_result" }],
    });
    expect(toolResults[0]).toContain("peer answer");
  });

  it("a wait that ends without its reply closes the registration", async () => {
    const { sent } = await runWaiterReply(true);
    expect(sent.find((p) => p.op === "waiter_close")).toMatchObject({ registration_id: "reg-1" });
  });
});

