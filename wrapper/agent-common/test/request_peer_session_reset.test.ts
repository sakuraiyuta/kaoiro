// issue #677 — request_peer_session_reset tool. The authority decision is the
// server's; what is testable here is the input contract, that `wait` defaults
// to true, that every closed reply reason and the unconfirmed-reply case are
// reported as the transport established them, and the root-input wording for
// results nobody was waiting for.
import { describe, expect, it } from "vitest";
import {
  REQUEST_PEER_SESSION_RESET_TOOL_FQN,
  peerSessionResetRootInput,
  requestPeerSessionResetDescriptor,
  validateRequestPeerSessionResetInput,
} from "../src/request_peer_session_reset.js";
import type {
  PeerSessionResetCall,
  PeerSessionResetRequestInput,
} from "../src/request_peer_session_reset.js";

const VALID = {
  agent_id: "peer.1",
  mode: "new",
  work_id: "wrk_1",
  expected_authority_epoch: 3,
};

function tool(call: PeerSessionResetCall | Error) {
  const seen: { request: PeerSessionResetRequestInput; wait: boolean }[] = [];
  const descriptor = requestPeerSessionResetDescriptor({
    request: async (request, { wait }) => {
      seen.push({ request, wait });
      if (call instanceof Error) throw call;
      return call;
    },
  });
  return { descriptor, seen };
}

describe("request_peer_session_reset descriptor", () => {
  it("sends at once and waits by default", async () => {
    const { descriptor, seen } = tool({
      outcome: "completed",
      requestId: "rs-1",
      toSessionId: "sess-2",
    });
    const result = await descriptor.handler(VALID);
    expect(seen).toEqual([{
      request: {
        agentId: "peer.1",
        mode: "new",
        workId: "wrk_1",
        expectedAuthorityEpoch: 3,
      },
      wait: true,
    }]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      request_id: "rs-1",
      agent_id: "peer.1",
      mode: "new",
      work_id: "wrk_1",
      outcome: "completed",
      to_session_id: "sess-2",
    });
  });

  it("wait=false is passed through and answers accepted", async () => {
    const { descriptor, seen } = tool({ outcome: "accepted", requestId: "rs-1" });
    const result = await descriptor.handler({ ...VALID, wait: false });
    expect(seen[0]?.wait).toBe(false);
    const [json, note] = result.content[0]!.text.split("\n");
    expect(JSON.parse(json!)).toMatchObject({ outcome: "accepted", request_id: "rs-1" });
    expect(note).toContain("Peer session reset");
  });

  it("trims reason and drops a blank one", async () => {
    const { descriptor, seen } = tool({ outcome: "accepted", requestId: "rs-1" });
    await descriptor.handler({ ...VALID, reason: "  fresh start  " });
    await descriptor.handler({ ...VALID, reason: "   " });
    expect(seen[0]?.request.reason).toBe("fresh start");
    expect(seen[1]?.request).not.toHaveProperty("reason");
  });

  it("reports a failed reset with its closed reason and a timeout without claiming failure", async () => {
    const failed = await tool({ outcome: "failed", requestId: "rs-1", reason: "spawn_failed" })
      .descriptor.handler(VALID);
    expect(JSON.parse(failed.content[0]!.text)).toMatchObject({
      outcome: "failed",
      reason: "spawn_failed",
    });
    const timeout = await tool({ outcome: "timeout", requestId: "rs-1" }).descriptor.handler(VALID);
    expect(timeout.isError).toBeUndefined();
    expect(timeout.content[0]!.text).toContain("may still complete");
    expect(timeout.content[0]!.text).toContain("Do not request another");
  });

  it.each([
    "reset_not_authorized",
    "work_control_unavailable",
    "unknown_agent",
    "unsupported_session_reset",
    "agent_in_conversation",
    "agent_busy",
    "session_reset_pending",
    "runner_unavailable",
    "unknown_error",
  ])("surfaces the refusal %s as the tool error", async (reason) => {
    const result = await tool(new Error(reason)).descriptor.handler(VALID);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(`refused: ${reason}.`);
  });

  it("tells the director to yield first when the target is busy", async () => {
    const result = await tool(new Error("agent_busy")).descriptor.handler(VALID);
    expect(result.content[0]!.text).toContain("yield");
  });

  it("does not claim 'nothing happened' when the reply never came", async () => {
    const result = await tool(new Error("timeout")).descriptor.handler(VALID);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("could not confirm");
    expect(result.content[0]!.text).toContain("Do not send it again");
    expect(result.content[0]!.text).not.toMatch(/nothing was changed/i);
  });

  it("refuses an invalid input before asking the server", async () => {
    const { descriptor, seen } = tool({ outcome: "accepted", requestId: "rs-1" });
    for (const bad of [
      { ...VALID, agent_id: undefined },
      { ...VALID, agent_id: "" },
      { ...VALID, mode: undefined },
      { ...VALID, mode: "reset" },
      { ...VALID, work_id: undefined },
      { ...VALID, work_id: "" },
      { ...VALID, expected_authority_epoch: undefined },
      { ...VALID, expected_authority_epoch: -1 },
      { ...VALID, expected_authority_epoch: 1.5 },
      { ...VALID, expected_authority_epoch: "3" },
      { ...VALID, reason: 7 },
      { ...VALID, wait: "yes" },
    ]) {
      const result = await descriptor.handler(bad as Record<string, unknown>);
      expect(result.isError).toBe(true);
    }
    expect(seen).toEqual([]);
  });

  it("description carries the director's preconditions", () => {
    const { descriptor } = tool({ outcome: "accepted", requestId: "rs-1" });
    expect(descriptor.name).toBe("request_peer_session_reset");
    expect(REQUEST_PEER_SESSION_RESET_TOOL_FQN).toBe("mcp__kaoiro__request_peer_session_reset");
    const text = descriptor.description;
    expect(text).toContain("written down");
    expect(text).toContain("NEXT request");
    expect(text).toContain("status line survives");
    expect(text).toContain("work_control_result");
    expect(text).toContain("work_status");
    expect(text).toContain("list_agents");
    expect(text).toContain("agent_busy");
    expect(text).toContain("yield");
    expect(text).toContain("70 seconds");
    expect(descriptor.inputSchema.required).toEqual([
      "agent_id",
      "mode",
      "work_id",
      "expected_authority_epoch",
    ]);
  });
});

