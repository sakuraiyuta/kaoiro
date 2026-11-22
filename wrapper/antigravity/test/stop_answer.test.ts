import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import {
  MAX_STOP_CONTINUATIONS,
  STOP_CONTINUE_REASON,
  answerStop,
  type StopContext,
  type StopRequest,
} from "../src/stop_answer.js";

const SESSION = "session-g";
const holding: StopRequest = { conversationId: SESSION, terminationReason: "NO_TOOL_CALL", fullyIdle: false };
const open: StopContext = { sessionId: SESSION, windowOpen: true, stopLatched: false, granted: 0 };
const proceed = { decision: "continue", reason: STOP_CONTINUE_REASON, counted: true };
const stop = { decision: "stop", counted: false };

describe("answerStop (L10)", () => {
  it("continues inside the window while the prompt's own loop reports background work", () => {
    expect(answerStop(holding, open)).toEqual(proceed);
  });

  it("answers stop outside the window (L5)", () => {
    expect(answerStop(holding, { ...open, windowOpen: false })).toEqual(stop);
  });

  it("answers stop once a stop cause is latched for the input", () => {
    expect(answerStop(holding, { ...open, stopLatched: true })).toEqual(stop);
  });

  it.each(["MAX_TURNS", "ERROR", undefined, ""])("answers stop for terminationReason %s", (terminationReason) => {
    expect(answerStop({ ...holding, terminationReason }, open)).toEqual(stop);
  });

  it.each([true, undefined, "false", 0])("answers stop when fullyIdle is %s", (fullyIdle) => {
    expect(answerStop({ ...holding, fullyIdle }, open)).toEqual(stop);
  });

  it("grants the tenth continuation and answers the next request stop", () => {
    expect(MAX_STOP_CONTINUATIONS).toBe(10);
    expect(answerStop(holding, { ...open, granted: 9 })).toEqual(proceed);
    expect(answerStop(holding, { ...open, granted: 10 })).toEqual(stop);
  });

  it("answers a subagent's own loop stop without counting it", () => {
    expect(answerStop({ ...holding, conversationId: "session-sub" }, open)).toEqual(stop);
  });

  it("answers stop while the generation's session ID is unknown", () => {
    expect(answerStop(holding, { ...open, sessionId: undefined })).toEqual(stop);
  });
});
