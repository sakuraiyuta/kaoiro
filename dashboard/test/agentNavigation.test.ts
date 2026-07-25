import { describe, expect, it } from "vitest";
import { adjacentAgentId } from "../src/lib/agentNavigation";

describe("adjacentAgentId (#80)", () => {
  const ids = ["agent-a", "agent-b", "agent-c"];

  it("表示順どおり前後へ進む", () => {
    expect(adjacentAgentId(ids, "agent-b", -1)).toBe("agent-a");
    expect(adjacentAgentId(ids, "agent-b", 1)).toBe("agent-c");
  });

  it("先頭と末尾で循環する", () => {
    expect(adjacentAgentId(ids, "agent-a", -1)).toBe("agent-c");
    expect(adjacentAgentId(ids, "agent-c", 1)).toBe("agent-a");
  });

  it("2体時は左右とも唯一の相手を指す", () => {
    expect(adjacentAgentId(["agent-a", "agent-b"], "agent-a", -1)).toBe(
      "agent-b",
    );
    expect(adjacentAgentId(["agent-a", "agent-b"], "agent-a", 1)).toBe(
      "agent-b",
    );
  });

  it("1体だけ・空・選択消失時は切替先なし", () => {
    expect(adjacentAgentId(["agent-a"], "agent-a", 1)).toBeNull();
    expect(adjacentAgentId([], "agent-a", -1)).toBeNull();
    expect(adjacentAgentId(ids, "missing", 1)).toBeNull();
  });
});
