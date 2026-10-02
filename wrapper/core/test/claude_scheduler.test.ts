import { describe, expect, it } from "vitest";
import {
  CLAUDE_SCHEDULER_SETTINGS,
  claudeSchedulerRangeMessage,
  isClaudeSchedulerEnvSet,
  parseClaudeSchedulerNumber,
} from "../src/claude_scheduler.js";
import { parseConfig } from "../src/persona.js";

// Literal expectations on purpose: they must stay green only if the shared
// bounds are still the documented ones, not whatever the table now says.
const DOCUMENTED = [
  ["yield_claim_timeout_ms", "KAOIRO_CLAUDE_YIELD_CLAIM_TIMEOUT_MS", 60_000],
  [
    "pending_receipt_root_timeout_ms",
    "KAOIRO_CLAUDE_PENDING_RECEIPT_ROOT_TIMEOUT_MS",
    60_000,
  ],
  ["urgent_overtake_limit", "KAOIRO_CLAUDE_URGENT_OVERTAKE_LIMIT", 64],
  ["folds_per_turn", "KAOIRO_CLAUDE_FOLDS_PER_TURN", 64],
] as const;

const base = {
  agent_id: "a.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

describe("Claude scheduler settings", () => {
  it("keeps the documented field, variable and ceiling for each setting", () => {
    expect(
      CLAUDE_SCHEDULER_SETTINGS.map((s) => [s.field, s.env, s.max]),
    ).toEqual(DOCUMENTED.map((d) => [...d]));
  });

  describe.each(DOCUMENTED)("%s", (field, env, max) => {
    const setting = CLAUDE_SCHEDULER_SETTINGS.find((s) => s.field === field)!;

    it("accepts 1 and the ceiling, rejects 0 and ceiling + 1", () => {
      expect(parseClaudeSchedulerNumber(1, max)).toBe(1);
      expect(parseClaudeSchedulerNumber(max, max)).toBe(max);
      expect(parseClaudeSchedulerNumber(0, max)).toBeUndefined();
      expect(parseClaudeSchedulerNumber(max + 1, max)).toBeUndefined();
    });

    it("keeps the legacy Number() grammar for non-numbers", () => {
      expect(parseClaudeSchedulerNumber("3", max)).toBe(3);
      expect(parseClaudeSchedulerNumber("1e1", max)).toBe(10);
      expect(parseClaudeSchedulerNumber(true, max)).toBe(1);
      expect(parseClaudeSchedulerNumber(" ", max)).toBeUndefined();
      expect(parseClaudeSchedulerNumber("  7  ", max)).toBe(7);
      expect(parseClaudeSchedulerNumber("", max)).toBeUndefined();
      expect(parseClaudeSchedulerNumber("abc", max)).toBeUndefined();
      expect(parseClaudeSchedulerNumber(1.5, max)).toBeUndefined();
      expect(parseClaudeSchedulerNumber(Number.MAX_SAFE_INTEGER + 1, max)).toBeUndefined();
    });

    it("parseConfig applies the same range and message", () => {
      expect(parseConfig({ ...base, [field]: max })[field]).toBe(max);
      expect(() => parseConfig({ ...base, [field]: max + 1 })).toThrow(
        `${field} must be an integer from 1 through ${max}`,
      );
      expect(claudeSchedulerRangeMessage(setting)).toBe(
        `${field} must be an integer from 1 through ${max}`,
      );
    });

    it("parseConfig reads the variable when the field is absent, config wins", () => {
      const previous = process.env[env];
      try {
        process.env[env] = "2";
        expect(parseConfig({ ...base })[field]).toBe(2);
        expect(parseConfig({ ...base, [field]: 5 })[field]).toBe(5);
        process.env[env] = "";
        expect(parseConfig({ ...base })[field]).toBeUndefined();
        process.env[env] = " ";
        expect(() => parseConfig({ ...base })).toThrow(field);
      } finally {
        if (previous === undefined) delete process.env[env];
        else process.env[env] = previous;
      }
    });
  });

  it("treats exactly the empty string as an unset variable", () => {
    expect(isClaudeSchedulerEnvSet(undefined)).toBe(false);
    expect(isClaudeSchedulerEnvSet("")).toBe(false);
    expect(isClaudeSchedulerEnvSet(" ")).toBe(true);
    expect(isClaudeSchedulerEnvSet("0")).toBe(true);
  });
});
