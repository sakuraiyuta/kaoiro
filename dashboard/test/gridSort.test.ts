import "./isolation.setup";
import { describe, expect, it } from "vitest";
import { sortAgents } from "../src/lib/gridSort";
import type { Envelope } from "../src/lib/protocol";

function env(agent_id: string, ts: string): Envelope {
  return { version: "1", agent_id, ts, type: "state_change", state: "idle" };
}

const a = env("a", "2026-10-09T10:00:00Z");
const b = env("b", "2026-10-09T12:00:00Z");
const c = env("c", "2026-10-09T11:00:00Z");

describe("sortAgents", () => {
  it("name は agent_id 順", () => {
    expect(sortAgents([c, a, b], "name").map((e) => e.agent_id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("recent は ts が新しい順", () => {
    expect(sortAgents([a, b, c], "recent").map((e) => e.agent_id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("recent で ts が同じ・不正なものは agent_id 順に落ちる", () => {
    const x = env("x", "not a date");
    const y = env("y", "not a date");
    const z = env("z", "2026-10-09T09:00:00Z");
    expect(sortAgents([y, z, x], "recent").map((e) => e.agent_id)).toEqual([
      "z",
      "x",
      "y",
    ]);
  });

  it("入力配列を書き換えない", () => {
    const input = [c, a, b];
    sortAgents(input, "name");
    expect(input.map((e) => e.agent_id)).toEqual(["c", "a", "b"]);
  });
});
