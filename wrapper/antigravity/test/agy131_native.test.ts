// issue #534: Antigravity CLI 1.3.1 native production entrypoint acceptance.
// Verifies through the production `runAntigravityCli` entrypoint (using the
// default host factory and production tool assembly) against the real local
// `agy` 1.3.1 binary.
// Gated behind KAOIRO_LIVE_AGY=1 (default skip) since it performs a real provider turn.
// Run with:
//   KAOIRO_LIVE_AGY=1 PATH="/usr/bin:$PATH" pnpm exec vitest run test/agy131_native.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";
import type { AntigravityHost } from "../src/host.js";

const LIVE = process.env.KAOIRO_LIVE_AGY === "1";

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 250): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

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
    let statusLineCalled = false;
    let statusLineArg = "";

    let linkCallbacks: any;
    const observationLink = {
      close: () => {},
      send: (envelope: Envelope) => {
        recordedEnvelopes.push(envelope);
        if (envelope.type === "state_change") {
          const state = (envelope as any).state;
          if (state) {
            stateChanges.push({ state, at: new Date().toISOString() });
            process.stderr.write(`[harness state_change] ${state}\n`);
          }
        }
        if (envelope.type === "result") {
          process.stderr.write(`[harness result] received\n`);
        }
      },
      setSessionId: (_sessionId: string) => {},
      reportPermissionLifecycle: () => {},
      setStatusLine: async (text: string) => {
        statusLineCalled = true;
        statusLineArg = text;
        process.stderr.write(`[harness tool called] set_status_line text=${JSON.stringify(text)}\n`);
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
          return observationLink as any;
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
        () => statusLineCalled && stateChanges.some((s) => s.state === "waiting_input"),
        240_000,
      );

      const elapsedMs = performance.now() - startedAt;
      const resultEnvelope = recordedEnvelopes.find((e) => e.type === "result");
      const finalState = stateChanges[stateChanges.length - 1]?.state;

      // Verification assertions
      expect(statusLineCalled).toBe(true);
      expect(statusLineArg).toBe("verified-1.3.1");
      expect(resultEnvelope).toBeDefined();
      expect(finalState).toBe("waiting_input");

      // Console output for capture in verification records
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        cli_version: "1.3.1",
        elapsed_ms: elapsedMs,
        tool_called: statusLineCalled,
        tool_arg: statusLineArg,
        state_history: stateChanges.map((s) => s.state),
        final_state: finalState,
        turn_completed: resultEnvelope !== undefined,
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
