import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it, vi } from "vitest";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runGrokCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "test.grok",
  server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  display_name: "Default",
};
const buildInfo = {
  revision: "unknown", dirty: false, built_at: "unknown", version: "unknown", channel: "dev" as const,
};
const WORK_ID = "wrk_AbCdEfGhIjKlMnOpQrStUv";

it("injects the work stamp of a delivered assignment into the Grok turn (issue #690)", async () => {
  let options!: ServerLinkOptions;
  const texts: string[] = [];
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const work = runGrokCli({
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => ({ ...config }),
    loadWrapperBuildInfo: () => buildInfo,
    createServerLink: (_url, _id, o) => {
      options = o;
      queueMicrotask(() => {
        o.onPersonaPrompt?.("PERSONA");
        o.onNoticeAttributionMode?.("legacy");
      });
      return {
        send: () => {}, setSessionId: () => {}, close: () => {},
        deliveryIncarnation: () => "fixture-incarnation",
        deliveryGeneration: () => "fixture-generation",
        acknowledgeInterAgentDelivery: () => {},
        noticeAttributionMode: () => "legacy",
        reportDisconnectIntent: async () => {},
        sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
      } as unknown as ServerLink;
    },
    createHost: () => ({
      state: "waiting_input", statusExtSnapshot: () => ({}),
      run: async () => { ready(); await finished; },
      send: async (text: string) => { texts.push(text); },
      close: () => { finish(); }, closed: finished,
      renameDisplayName: () => {}, applyPermissionSync: () => {}, setPermission: async () => {},
    }) as never,
  });
  try {
    await started;
    options.onInterAgentMessage?.({
      version: "0",
      agent_id: "director.agent",
      persona: { id: "d", name: "D", sprite_set: "d" },
      display_name: "D",
      ts: "2026-10-27T00:00:00Z",
      type: "inter_agent_message",
      state: "idle",
      delivery_seq: 1,
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
      ext: {},
    } as unknown as Envelope);
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    expect(texts[0]).toContain(
      `(work: work_id=${WORK_ID}, state=nominated, revision=0, authority_epoch=1, op=assign)`,
    );
    expect(texts[0]).toContain(`work_control {op: "accept_assignment", work_id: "${WORK_ID}"}`);
  } finally {
    finish();
    await work;
  }
});
