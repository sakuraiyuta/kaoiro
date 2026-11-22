import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { CallVerifier, canonicalArgs, type VerificationFault } from "../src/call_verification.js";

const SESSION = "session-g";
const SUBAGENT = "session-sub";

function setup(sessionId: string | null = SESSION) {
  const faults: VerificationFault[] = [];
  const repeats: string[] = [];
  const verifier = new CallVerifier({
    sessionId: () => sessionId ?? undefined,
    onFault: (fault) => faults.push(fault),
    onRepeat: (callId) => repeats.push(callId),
  });
  return { verifier, faults, repeats };
}

const ARGS = { CommandLine: "ls", WaitMsBeforeAsync: 500 };

/** H in the given state for (conversation, call). */
function hook(
  verifier: CallVerifier,
  state: "received" | "allow" | "deny" | "abandoned",
  options: { conversationId?: string; callId?: string; name?: string; args?: unknown } = {},
): void {
  const conversationId = options.conversationId ?? SESSION;
  const callId = options.callId ?? "c1";
  verifier.hookReceived(conversationId, callId, options.name ?? "run_command", options.args ?? ARGS);
  if (state === "allow" || state === "deny") verifier.hookDecided(conversationId, callId, state);
  if (state === "abandoned") verifier.hookAbandoned(conversationId, callId);
}

function call(verifier: CallVerifier, status: "in_progress" | "completed" | "failed", options: { callId?: string; name?: unknown; args?: unknown } = {}): void {
  verifier.toolUpdate(options.callId ?? "c1", options.name ?? "run_command", options.args ?? ARGS, status);
}

describe("CallVerifier: section 4.3 table", () => {
  it("completed with decided(allow), same name and arguments: ok", () => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    hook(verifier, "allow");
    call(verifier, "completed");
    expect(faults).toEqual([]);
  });

  it.each(["deny", "received", "abandoned"] as const)("completed with %s: fault", (state) => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    hook(verifier, state);
    call(verifier, "completed");
    expect(faults).toEqual([{ kind: "unobserved_tool", callId: "c1", name: "run_command", status: "completed", hook: state }]);
  });

  it("completed with no hook: fault (the no-hook control gives the last row)", () => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    call(verifier, "completed");
    expect(faults).toEqual([{ kind: "unobserved_tool", callId: "c1", name: "run_command", status: "completed", hook: "none" }]);
  });

  it("completed with decided(allow) but another name or other arguments: fault", () => {
    for (const different of [{ name: "write_file" }, { args: { CommandLine: "rm -rf x" } }]) {
      const { verifier, faults } = setup();
      call(verifier, "in_progress");
      hook(verifier, "allow", different);
      call(verifier, "completed");
      expect(faults).toHaveLength(1);
    }
  });

  it.each(["allow", "deny"] as const)("failed with decided(%s), same name and arguments: ok", (state) => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    hook(verifier, state);
    call(verifier, "failed");
    expect(faults).toEqual([]);
  });

  it("failed with decided(deny) but other arguments: fault, also after a stop", () => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    hook(verifier, "deny", { args: { CommandLine: "other" } });
    verifier.stopLatched();
    call(verifier, "failed");
    expect(faults).toHaveLength(1);
  });

  it.each(["received", "abandoned", "none"] as const)("failed with %s: fault without a stop, ok after a stop latched while it was open", (state) => {
    for (const stopped of [false, true]) {
      const { verifier, faults } = setup();
      call(verifier, "in_progress");
      if (state !== "none") hook(verifier, state);
      if (stopped) verifier.stopLatched();
      call(verifier, "failed");
      expect(faults).toHaveLength(stopped ? 0 : 1);
    }
  });

  it("a stop latched before the call was first seen does not cover it", () => {
    const { verifier, faults } = setup();
    verifier.stopLatched();
    call(verifier, "in_progress");
    call(verifier, "failed");
    expect(faults).toHaveLength(1);
  });

  it("open at settlement: run_command and other tools with decided(allow) are not faults", () => {
    for (const name of ["run_command", "read_file"]) {
      const { verifier, faults } = setup();
      call(verifier, "in_progress", { name });
      hook(verifier, "allow", { name });
      verifier.settle();
      expect(faults).toEqual([]);
    }
  });

  it.each(["received", "abandoned", "none", "deny"] as const)("open at settlement with %s: fault without a stop", (state) => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    if (state !== "none") hook(verifier, state);
    verifier.settle();
    expect(faults).toEqual([{ kind: "unobserved_tool", callId: "c1", name: "run_command", status: "open", hook: state }]);
  });

  it.each(["received", "abandoned", "none"] as const)("open at settlement with %s after a stop: ok", (state) => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    if (state !== "none") hook(verifier, state);
    verifier.stopLatched();
    verifier.settle();
    expect(faults).toEqual([]);
  });
});

describe("CallVerifier: after settlement", () => {
  it("a matching late completed before exit is ok", () => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    hook(verifier, "allow");
    verifier.settle();
    call(verifier, "completed");
    expect(faults).toEqual([]);
  });

  it("a late completed with no hook record is a fault, even when settlement passed after a stop", () => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    verifier.stopLatched();
    verifier.settle();
    expect(faults).toEqual([]);
    call(verifier, "completed");
    expect(faults).toEqual([{ kind: "unobserved_tool", callId: "c1", name: "run_command", status: "completed", hook: "none" }]);
  });

  it("ignores repeated terminal updates and reports the repeat once", () => {
    const { verifier, faults, repeats } = setup();
    call(verifier, "in_progress");
    hook(verifier, "allow");
    call(verifier, "completed");
    call(verifier, "failed");
    call(verifier, "completed");
    expect(faults).toEqual([]);
    expect(repeats).toEqual(["c1"]);
  });
});

