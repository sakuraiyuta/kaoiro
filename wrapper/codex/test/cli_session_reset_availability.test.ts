import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Envelope,
  ToolDescriptor,
  WrapperConfig,
} from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";
import { CODEX_APPROVAL_TIMEOUT_MS } from "../src/host.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

/** Composes the production CLI around a mock host and captures what it
 *  wires. The real lifetime semantics are pinned against a real host in
 *  session_reset_gate.test.ts; this file pins the composition itself. */
async function compose(
  overrides: Partial<WrapperConfig> = {},
  sendImpl: (text: string) => Promise<void> = async () => {},
) {
  const sent: Envelope[] = [];
  const pending: unknown[] = [];
  const sends: string[] = [];
  let hostOptions!: Record<string, unknown>;
  let linkOptions!: Record<string, any>;
  const link = {
    close: () => {},
    currentSessionId: () => null,
    send: (envelope: Envelope) => sent.push(envelope),
  };
  const host = {
    state: "idle",
    statusExtSnapshot: () => ({}),
    run: async () => {},
    send: (text: string) => {
      sends.push(text);
      return sendImpl(text);
    },
    setPendingPermission: (record: unknown) => pending.push(record),
    activeInterAgentTurnToken: () => "turn-1",
  };

  await runCodexCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config, ...overrides }),
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
  return { descriptors, sent, pending, sends, linkOptions, hostOptions };
}

describe("Codex CLI session-reset availability (issue #246 → #347)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("exposes request_session_reset on the bridge, gated, and never request_compact", async () => {
    const { descriptors } = await compose();
    const names = descriptors.map((descriptor) => descriptor.name);
    // ADR-0043 Neutral amendment: exposed behind the wrapper-owned approval
    // wait (operatorApprovalGated), which is why the 2026-08-28 pin flipped.
    expect(names).toContain("request_session_reset");
    expect(names).toContain("ask_user_question");
    // codex has no compaction path (SDK 0.153.4 measured, issue #347).
    expect(names).not.toContain("request_compact");
    const reset = descriptors.find((d) => d.name === "request_session_reset")!;
    expect(reset.description).not.toContain("request_compact");
  });

  it("asks the operator with the Claude-side FQN; deny answers in-turn with nothing reserved", async () => {
    const { descriptors, sent, pending, linkOptions } = await compose();
    const reset = descriptors.find((d) => d.name === "request_session_reset")!;
    const call = reset.handler({ mode: "clear", reason: "why" });
    expect(sent.map((e) => e.type)).toEqual(["permission_request"]);
    expect(sent[0]!.payload).toMatchObject({
      tool_name: "mcp__kaoiro__request_session_reset",
      input: { mode: "clear", reason: "why" },
    });
    // The host stamp fires after send, so the ext-bearing state_change is
    // the last envelope the dashboard renders.
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      tool_name: "mcp__kaoiro__request_session_reset",
    });
    const requestId = (sent[0]!.payload as { request_id: string }).request_id;
    linkOptions.onPermissionDecision({ request_id: requestId, allow: false, message: "no" });
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not approved");
    expect(pending.at(-1)).toBeNull();
  });

  it("a rejected cancellation notice does not poison the instruction chain", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { descriptors, sent, sends, linkOptions, hostOptions } = await compose(
        {},
        async (text) => {
          if (text.startsWith("[kaoiro] The session reset you reserved")) {
            throw new Error("queue closed");
          }
        },
      );
      const reset = descriptors.find((d) => d.name === "request_session_reset")!;
      const call = reset.handler({ mode: "new" });
      const requestId = (sent[0]!.payload as { request_id: string }).request_id;
      linkOptions.onPermissionDecision({ request_id: requestId, allow: true });
      await call;
      // The owner turn ends without an SDK terminal: the reservation is
      // cancelled and the notice injection rejects.
      (hostOptions.onTurnEnd as (info: unknown) => void)({
        turnToken: "turn-1",
        conversationIds: [],
      });
      await vi.waitFor(() => expect(sends).toHaveLength(1));
      // The next operator instruction must still ride the shared chain.
      (linkOptions.onInstruction as (text: string) => void)("carry on");
      await vi.waitFor(() => expect(sends).toEqual([sends[0], "carry on"]));
    } finally {
      stderr.mockRestore();
    }
  });

  it("rejects a malformed input before any dialog", async () => {
    const { descriptors, sent } = await compose();
    const reset = descriptors.find((d) => d.name === "request_session_reset")!;
    const result = await reset.handler({ mode: "sideways" });
    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("caps the approval wait at CODEX_APPROVAL_TIMEOUT_MS even when config asks for more", async () => {
    const { descriptors, sent } = await compose({
      permission_timeout_ms: CODEX_APPROVAL_TIMEOUT_MS * 10,
    });
    const reset = descriptors.find((d) => d.name === "request_session_reset")!;
    const call = reset.handler({ mode: "new" });
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_TIMEOUT_MS - 1);
    let settled = false;
    void call.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("timed out");
  });
});