describe("validateRequestPeerSessionResetInput", () => {
  it("accepts a complete grant and rejects each missing or malformed part", () => {
    expect(validateRequestPeerSessionResetInput(VALID)).toEqual({ ok: true });
    expect(validateRequestPeerSessionResetInput({ ...VALID, mode: "x" }).ok).toBe(false);
    expect(validateRequestPeerSessionResetInput({ ...VALID, work_id: "" }).ok).toBe(false);
    expect(
      validateRequestPeerSessionResetInput({ ...VALID, expected_authority_epoch: -1 }).ok,
    ).toBe(false);
  });

  it("applies the approval-payload ceiling to reason", () => {
    const result = validateRequestPeerSessionResetInput({
      ...VALID,
      reason: "x".repeat(20_000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("byte approval-payload");
  });
});

describe("peerSessionResetRootInput", () => {
  const base = {
    requestId: "rs-1",
    agentId: "peer.1",
    mode: "new" as const,
    workId: "wrk_1",
  };

  it("words a completed result like a work notice", () => {
    const text = peerSessionResetRootInput({ ...base, ok: true, toSessionId: "sess-2" });
    expect(text.startsWith("Peer session reset completed: ")).toBe(true);
    expect(JSON.parse(text.slice("Peer session reset completed: ".length))).toEqual({
      request_id: "rs-1",
      agent_id: "peer.1",
      mode: "new",
      work_id: "wrk_1",
      to_session_id: "sess-2",
    });
  });

  it("words a failed result with its reason", () => {
    const text = peerSessionResetRootInput({ ...base, ok: false, reason: "timeout" });
    expect(text.startsWith("Peer session reset failed: ")).toBe(true);
    expect(JSON.parse(text.slice("Peer session reset failed: ".length))).toMatchObject({
      reason: "timeout",
    });
  });
});
