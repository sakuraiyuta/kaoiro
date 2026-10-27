import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";

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
    state: "thinking",
    payload: {
      to: config.agent_id,
      conversation_id: "c-work",
      turn_number: 1,
      kind: "request",
      body: "please take this",
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
      work: { work_id: WORK_ID, revision: 0, authority_epoch: 1, state: "nominated" },
      work_control_result: { op: "assign", operation_id: "op_1_AAAAAAAAAAAAAAAAAAAAAA", outcome: "applied" },
    },
    ext: {},
    delivery_seq: 1,
  } as unknown as Envelope;
}

it("injects the work stamp of a delivered assignment into the Antigravity turn (issue #690)", async () => {
  let linkOptions!: Record<string, any>;
  const texts: string[] = [];
  let finish!: () => void, ready!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  const link = {
    close: () => {}, send: () => {}, noticeAttributionMode: () => "v1", acknowledgeInterAgentDelivery: () => {},
    sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
  };
  const host = {
    state: "idle", statusExtSnapshot: () => ({}), activeInterAgentTurnToken: () => null,
    run: async () => { ready(); await finished; },
    send: async (text: string) => { texts.push(text); },
  };
  const signals = process.listeners("SIGINT");
  const running = runAntigravityCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }), loadConfig: () => ({ ...config }),
    createServerLink: (_url, _id, options) => {
      linkOptions = options as unknown as Record<string, any>;
      queueMicrotask(() => options.onPersonaPrompt?.("PERSONA")); return link as never;
    },
    createHost: () => host as never,
  });
  try {
    await started;
    await linkOptions.onInterAgentMessage(assignment());
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    expect(texts[0]).toContain(
      `(work: work_id=${WORK_ID}, state=nominated, revision=0, authority_epoch=1, op=assign)`,
    );
    expect(texts[0]).toContain(`work_control {op: "accept_assignment", work_id: "${WORK_ID}"}`);
  } finally {
    finish(); await running;
    for (const listener of process.listeners("SIGINT")) if (!signals.includes(listener)) process.removeListener("SIGINT", listener);
  }
});
