import { describe, expect, it, vi } from "vitest";
import { runClaudeCli } from "../src/cli.js";
import { AgentHost } from "../src/host.js";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// Native results carry a run-wide delivery sequence; a live interval only
// accepts a result whose index advanced.
let resultIndexCounter = 0;
const nextResultIndex = (): number => resultIndexCounter++;

const config: WrapperConfig = {
  agent_id: "self",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

function envelope(seq: number, granted?: "early" | "yield"): Envelope {
  return {
    version: "0", agent_id: "peer", persona: config.persona,
    display_name: "Peer", ts: "2026-09-29T00:00:00Z",
    type: "inter_agent_message", state: "thinking", delivery_seq: seq,
    payload: {
      to: "self", conversation_id: `c${seq}`, turn_number: 1,
      kind: "request", body: `input ${seq}`,
      meta: { done: false, propose_next: "" },
      work: { work_id: "W", revision: 1, authority_epoch: 1, state: "active" },
      ...(granted === undefined ? {} : { delivery_authority: {
        requested: granted, granted, work_id: "W", authority_epoch: 1,
        ...(granted === "yield" ? { yield_token: "token" } : {}),
      } }),
    },
  } as unknown as Envelope;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

describe("Claude claimed-cut receipt chain", () => {
  it.each([0, 1, 2, 3])("cuts once after %i successor receipts within the fold bound", async successorCount => {
    vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "1");
    const ready = deferred<void>();
    const claimRequested = deferred<void>();
    const claim = deferred<{ granted: boolean }>();
    const firstFoldWritten = deferred<void>();
    const releaseFirstHook = deferred<void>();
    const priorities: Array<string | null> = [];
    const decisions: Array<{ kind: string; pushKind: string }> = [];
    const dispositions: Array<{ outcome: string; reason?: string }> = [];
    const stages: unknown[] = [];
    let claimCalls = 0;
    let linkOptions!: Record<string, any>;
    let host!: AgentHost;
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config, folds_per_turn: 3 }),
      createServerLink: (_url, _id, options) => {
        linkOptions = options as unknown as Record<string, any>;
        options.deliveryPolicy?.acceptJoin({}, options.deliveryPolicy.beginJoin());
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryModes: () => ({ early: "fold", yield: "tool_boundary", stage_reports: true }),
          deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
          requestYieldClaim: () => { claimCalls += 1; claimRequested.resolve(); return claim.promise; },
          reportDeliveryStage: (report: { yield_disposition?: { outcome: string; reason?: string } }) => {
            stages.push(report);
            if (report.yield_disposition) dispositions.push(report.yield_disposition);
          },
          acknowledgeInterAgentDelivery: () => {}, retireInterAgentDeliveries: () => true,
          flushInterAgentRetirements: async () => {},
          sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
          send: () => {}, close: () => {}, currentSessionId: () => null,
          setSessionId: () => {}, reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (cfg, options) => {
        host = new AgentHost(cfg, {
          ...options,
          onPushedInputDecision: decision => {
            decisions.push({ kind: decision.kind, pushKind: decision.pushKind });
            options.onPushedInputDecision?.(decision);
          },
          queryFn: (({ prompt, options: sdk }: { prompt: AsyncIterable<SDKUserMessage>; options: any }) => Object.assign((async function* () {
            const input = prompt[Symbol.asyncIterator]();
            const signal = { signal: new AbortController().signal };
            const hook = sdk.hooks.UserPromptSubmit.at(-1).hooks[0];
            const root = (await input.next()).value!;
            await hook({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: root.message.content as string }, undefined, signal);
            yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
            ready.resolve();
            for (let n = 0; n < successorCount + 2; n++) {
              const pushed = (await input.next()).value!;
              priorities.push(pushed.priority ?? null);
              if (n === 0) { firstFoldWritten.resolve(); await releaseFirstHook.promise; }
              if (pushed.priority === "now") {
                yield { type: "result", result_index: nextResultIndex(), subtype: "success", session_id: "s", result: "T done" } as SDKMessage;
              }
              await hook({
                hook_event_name: "UserPromptSubmit", session_id: "s",
                prompt_id: pushed.priority === "now" ? "p2" : n > successorCount ? "p3" : "p1",
                prompt: pushed.message.content as string,
              }, undefined, signal);
              if (pushed.priority === "now" && n < successorCount + 1) {
                yield { type: "result", result_index: nextResultIndex(), subtype: "success", session_id: "s", result: "F done" } as SDKMessage;
              }
            }
            yield { type: "result", result_index: nextResultIndex(), subtype: "success", session_id: "s", result: "done" } as SDKMessage;
          })(), { interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query) as never,
        });
        host.probeRateLimits = async () => {};
        return host;
      },
    });
    try {
      await vi.waitFor(() => expect(host).toBeDefined());
      linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      await linkOptions.onInterAgentMessage(envelope(1));
      await ready.promise;
      await linkOptions.onInterAgentMessage(envelope(2, "yield"));
      await claimRequested.promise;
      await linkOptions.onInterAgentMessage(envelope(3, "early"));
      await firstFoldWritten.promise;
      for (let n = 0; n < successorCount; n++) {
        await linkOptions.onInterAgentMessage(envelope(4 + n, "early"));
      }
      claim.resolve({ granted: true });
      await vi.waitFor(() => expect(claimCalls).toBe(1));
      releaseFirstHook.resolve();
      await running;
      const foldedCount = Math.min(successorCount + 1, 3);
      expect(priorities).toEqual([
        ...Array(foldedCount).fill(null), "now",
        ...Array(successorCount + 1 - foldedCount).fill(null),
      ]);
      expect(decisions.filter(decision => decision.kind === "fold")).toHaveLength(foldedCount);
      expect(decisions.filter(decision => decision.pushKind === "cut")).toHaveLength(1);
      expect(dispositions).toMatchObject([{ outcome: "cut" }]);
      expect(claimCalls).toBe(1);
      if (successorCount === 3) {
        expect(stages).toContainEqual(expect.objectContaining({
          delivery_seq: 6, stage: "submitted", handoff: "prompt_hook",
        }));
      }
    } finally {
      releaseFirstHook.resolve();
      host?.close();
      await running;
      vi.unstubAllEnvs();
    }
  }, 10_000);
});

