import "../../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import { NATIVE_CONTINUATIONS_ENV } from "../src/native_continuations_setting.js";

beforeEach(() => { vi.stubEnv(NATIVE_CONTINUATIONS_ENV, "0"); });
afterEach(() => { vi.unstubAllEnvs(); });

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const WORK_ID = "wrk_AbCdEfGhIjKlMnOpQrStUv";

function assignment(): Envelope {
  return {
    version: "0",
    agent_id: "director.agent",
    persona: { id: "d", name: "D", sprite_set: "d" },
    display_name: "D",
    ts: "2026-10-27T00:00:00Z",
    type: "inter_agent_message",
    state: "tool_running",
    payload: {
      to: config.agent_id,
      conversation_id: "c-work",
      turn_number: 1,
      kind: "request",
      body: "please take this",
      meta: { done: false, propose_next: "" },
      work: { work_id: WORK_ID, revision: 0, authority_epoch: 1, state: "nominated" },
      work_control_result: { op: "assign", operation_id: "op_1_AAAAAAAAAAAAAAAAAAAAAA", outcome: "applied" },
    },
    delivery_seq: 1,
  } as unknown as Envelope;
}

it("injects the work stamp of a delivered assignment into the Claude turn (issue #690)", async () => {
  vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", "0");
  let linkOptions!: Record<string, any>;
  const texts: string[] = [];
  let start!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { start = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const running = runClaudeCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _id, options) => {
      linkOptions = options as unknown as Record<string, any>;
      options.deliveryPolicy?.acceptJoin({}, options.deliveryPolicy.beginJoin());
      queueMicrotask(() => { linkOptions.onReplyBasisMode("v1"); linkOptions.onPersonaPrompt("system prompt"); });
      return {
        deliveryModes: () => ({ early: "none", yield: "none", stage_reports: true }),
        acknowledgeInterAgentDelivery: () => {}, retireInterAgentDeliveries: () => true,
        sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
        send: () => {}, close: () => {}, currentSessionId: () => null, setSessionId: () => {},
        reportDisconnectIntent: async () => true,
      } as never;
    },
    createHost: () => ({
      state: "idle", statusExtSnapshot: () => ({}),
      run: async () => { start(); await finished; },
      send: async (text: string) => { texts.push(text); },
      close: () => {},
    }) as never,
  });
  try {
    await ready;
    await linkOptions.onInterAgentMessage(assignment());
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    expect(texts[0]).toContain(
      `(work: work_id=${WORK_ID}, state=nominated, revision=0, authority_epoch=1, op=assign)`,
    );
    expect(texts[0]).toContain(`work_control {op: "accept_assignment", work_id: "${WORK_ID}"}`);
  } finally { finish(); await running; }
});
