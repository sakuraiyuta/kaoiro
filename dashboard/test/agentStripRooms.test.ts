import "./isolation.setup";
import { describe, expect, it } from "vitest";
import { KNOWN_STATES } from "../src/lib/expression";
import { roomLamp } from "../src/lib/agentStripRooms";

const priority = ["waiting_permission", "waiting_question", "waiting_input", "error", "tool_running", "thinking", "sending", "done", "idle", "disconnected"];
const items = (...states: string[]) => states.map((state) => ({ state }));

describe("room lamp", () => {
  it.each(KNOWN_STATES)("preserves the existing %s state color identity", (state) => {
    expect(roomLamp(items(state))).toBe(state);
  });
  it("uses the operator's urgency tiers and deterministic ties in either member order", () => {
    for (let i = 0; i < priority.length; i++) {
      for (let j = i + 1; j < priority.length; j++) {
        expect(roomLamp(items(priority[i]!, priority[j]!))).toBe(priority[i]);
        expect(roomLamp(items(priority[j]!, priority[i]!))).toBe(priority[i]);
      }
    }
  });
  it("keeps the existing idle fallback for unknown states", () => {
    expect(roomLamp(items("future-state", "disconnected"))).toBe("idle");
    expect(roomLamp([])).toBe("idle");
  });
});
