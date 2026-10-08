// issue #534: Antigravity CLI 1.3.1 native production entrypoint acceptance.
// Verifies through the production `runAntigravityCli` entrypoint (using the
// default host factory and production tool assembly) against the real local
// `agy` 1.3.1 binary.
// Gated behind KAOIRO_LIVE_AGY=1 (default skip) since it performs a real provider turn.
// Run live with:
//   KAOIRO_LIVE_AGY=1 PATH="/usr/bin:$PATH" pnpm exec vitest run test/agy131_native.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";
import type { AntigravityHost } from "../src/host.js";

const LIVE = process.env.KAOIRO_LIVE_AGY === "1";

export interface TurnOutcome {
  statusLineCalls: string[];
  recordedEnvelopes: Envelope[];
  stateHistory: string[];
}

/**
 * Validates that an Antigravity turn achieved genuine success:
 * 1. The kaoiro tool stub received exactly 1 call with the exact expected text.
 * 2. A non-error `result` envelope was produced.
 * 3. The state sequence transitioned through `done` before settling in `waiting_input`.
 */
export function verifyTurnSuccess(outcome: TurnOutcome): {
  toolCalled: boolean;
  toolArg: string;
  finalState: string;
  turnCompleted: boolean;
} {
  // 1. Tool invocation assertion: exactly 1 call with expected argument
  expect(outcome.statusLineCalls.length).toBe(1);
  const toolArg = outcome.statusLineCalls[0];
  expect(toolArg).toBe("verified-1.3.1");

  // 2. Result envelope assertion: must exist and indicate success
  const resultEnvelope = outcome.recordedEnvelopes.find((e) => e.type === "result");
  expect(resultEnvelope).toBeDefined();
  const payload = resultEnvelope?.payload as Record<string, unknown> | undefined;
  expect(payload?.is_error).not.toBe(true);
  if (typeof payload?.status === "string") {
    expect(payload.status).not.toBe("error");
  }

  // 3. State transition sequence assertion: done -> waiting_input
  const doneIndex = outcome.stateHistory.lastIndexOf("done");
  const waitingInputIndex = outcome.stateHistory.lastIndexOf("waiting_input");
  expect(doneIndex).toBeGreaterThanOrEqual(0);
  expect(waitingInputIndex).toBeGreaterThan(doneIndex);

  const finalState = outcome.stateHistory[outcome.stateHistory.length - 1];
  expect(finalState).toBe("waiting_input");

  if (!toolArg || !finalState) {
    throw new Error("Turn outcome missing tool argument or final state");
  }

  return {
    toolCalled: true,
    toolArg,
    finalState,
    turnCompleted: true,
  };
}