describe("Claude claimed-cut final receipt deadline", () => {
  it.each(["late", "control", "timer"] as const)("keeps the absolute deadline when the final hook is %s", async schedule => {
    vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "1");
    const ready = deferred<void>();
    const claimRequested = deferred<void>();
    const claim = deferred<{ granted: boolean }>();
    const foldWritten = deferred<void>();
    const releaseHook = deferred<void>();
    const waiterReady = deferred<void>();
    const priorities: Array<string | null> = [];
    const dispositions: Array<{ outcome: string; reason?: string }> = [];
    let waitedAt = 0;
    let hookedAt = 0;
    let claimCalls = 0;
    let linkOptions!: Record<string, any>;
    let host!: AgentHost;
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config, pending_receipt_root_timeout_ms: 100 }),
      createServerLink: (_url, _id, options) => {
        linkOptions = options as unknown as Record<string, any>;
        options.deliveryPolicy?.acceptJoin({}, options.deliveryPolicy.beginJoin());
        queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
        return {
          deliveryModes: () => ({ early: "fold", yield: "tool_boundary", stage_reports: true }),
          deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
          requestYieldClaim: () => { claimCalls += 1; claimRequested.resolve(); return claim.promise; },
          reportDeliveryStage: (report: { yield_disposition?: { outcome: string; reason?: string } }) => {
            if (report.yield_disposition) dispositions.push(report.yield_disposition);
          },
          acknowledgeInterAgentDelivery: () => {}, retireInterAgentDeliveries: () => true,
          flushInterAgentRetirements: async () => {},
          sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
          send: () => {}, close: () => {}, currentSessionId: () => null,
          setSessionId: () => {}, reportDisconnectIntent: async () => true,
        } as never;
      },
      createHost: (cfg, options) => {
        host = new AgentHost(cfg, {
          ...options,
          queryFn: (({ prompt, options: sdk }: { prompt: AsyncIterable<SDKUserMessage>; options: any }) => Object.assign((async function* () {
            const input = prompt[Symbol.asyncIterator]();
            const signal = { signal: new AbortController().signal };
            const hook = sdk.hooks.UserPromptSubmit.at(-1).hooks[0];
            const root = (await input.next()).value!;
            await hook({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: root.message.content as string }, undefined, signal);
            yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
            ready.resolve();
            for (let n = 0; n < 2; n++) {
              const pushed = (await input.next()).value!;
              priorities.push(pushed.priority ?? null);
              if (n === 0) {
                foldWritten.resolve();
                await releaseHook.promise;
                if (schedule === "late") {
                  const start = performance.now();
                  while (performance.now() - start < 250) { /* Delay the timer callback with the SDK event loop. */ }
                }
                hookedAt = performance.now();
              }
              if (pushed.priority === "now") {
                yield { type: "result", result_index: nextResultIndex(), subtype: "success", session_id: "s", result: "T done" } as SDKMessage;
              }
              await hook({
                hook_event_name: "UserPromptSubmit", session_id: "s",
                prompt_id: pushed.priority === "now" ? "p2" : "p1",
                prompt: pushed.message.content as string,
              }, undefined, signal);
            }
            yield { type: "result", result_index: nextResultIndex(), subtype: "success", session_id: "s", result: "done" } as SDKMessage;
          })(), { interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query) as never,
        });
        const wait = host.waitForPushedReceipt.bind(host);
        host.waitForPushedReceipt = (...args) => {
          waitedAt = performance.now();
          const result = wait(...args);
          waiterReady.resolve();
          return result;
        };
        host.probeRateLimits = async () => {};
        return host;
      },
    });
    try {
      await vi.waitFor(() => expect(host).toBeDefined());
      linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      await linkOptions.onInterAgentMessage(envelope(1));
      await ready.promise;
      await linkOptions.onInterAgentMessage(envelope(2, "yield"));
      await claimRequested.promise;
      await linkOptions.onInterAgentMessage(envelope(3, "early"));
      await foldWritten.promise;
      claim.resolve({ granted: true });
      await waiterReady.promise;
      if (schedule === "timer") await new Promise(resolve => setTimeout(resolve, 250));
      releaseHook.resolve();
      await running;
      expect(claimCalls).toBe(1);
      if (schedule === "control") {
        expect(priorities.filter(priority => priority === "now")).toHaveLength(1);
        expect(dispositions).toMatchObject([{ outcome: "cut" }]);
      } else {
        expect(hookedAt - waitedAt).toBeGreaterThanOrEqual(100);
        expect(priorities.filter(priority => priority === "now")).toHaveLength(0);
        expect(dispositions).toMatchObject([{ outcome: "downgraded", reason: "receipt_wait_timeout" }]);
      }
    } finally {
      releaseHook.resolve();
      host?.close();
      await running;
      vi.unstubAllEnvs();
    }
  }, 10_000);
});
