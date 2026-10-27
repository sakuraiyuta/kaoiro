import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const WORK_ID = "wrk_AbCdEfGhIjKlMnOpQrStUv";

it("injects the work stamp of an assignment pushed over the wire into the Codex turn (issue #690)", async () => {
  const wire = await phoenixLoopback(() => ({
    inter_agent_reply_basis: "v1",
    inter_agent_delivery_modes: "v1",
    inter_agent_delivery_incarnation: "server-incarnation",
    work_control: "v1",
  }));
  const texts: string[] = [];
  let finishHost!: () => void;
  let startHost!: () => void;
  const finished = new Promise<void>(resolve => { finishHost = resolve; });
  const started = new Promise<void>(resolve => { startHost = resolve; });
  const running = runCodexCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config, server_url: wire.url }),
    createHost: () => ({
      state: "idle", statusExtSnapshot: () => ({}),
      activeInterAgentTurnToken: () => null,
      run: async () => { startHost(); await finished; },
      send: async (text: string) => { texts.push(text); }, close: () => {},
    }) as never,
    prepareStartup: async () => {},
  });
  try {
    await vi.waitFor(() => expect(wire.joins).toBe(1));
    wire.push("persona_prompt", { prompt: "system prompt" });
    await started;
    wire.push("envelope", {
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
    });
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    expect(texts[0]).toContain(
      `(work: work_id=${WORK_ID}, state=nominated, revision=0, authority_epoch=1, op=assign)`,
    );
    expect(texts[0]).toContain(`work_control {op: "accept_assignment", work_id: "${WORK_ID}"}`);
  } finally {
    finishHost();
    await running;
    await wire.close();
  }
});