function createMockResultEnvelope(payload: Record<string, unknown>): Envelope {
  return {
    type: "result",
    version: "0",
    agent_id: "test",
    display_name: "test",
    persona: { id: "p", name: "P", sprite_set: "p" },
    ts: new Date().toISOString(),
    state: "done",
    payload,
    ext: {},
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 250): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe("Antigravity 1.3.1 native acceptance verification logic (deterministic negative controls)", () => {
  it("accepts a genuinely successful turn outcome", () => {
    const outcome: TurnOutcome = {
      statusLineCalls: ["verified-1.3.1"],
      recordedEnvelopes: [createMockResultEnvelope({ text: "All done", is_error: false })],
      stateHistory: ["idle", "sending", "thinking", "tool_running", "thinking", "done", "waiting_input"],
    };
    const verified = verifyTurnSuccess(outcome);
    expect(verified.toolCalled).toBe(true);
    expect(verified.toolArg).toBe("verified-1.3.1");
    expect(verified.finalState).toBe("waiting_input");
  });

  it("negative control: rejects when kaoiro tool was not called", () => {
    const outcome: TurnOutcome = {
      statusLineCalls: [],
      recordedEnvelopes: [createMockResultEnvelope({ text: "Done without tool", is_error: false })],
      stateHistory: ["idle", "sending", "done", "waiting_input"],
    };
    expect(() => verifyTurnSuccess(outcome)).toThrow();
  });

  it("negative control: rejects when tool argument does not match expected value", () => {
    const outcome: TurnOutcome = {
      statusLineCalls: ["unexpected-arg"],
      recordedEnvelopes: [createMockResultEnvelope({ text: "All done", is_error: false })],
      stateHistory: ["idle", "sending", "tool_running", "done", "waiting_input"],
    };
    expect(() => verifyTurnSuccess(outcome)).toThrow();
  });

  it("negative control: rejects when tool was called but turn ended in error", () => {
    // Case A: payload.is_error is true
    const outcomeA: TurnOutcome = {
      statusLineCalls: ["verified-1.3.1"],
      recordedEnvelopes: [createMockResultEnvelope({ text: "Turn failed", is_error: true })],
      stateHistory: ["idle", "sending", "tool_running", "done", "waiting_input"],
    };
    expect(() => verifyTurnSuccess(outcomeA)).toThrow();

    // Case B: state transitioned through error -> waiting_input without done
    const outcomeB: TurnOutcome = {
      statusLineCalls: ["verified-1.3.1"],
      recordedEnvelopes: [createMockResultEnvelope({ text: "Turn failed", is_error: false })],
      stateHistory: ["idle", "sending", "tool_running", "error", "waiting_input"],
    };
    expect(() => verifyTurnSuccess(outcomeB)).toThrow();
  });

  it("negative control: rejects when result envelope is missing", () => {
    const outcome: TurnOutcome = {
      statusLineCalls: ["verified-1.3.1"],
      recordedEnvelopes: [],
      stateHistory: ["idle", "sending", "tool_running", "done", "waiting_input"],
    };
    expect(() => verifyTurnSuccess(outcome)).toThrow();
  });
});

describe.skipIf(!LIVE)("Antigravity 1.3.1 native production entrypoint acceptance (issue #534, KAOIRO_LIVE_AGY=1)", () => {
  it("completes a native turn, calls kaoiro tool via PreToolUse bridge, and reaches waiting_input", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-native-534-"));
    const origCwd = process.cwd();
    process.chdir(root);

    const config: WrapperConfig = {
      agent_id: "native.534",
      persona: { id: "hiiro", name: "ひいろ", sprite_set: "hiiro" },
      display_name: "ひいろ",
      server_url: "ws://localhost:4000/wrapper",
      model: "gemini-3.8-flash-low",
      approval: "never",
      sandbox: "danger-full-access",
      network_access: true,
    };

    const recordedEnvelopes: Envelope[] = [];
    const stateChanges: Array<{ state: string; at: string }> = [];
    const statusLineCalls: string[] = [];

    let linkCallbacks: any;
    // Server boundary recording stub: captures tool invocations delivered
    // through the bridge and ToolHost to the ServerLink interface.
    const recordingServerLinkStub = {
      close: () => {},
      send: (envelope: Envelope) => {
        recordedEnvelopes.push(envelope);
        if (envelope.type === "state_change") {
          const state = (envelope as any).state;
          if (state) {
            stateChanges.push({ state, at: new Date().toISOString() });
          }
        }
      },
      setSessionId: (_sessionId: string) => {},
      reportPermissionLifecycle: () => {},
      setStatusLine: async (text: string) => {
        statusLineCalls.push(text);
        return {
          kind: "ok" as const,
          status_line: {
            text,
            bytes: Buffer.byteLength(text),
            truncated: false,
            updated_at: new Date().toISOString(),
          },
        };
      },
      readStatusLine: async () => ({
        kind: "ok" as const,
        agent_id: "other",
        status_line: { text: "ok", bytes: 2, updated_at: new Date().toISOString() },
      }),
      deliveryIncarnation: () => "native-test-incarnation",
      deliveryGeneration: () => 1,
      waitForPermissionSyncNegotiation: async () => true,
      waitForPermissionSync: async () => {},
      acknowledgeInterAgentDelivery: () => {},
      retireInterAgentDeliveries: () => {},
    };

    let hostInstance: AntigravityHost | undefined;
    const startedAt = performance.now();

    try {
      void runAntigravityCli({
        parseCliArgs: () => ({ configPath: "dummy.json", prompt: undefined, resume: undefined }),
        loadConfig: () => ({ ...config }),
        createServerLink: (_url, _agentId, callbacks) => {
          linkCallbacks = callbacks;
          queueMicrotask(() => {
            callbacks.onPersonaPrompt?.(
              "You are a test assistant in an automated integration test.\n" +
              "When instructed, you MUST immediately call the kaoiro tool `set_status_line` with text 'verified-1.3.1'.\n" +
              "Do not do anything else, just call set_status_line and reply 'All done'."
            );
          });
          return recordingServerLinkStub as any;
        },
        onHostCreated: (host) => {
          hostInstance = host;
        },
      });

      // 1. Wait for host creation and initial state change
      await waitFor(() => hostInstance !== undefined && linkCallbacks !== undefined, 10_000);
      await waitFor(() => stateChanges.some((s) => s.state === "idle"), 5_000);

      // 2. Dispatch instruction to start turn
      linkCallbacks.onInstruction("Please call the set_status_line tool with text 'verified-1.3.1' now.");

      // 3. Wait for tool invocation and turn completion
      await waitFor(
        () => statusLineCalls.length > 0 && stateChanges.some((s) => s.state === "waiting_input"),
        240_000,
      );

      const elapsedMs = performance.now() - startedAt;

      // 4. Validate turn outcome through strict verification logic
      const verified = verifyTurnSuccess({
        statusLineCalls,
        recordedEnvelopes,
        stateHistory: stateChanges.map((s) => s.state),
      });

      // Console output for capture in verification records
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        cli_version: "1.3.1",
        elapsed_ms: elapsedMs,
        tool_called: verified.toolCalled,
        tool_arg: verified.toolArg,
        state_history: stateChanges.map((s) => s.state),
        final_state: verified.finalState,
        turn_completed: verified.turnCompleted,
      }, null, 2));
    } finally {
      process.chdir(origCwd);
      if (hostInstance) {
        hostInstance.close();
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
