// issue #396: Antigravity gains the same agent-facing `request_session_reset`
// tool Claude Code and Codex already have (ADR-0043). Pins the COMPOSITION
// itself -- the descriptor is registered, approval-gated through the same
// PermissionBroker every other dialog uses, and never offers request_compact
// (this engine has no compaction path). Real lifetime semantics (turn
// ownership, ordering against the state_change, a skipped turn) are pinned
// against a real AntigravityHost in session_reset_gate.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope, ToolDescriptor, WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

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
    send: (envelope: Envelope) => sent.push(envelope),
  };
  const host = {
    state: "idle",
    statusExtSnapshot: () => ({ engine: "antigravity" }),
    run: async () => {},
    send: (text: string) => {
      sends.push(text);
      return sendImpl(text);
    },
    setPendingPermission: (record: unknown) => pending.push(record),
    setPendingQuestion: () => {},
    activeInterAgentTurnToken: () => "turn-1",
  };

  await runAntigravityCli({
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
  });
  const descriptors = hostOptions.toolDescriptors as ToolDescriptor[];
  return { descriptors, sent, pending, sends, linkOptions, hostOptions };
}

describe("Antigravity CLI session-reset availability (issue #396)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("exposes request_session_reset on the bridge, gated, and never request_compact", async () => {
    const { descriptors } = await compose();
    const names = descriptors.map((descriptor) => descriptor.name);
    expect(names).toContain("request_session_reset");
    expect(names).toContain("ask_user_question");
    // Antigravity has no compaction path (same as Codex, issue #347).
    expect(names).not.toContain("request_compact");
    const reset = descriptors.find((d) => d.name === "request_session_reset")!;
    expect(reset.description).not.toContain("request_compact");
  });

  it("asks the operator with the Codex/Claude-shared FQN; deny answers in-turn with nothing reserved", async () => {
    const { descriptors, sent, pending, linkOptions } = await compose();
    const reset = descriptors.find((d) => d.name === "request_session_reset")!;
    const call = reset.handler({ mode: "clear", reason: "why" });
    // The CLI's own startup already sent an initial idle state_change before
    // this handler ever runs -- filter to the permission_request this call
    // itself produces rather than asserting on the whole `sent` history.
    const requests = sent.filter((e) => e.type === "permission_request");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.payload).toMatchObject({
      tool_name: "mcp__kaoiro__request_session_reset",
      input: { mode: "clear", reason: "why" },
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      tool_name: "mcp__kaoiro__request_session_reset",
    });
    const requestId = (requests[0]!.payload as { request_id: string }).request_id;
    linkOptions.onPermissionDecision({ request_id: requestId, allow: false, message: "no" });
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not approved");
    expect(pending.at(-1)).toBeNull();
  });

  it("rejects a malformed input before any dialog", async () => {
    const { descriptors, sent } = await compose();
    const reset = descriptors.find((d) => d.name === "request_session_reset")!;
    const result = await reset.handler({ mode: "sideways" });
    expect(result.isError).toBe(true);
    expect(sent.filter((e) => e.type === "permission_request")).toHaveLength(0);
  });
});
