// issue #677: the Codex CLI exposes `request_peer_session_reset` on the
// bridge behind the same wrapper-owned approval gate as request_session_reset.
// Pins the composition (registration, approval class, hand-off of the link's
// answer and of a result nobody waited for); the gate's lifetime semantics are
// pinned in session_reset_gate.test.ts and session_reset_app_server_gate.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope, ToolDescriptor, WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

type Approval = { turn: string | null; next: string | null; blocked: boolean };

async function compose(approval?: Approval) {
  const sent: Envelope[] = [];
  const sends: string[] = [];
  const requests: { request: unknown; options: unknown }[] = [];
  let hostOptions!: Record<string, unknown>;
  let linkOptions!: Record<string, any>;
  const link = {
    close: () => {},
    currentSessionId: () => null,
    send: (envelope: Envelope) => sent.push(envelope),
    requestPeerSessionReset: async (request: unknown, options: unknown) => {
      requests.push({ request, options });
      return { outcome: "completed", requestId: "rs-1", toSessionId: "sess-2" };
    },
  };
  const host = {
    state: "idle",
    statusExtSnapshot: () => ({}),
    run: async () => {},
    send: async (text: string) => { sends.push(text); },
    setPendingPermission: () => {},
    activeInterAgentTurnToken: () => "turn-1",
    ...(approval === undefined ? {} : { bridgeToolApproval: () => approval }),
  };
  await runCodexCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _agentId, options) => {
      linkOptions = options as unknown as Record<string, any>;
      queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
      return link as never;
    },
    createHost: (_config, options) => {
      hostOptions = options as unknown as Record<string, unknown>;
      return host as never;
    },
    prepareStartup: async () => {},
  });
  const descriptors = hostOptions.toolDescriptors as ToolDescriptor[];
  const peerReset = descriptors.find((d) => d.name === "request_peer_session_reset")!;
  return { descriptors, peerReset, sent, sends, requests, linkOptions };
}

const VALID = { agent_id: "peer.1", mode: "new", work_id: "wrk_1", expected_authority_epoch: 3 };

describe("Codex CLI request_peer_session_reset (issue #677)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is exposed on the bridge next to request_session_reset", async () => {
    const { descriptors, peerReset } = await compose();
    const names = descriptors.map((d) => d.name);
    expect(names).toContain("request_session_reset");
    expect(names).toContain("request_peer_session_reset");
    expect(peerReset.description).toContain("DIRECTOR");
  });

  it("asks the operator with the Claude-side FQN; a deny never reaches the server", async () => {
    const { peerReset, sent, requests, linkOptions } = await compose();
    const call = peerReset.handler({ ...VALID, reason: "why" });
    const asked = sent.filter((e) => e.type === "permission_request");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.payload).toMatchObject({
      tool_name: "mcp__kaoiro__request_peer_session_reset",
      input: { ...VALID, reason: "why" },
    });
    const requestId = (asked[0]!.payload as { request_id: string }).request_id;
    linkOptions.onPermissionDecision({ request_id: requestId, allow: false, message: "no" });
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not approved");
    expect(requests).toEqual([]);
  });

  it("an approved call forwards the grant to the link and returns its outcome", async () => {
    const { peerReset, sent, requests, linkOptions } = await compose();
    const call = peerReset.handler(VALID);
    const requestId = (sent.find((e) => e.type === "permission_request")!.payload as { request_id: string }).request_id;
    linkOptions.onPermissionDecision({ request_id: requestId, allow: true });
    const result = await call;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      outcome: "completed", request_id: "rs-1", to_session_id: "sess-2",
    });
    expect(requests).toEqual([{
      request: { agentId: "peer.1", mode: "new", workId: "wrk_1", expectedAuthorityEpoch: 3 },
      options: { wait: true },
    }]);
  });

  it("rejects a malformed input before any dialog", async () => {
    const { peerReset, sent, requests } = await compose();
    const result = await peerReset.handler({ ...VALID, expected_authority_epoch: -1 });
    expect(result.isError).toBe(true);
    expect(sent.filter((e) => e.type === "permission_request")).toHaveLength(0);
    expect(requests).toEqual([]);
  });

  it("is autonomous only when the agent's approval setting is never", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const never = await compose({ turn: "never", next: "never", blocked: false });
      const result = await never.peerReset.handler(VALID);
      expect(result.isError).toBeUndefined();
      expect(never.sent.filter((e) => e.type === "permission_request")).toHaveLength(0);
      expect(never.requests).toHaveLength(1);
      expect(stderr.mock.calls.some(([text]) => String(text).includes("request_peer_session_reset: approved by the agent's approval setting"))).toBe(true);
      for (const approval of [
        { turn: "on-request", next: "never", blocked: false },
        { turn: "never", next: "on-request", blocked: false },
        { turn: "never", next: "never", blocked: true },
      ]) {
        const strict = await compose(approval);
        void strict.peerReset.handler(VALID);
        expect(strict.sent.filter((e) => e.type === "permission_request")).toHaveLength(1);
        expect(strict.requests).toEqual([]);
      }
    } finally { stderr.mockRestore(); }
  });

  it("hands a result nobody waited for to the model as a root input", async () => {
    const { linkOptions, sends } = await compose();
    linkOptions.onPeerSessionResetResult({
      requestId: "rs-1", agentId: "peer.1", mode: "new", workId: "wrk_1", ok: false, reason: "timeout",
    });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toContain("Peer session reset failed: ");
    expect(sends[0]).toContain("\"reason\":\"timeout\"");
  });
});