describe("CallVerifier: the key (generation, conversation, call ID)", () => {
  it("joins only H of the generation's own session", () => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    hook(verifier, "allow", { conversationId: SUBAGENT });
    call(verifier, "completed");
    expect(faults).toEqual([{ kind: "unobserved_tool", callId: "c1", name: "run_command", status: "completed", hook: "none" }]);
  });

  it("joins only H with the same call ID", () => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    hook(verifier, "allow", { callId: "c2" });
    call(verifier, "completed");
    expect(faults).toHaveLength(1);
  });

  it("joins nothing before the session ID is known", () => {
    const { verifier, faults } = setup(null);
    call(verifier, "in_progress");
    hook(verifier, "allow");
    call(verifier, "completed");
    expect(faults).toHaveLength(1);
  });

  it("compares arguments in a canonical form", () => {
    const { verifier, faults } = setup();
    verifier.toolUpdate("c1", "run_command", { WaitMsBeforeAsync: 500, CommandLine: "ls" }, "in_progress");
    hook(verifier, "allow", { args: { CommandLine: "ls", WaitMsBeforeAsync: 500 } });
    call(verifier, "completed");
    expect(faults).toEqual([]);
    expect(canonicalArgs({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
  });

  it("a call without a string name cannot match", () => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress", { name: 7 });
    hook(verifier, "allow");
    call(verifier, "completed");
    expect(faults).toHaveLength(1);
  });
});

describe("CallVerifier: hooks from another conversation (subagent, L6)", () => {
  it("a foreign H with no C is not a fault", () => {
    const { verifier, faults } = setup();
    hook(verifier, "allow", { conversationId: SUBAGENT });
    verifier.settle();
    expect(faults).toEqual([]);
  });

  it("a duplicate of a foreign H is a fault, and the second request is refused", () => {
    const { verifier, faults } = setup();
    expect(verifier.hookReceived(SUBAGENT, "c1", "run_command", ARGS)).toBe(true);
    expect(verifier.hookReceived(SUBAGENT, "c1", "run_command", ARGS)).toBe(false);
    expect(faults).toEqual([{ kind: "duplicate_hook", conversationId: SUBAGENT, callId: "c1", name: "run_command" }]);
  });

  it("a duplicate H of the generation's own session is a fault", () => {
    const { verifier, faults } = setup();
    expect(verifier.hookReceived(SESSION, "c1", "run_command", ARGS)).toBe(true);
    expect(verifier.hookReceived(SESSION, "c1", "run_command", ARGS)).toBe(false);
    expect(faults).toHaveLength(1);
  });

  it("the same call ID in two conversations makes independent records", () => {
    const { verifier, faults } = setup();
    expect(verifier.hookReceived(SUBAGENT, "c1", "write_file", { Path: "x" })).toBe(true);
    call(verifier, "in_progress");
    expect(verifier.hookReceived(SESSION, "c1", "run_command", ARGS)).toBe(true);
    verifier.hookDecided(SESSION, "c1", "allow");
    call(verifier, "completed");
    expect(faults).toEqual([]);
  });

  it("a parent C whose only H has another conversation ID is a fault", () => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    hook(verifier, "allow", { conversationId: SUBAGENT });
    call(verifier, "failed");
    expect(faults).toEqual([{ kind: "unobserved_tool", callId: "c1", name: "run_command", status: "failed", hook: "none" }]);
  });
});

describe("CallVerifier: robustness", () => {
  it("ignores a decision or an abandonment for a key it never received", () => {
    const { verifier, faults } = setup();
    expect(() => verifier.hookDecided(SESSION, "nope", "allow")).not.toThrow();
    expect(() => verifier.hookAbandoned(SESSION, "nope")).not.toThrow();
    expect(faults).toEqual([]);
  });

  it("works without a repeat callback", () => {
    const faults: VerificationFault[] = [];
    const verifier = new CallVerifier({ sessionId: () => SESSION, onFault: (fault) => faults.push(fault) });
    hook(verifier, "allow");
    call(verifier, "in_progress");
    call(verifier, "completed");
    expect(() => call(verifier, "completed")).not.toThrow();
    expect(faults).toEqual([]);
  });

  it("an open call with decided(deny) at settlement is a fault even after a stop", () => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    hook(verifier, "deny");
    verifier.stopLatched();
    verifier.settle();
    expect(faults).toEqual([{ kind: "unobserved_tool", callId: "c1", name: "run_command", status: "open", hook: "deny" }]);
  });
});

describe("CallVerifier: hook states", () => {
  it("a decision is recorded only for a received H; an abandoned H stays abandoned", () => {
    const { verifier, faults } = setup();
    call(verifier, "in_progress");
    verifier.hookReceived(SESSION, "c1", "run_command", ARGS);
    verifier.hookAbandoned(SESSION, "c1");
    verifier.hookDecided(SESSION, "c1", "allow");
    call(verifier, "completed");
    expect(faults).toEqual([{ kind: "unobserved_tool", callId: "c1", name: "run_command", status: "completed", hook: "abandoned" }]);
  });
});
