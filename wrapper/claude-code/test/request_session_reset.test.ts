// phase-28 C2 (#168 / ADR-0043) — request_session_reset tool + turn-boundary
// dispatch.
//
// Scope note: the operator approval itself is NOT exercised here, for the same
// reason as request_compact — the gate is the tool's ABSENCE from the
// auto-allow default (read_only_tools.ts, pinned in request_compact.test.ts),
// and the canUseTool binding lives in the real SDK. What is testable is that
// the tool only reserves, that the reservation fires at the turn boundary and
// nowhere else, and that a refusal is never swallowed.
import { describe, expect, it } from "vitest";
import {
  SessionResetCoordinator,
  requestSessionResetDescriptor,
} from "../src/request_session_reset.js";
import type { SessionResetMode } from "../src/request_session_reset.js";

function collector() {
  const reserved: { mode: SessionResetMode; reason?: string }[] = [];
  const tool = requestSessionResetDescriptor({
    reserve: (mode, reason) => {
      reserved.push({ mode, ...(reason !== undefined ? { reason } : {}) });
    },
  });
  return { reserved, tool };
}

describe("request_session_reset descriptor", () => {
  it("承認後の呼び出しは予約するだけで、その場では何も起きない", async () => {
    const { reserved, tool } = collector();
    const result = await tool.handler({ mode: "new" });
    expect(reserved).toEqual([{ mode: "new" }]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("reserved");
    // 「この turn の終了後に適用され、まだ拒否され得る」ことを model に
    // 伝えていること (ADR-0043 D3 の時間差)。
    expect(result.content[0]?.text).toContain("after this turn finishes");
    expect(result.content[0]?.text).toContain("refuse");
  });

  it("reason は server payload へ渡すだけで tool result に echo しない", async () => {
    const { reserved, tool } = collector();
    const result = await tool.handler({
      mode: "clear",
      reason: "行き止まりの調査で会話が埋まった",
    });
    expect(reserved).toEqual([
      { mode: "clear", reason: "行き止まりの調査で会話が埋まった" },
    ]);
    expect(result.content[0]?.text).not.toContain("行き止まり");
  });

  it("mode が不正なら予約せず isError を返す", async () => {
    const { reserved, tool } = collector();
    for (const mode of [undefined, "reset", 1, null]) {
      const result = await tool.handler({ mode });
      expect(result.isError).toBe(true);
    }
    expect(reserved).toEqual([]);
  });

  it("description は D5 (事前の外部化) を明記し、所要時間を約束しない", () => {
    const { tool } = collector();
    expect(tool.description).toContain("BEFORE calling this");
    expect(tool.description).toContain("WORKLOG");
    expect(tool.description).toContain("nothing is carried across");
    expect(tool.description).not.toMatch(/second|minute/i);
  });
});

interface Harness {
  coordinator: SessionResetCoordinator;
  requests: { mode: SessionResetMode; reason?: string }[];
  notices: string[];
  logs: string[];
  slept: number[];
}

function harness(outcomes: (string | null)[]): Harness {
  const requests: { mode: SessionResetMode; reason?: string }[] = [];
  const notices: string[] = [];
  const logs: string[] = [];
  const slept: number[] = [];
  let attempt = 0;
  const coordinator = new SessionResetCoordinator({
    request: async (mode, reason) => {
      requests.push({ mode, ...(reason !== undefined ? { reason } : {}) });
      const outcome = outcomes[Math.min(attempt++, outcomes.length - 1)];
      if (outcome !== null) throw new Error(outcome);
    },
    notify: async (text) => {
      notices.push(text);
    },
    log: (text) => logs.push(text),
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { coordinator, requests, notices, logs, slept };
}

/** The coordinator dispatches in the background so the host's run loop is
 *  never blocked; let those microtasks settle before asserting. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("SessionResetCoordinator", () => {
  it("turn 境界まで送らず、境界で 1 度だけ送る (ADR-0043 D3)", async () => {
    const h = harness([null]);
    h.coordinator.reserve("new", "理由");
    expect(h.requests).toEqual([]);
    expect(h.coordinator.pending).toBe(true);

    h.coordinator.onTurnEnd();
    await settle();
    expect(h.requests).toEqual([{ mode: "new", reason: "理由" }]);
    expect(h.coordinator.pending).toBe(false);

    // 予約が消費済みなので、次の境界では何も送らない。
    h.coordinator.onTurnEnd();
    await settle();
    expect(h.requests).toHaveLength(1);
  });

  it("予約が無い境界では何もしない", async () => {
    const h = harness([null]);
    h.coordinator.onTurnEnd();
    await settle();
    expect(h.requests).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("境界前の 2 度目の予約は最新の意図で置き換える", async () => {
    const h = harness([null]);
    h.coordinator.reserve("new");
    h.coordinator.reserve("clear", "やはり表示ごと消したい");
    h.coordinator.onTurnEnd();
    await settle();
    expect(h.requests).toEqual([
      { mode: "clear", reason: "やはり表示ごと消したい" },
    ]);
  });

  it("拒否されたら 1 回だけ再試行する", async () => {
    const h = harness(["agent_busy", null]);
    h.coordinator.reserve("new");
    h.coordinator.onTurnEnd();
    await settle();
    expect(h.requests).toHaveLength(2);
    expect(h.slept).toEqual([2500]);
    // 成功したので agent への失敗通知は出ない (この process はこの後
    // 差し替えられる)。
    expect(h.notices).toEqual([]);
  });

  it("再試行も拒否されたら『実行されなかった』と通知する", async () => {
    const h = harness(["agent_busy", "agent_busy"]);
    h.coordinator.reserve("clear");
    h.coordinator.onTurnEnd();
    await settle();
    expect(h.requests).toHaveLength(2);
    expect(h.notices).toHaveLength(1);
    // 2 度とも同じ確定的な拒否なので、断定してよい。何が起きなかったのか /
    // 今どういう状態か / 次にどうできるかを含むこと。黙って諦めると agent は
    // reset 済みのつもりで書き続ける。
    expect(h.notices[0]).toContain("was not carried out");
    expect(h.notices[0]).toContain("agent_busy");
    expect(h.notices[0]).toContain("continue as you were");
    expect(h.logs.some((l) => l.includes("実行されませんでした"))).toBe(true);
  });

  // CR-MF2: Phoenix の push timeout は「server が受け取っていない」ことを
  // 意味しない。再送は受理済みの reset を二重要求しかねないので行わず、
  // 断定もしない。
  it("timeout は再送せず、結果未確認として通知する (CR-MF2)", async () => {
    const h = harness(["timeout"]);
    h.coordinator.reserve("new");
    h.coordinator.onTurnEnd();
    await settle();
    expect(h.requests).toHaveLength(1);
    expect(h.slept).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("could not be confirmed");
    expect(h.notices[0]).toContain("may still be running");
    // 断定文言を混ぜないこと。
    expect(h.notices[0]).not.toContain("was not carried out");
    expect(h.notices[0]).not.toContain("context is unchanged");
    expect(h.logs.some((l) => l.includes("確認できませんでした"))).toBe(true);
  });

  // CR-MF2 反例: 1 回目が受理され reply だけ落ちた場合、次に見えるのは
  // session_reset_pending で、それは自分の reset が進行中である可能性が
  // 高い。「実行されなかった」と言ってはいけない。
  it("session_reset_pending も結果未確認として扱う (CR-MF2)", async () => {
    const h = harness(["session_reset_pending"]);
    h.coordinator.reserve("new");
    h.coordinator.onTurnEnd();
    await settle();
    expect(h.requests).toHaveLength(1);
    expect(h.notices[0]).toContain("could not be confirmed");
    expect(h.notices[0]).not.toContain("was not carried out");
  });

  it("agent_busy 再送後の timeout も結果未確認として扱う (CR-MF2)", async () => {
    const h = harness(["agent_busy", "timeout"]);
    h.coordinator.reserve("new");
    h.coordinator.onTurnEnd();
    await settle();
    expect(h.requests).toHaveLength(2);
    expect(h.notices[0]).toContain("could not be confirmed");
    expect(h.notices[0]).not.toContain("was not carried out");
  });

  it("確定的な拒否は再送しないが断定はしてよい (CR-MF2)", async () => {
    const h = harness(["unsupported_session_reset"]);
    h.coordinator.reserve("clear");
    h.coordinator.onTurnEnd();
    await settle();
    expect(h.requests).toHaveLength(1);
    expect(h.slept).toEqual([]);
    expect(h.notices[0]).toContain("was not carried out");
    expect(h.notices[0]).toContain("unsupported_session_reset");
  });

  it("通知の注入自体が失敗しても log には残す", async () => {
    const logs: string[] = [];
    const coordinator = new SessionResetCoordinator({
      request: async () => {
        throw new Error("agent_busy");
      },
      notify: async () => {
        throw new Error("queue closed");
      },
      log: (text) => logs.push(text),
      sleep: async () => {},
    });
    coordinator.reserve("new");
    coordinator.onTurnEnd();
    await settle();
    expect(logs.some((l) => l.includes("queue closed"))).toBe(true);
  });

  it("失敗通知が作る turn の境界で再送しない", async () => {
    const h = harness(["agent_busy", "agent_busy", "agent_busy"]);
    h.coordinator.reserve("new");
    h.coordinator.onTurnEnd();
    // 通知が新しい turn を作り、その境界がまた onTurnEnd を呼ぶ。予約は
    // 既に消費済みなので、ここで再送が始まってはいけない。
    h.coordinator.onTurnEnd();
    await settle();
    expect(h.requests).toHaveLength(2);
  });
});
