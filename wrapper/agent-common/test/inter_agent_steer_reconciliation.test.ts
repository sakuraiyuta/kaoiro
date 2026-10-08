import { describe, expect, it } from "vitest";
import { InterAgentTool } from "../src/inter_agent.js";
import type { Envelope, InterAgentMessagePayload, WrapperConfig } from "../src/types.js";

const config: WrapperConfig = { agent_id: "self", persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P", server_url: "ws://unused" };
const identity = { incarnation: "inc", generation: "gen" };
const failed = { code: "api_error" as const, message: "API request failed" };
function input(seq: number, turn = seq, cid = "X", attributed = true): Envelope {
  return { version: "0", agent_id: "peer", persona: config.persona, display_name: "Peer", ts: "2026-10-09T00:00:00Z",
    type: "inter_agent_message", state: "thinking", ext: {}, delivery_seq: seq,
    payload: { to: "self", conversation_id: cid, turn_number: turn, kind: "request", body: `input-${turn}`,
      owner: { kind: "user", id: "operator" }, meta: { done: false, propose_next: "" }, new_conversation: false,
      ...(attributed ? { notice_attribution: "v1" as const } : {}) } satisfies InterAgentMessagePayload } as Envelope;
}
const payloads = (notices: Envelope[]) => notices.map(notice => notice.payload as unknown as InterAgentMessagePayload);
const coverage = (notices: Envelope[]) => payloads(notices).flatMap(payload => payload.error?.affected_deliveries ?? []);
const make = (kind: "accepted" | "unknown" | "rejected" = "accepted") => new InterAgentTool({ config,
  getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1", noticeAttributionMode: () => "v1",
  sendInterAgent: async () => kind === "accepted" ? { kind, stamp: null } : { kind, reason: "api_error" },
});
function root(tool: InterAgentTool, seq = 1, cid = "X", owner = "T", attributed = true) {
  expect(tool.notePendingInjection(input(seq, seq, cid, attributed), owner, { ...identity, batchId: `root-${seq}` })).toBe(true);
}
function steer(tool: InterAgentTool, seq = 2, cid = "X", id = identity, attributed = true) {
  expect(tool.noteSteerAttempt(input(seq, seq, cid, attributed), "T", `steer-${seq}`, id)).toBe(true);
}

describe("Codex root and steer terminal reconciliation", () => {
  it.each(["corroborated", "uncertain"] as const)("holds the root until a late %s result, then resolves once", result => {
    const tool = make(); root(tool); steer(tool);
    expect(tool.endSteeredTurn("T", ["X"], failed)).toEqual([]);
    expect(tool.hasUnreconciledRootPeer("peer")).toBe(true);
    expect(tool.rootBlocksSteer("X", "next")).toBe("behind_open_root_same_conversation");
    expect(tool.notePendingInjection(input(3), "next", { ...identity, batchId: "next" })).toBe(false);
    const notices = tool.settleSteerInjection("T", 2, result, identity);
    expect(payloads(notices).map(payload => payload.error!.code)).toEqual(result === "corroborated" ? ["api_error"] : ["api_error", "timeout"]);
    expect(coverage(notices).map(entry => entry.delivery_seq)).toEqual([1, 2]);
    expect(tool.hasUnreconciledRootPeer("peer")).toBe(false);
    expect(tool.endSteeredTurn("T", ["X"], failed)).toEqual([]);
    expect(tool.settleSteerInjection("T", 2, result, identity)).toEqual([]);
    expect(tool.notePendingInjection(input(3), "next", { ...identity, batchId: "next" })).toBe(true);
  });

  it("combines root coverage with corroborated steers and separates uncertain ones", () => {
    const tool = make(); root(tool); steer(tool, 2); steer(tool, 3);
    tool.settleSteerInjection("T", 2, "uncertain", identity); tool.settleSteerInjection("T", 3, "corroborated", identity);
    const notices = payloads(tool.endSteeredTurn("T", ["X"], failed));
    expect(notices.map(notice => [notice.error!.code, notice.error!.affected_deliveries!.map(entry => entry.delivery_seq)]))
      .toEqual([["api_error", [1, 3]], ["timeout", [2]]]);
  });

  it("clears successful roots without a notice, but preserves an uncertain steer notice", () => {
    const tool = make(); root(tool); steer(tool); tool.settleSteerInjection("T", 2, "uncertain", identity);
    const notices = tool.endSteeredTurn("T", ["X"]);
    expect(coverage(notices).map(entry => entry.delivery_seq)).toEqual([2]);
    expect(payloads(notices)[0]!.error!.code).toBe("timeout");
    expect(payloads(notices)[0]!.error!.message).toBe("the peer's turn timed out");
    expect(tool.hasPendingRootConversation("X")).toBe(false);
  });

  it("an abandoned final steer reconciles a root held after terminal", () => {
    const tool = make(); root(tool); steer(tool);
    expect(tool.endSteeredTurn("T", ["X"], failed)).toEqual([]);
    const notices = tool.abandonSteerAttempt("T", 2, identity);
    expect(coverage(notices).map(entry => entry.delivery_seq)).toEqual([1]);
    expect(tool.hasUnreconciledRootPeer("peer")).toBe(false);
  });

  it.each([false, true])("root-only output remains the shared adapter output, error=%s", error => {
    const left = make(), right = make(); root(left); root(right);
    expect(payloads(left.endSteeredTurn("T", ["X"], error ? failed : undefined)))
      .toEqual(payloads(right.resolveTurnEnd("T", ["X"], error ? failed : undefined)));
  });

  it("legacy roots in separate CIDs remain unscoped, alongside a covered steer", () => {
    const tool = make(); tool.notePendingInjection(input(1, 1, "legacy-X"), "T");
    tool.notePendingInjection(input(2, 2, "legacy-Z"), "T"); steer(tool, 3, "Y");
    expect(tool.rootBlocksSteer("legacy-X", "T")).toBe("behind_legacy_root_same_conversation");
    expect(tool.noteSteerAttempt(input(4, 4, "legacy-X"), "T", "bad", identity)).toBe(false);
    tool.settleSteerInjection("T", 3, "corroborated", identity);
    const notices = payloads(tool.endSteeredTurn("T", ["legacy-X", "legacy-Z"], failed));
    expect(notices).toHaveLength(3);
    expect(notices.filter(notice => notice.conversation_id.startsWith("legacy")).map(notice => notice.error!.affected_deliveries))
      .toEqual([undefined, undefined]);
    expect(notices.find(notice => notice.conversation_id === "Y")!.error!.affected_deliveries).toHaveLength(1);
  });

  it("an older sender gets one conservative CID-wide timeout for root and mixed steers", () => {
    const tool = make(); root(tool, 1, "X", "T", false); steer(tool, 2, "X", identity, false); steer(tool, 3, "X", identity, false);
    tool.settleSteerInjection("T", 2, "corroborated", identity); tool.settleSteerInjection("T", 3, "uncertain", identity);
    const notices = payloads(tool.endSteeredTurn("T", ["X"], failed));
    expect(notices).toHaveLength(1); expect(notices[0]!.error!.code).toBe("timeout");
    expect(notices[0]!.error!.message).toBe("the peer's turn timed out");
    expect(notices[0]!.error!.affected_deliveries).toBeUndefined();
  });
});

describe("delivery identity, wire partitions and exact ticket discharge", () => {
  it.each(["corroborated", "uncertain"] as const)("preserves equal sequences across generations for %s", result => {
    const tool = make(), second = { ...identity, generation: "next" };
    steer(tool, 4); steer(tool, 4, "X", second);
    tool.settleSteerInjection("T", 4, result, identity); tool.settleSteerInjection("T", 4, result, second);
    const notices = tool.endSteeredTurn("T", [], failed);
    expect(notices).toHaveLength(2); expect(coverage(notices).map(entry => entry.delivery_seq)).toEqual([4, 4]);
    expect(payloads(notices).every(notice => notice.error!.affected_deliveries!.length === 1)).toBe(true);
  });
  it("partitions a root and steer with the same seq across incarnations", () => {
    const tool = make(); root(tool, 4); steer(tool, 4, "X", { ...identity, incarnation: "new-inc" });
    tool.settleSteerInjection("T", 4, "corroborated", { ...identity, incarnation: "new-inc" });
    const notices = tool.endSteeredTurn("T", ["X"], failed);
    expect(notices).toHaveLength(2); expect(coverage(notices)).toHaveLength(2);
  });
  it("chunks 17 entries and defensively splits non-increasing sequences without dropping them", () => {
    const tool = make(); root(tool, 1); root(tool, 1);
    for (let seq = 2; seq <= 17; seq += 1) { steer(tool, seq); tool.settleSteerInjection("T", seq, "corroborated", identity); }
    const notices = tool.endSteeredTurn("T", ["X"], failed);
    expect(coverage(notices)).toHaveLength(18);
    expect(payloads(notices).map(notice => notice.error!.affected_deliveries!.length)).toEqual([1, 16, 1]);
    for (const notice of payloads(notices)) {
      const seqs = notice.error!.affected_deliveries!.map(entry => entry.delivery_seq);
      expect(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!)).toBe(true);
    }
  });
  it("settles and abandons only the supplied identity", () => {
    const tool = make(), second = { ...identity, generation: "next" };
    steer(tool, 4); steer(tool, 4, "X", second);
    tool.abandonSteerAttempt("T", 4, identity);
    expect(tool.endSteeredTurn("T", [], failed)).toEqual([]);
    const notices = tool.settleSteerInjection("T", 4, "corroborated", second);
    expect(coverage(notices)).toHaveLength(1);
  });
  it.each(["accepted", "unknown", "rejected"] as const)("ticket reply %s clears only its identity and the owning CID root", async kind => {
    const tool = make(kind), second = { ...identity, generation: "next" };
    root(tool, 1); steer(tool, 4); steer(tool, 4, "X", second);
    tool.prepareReplyInput("T", [input(1)]); tool.beginReplyInput("T");
    const mutable = { ...second };
    const fold = tool.prepareFoldInput("T", [input(4)], mutable)!;
    mutable.generation = "changed-after-preparation";
    expect(fold.activate()).toBe(true);
    const auth = fold.authorizations[0]!;
    await tool.invoke({ to: "peer", conversation_id: "X", kind: "response", body: "reply", ...auth }, { origin: { token: "T" } });
    tool.settleSteerInjection("T", 4, "uncertain", identity); tool.settleSteerInjection("T", 4, "corroborated", second);
    const notices = tool.endSteeredTurn("T", ["X"], failed);
    expect(coverage(notices).map(entry => entry.delivery_seq)).toEqual(kind === "rejected" ? [1, 4, 4] : [4]);
    expect(payloads(notices).at(-1)!.error!.code).toBe("timeout");
  });
});
