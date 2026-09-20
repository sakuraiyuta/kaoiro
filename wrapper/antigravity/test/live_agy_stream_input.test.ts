// issue #377 Stage 1 M2 (kohaku design review round 1): the fixture-based
// pins above measure the wrapper's OWN responsibility (argv shape, the
// NDJSON write, the ack point) against a fake stdin/stdout pair -- they
// cannot measure the actual claim this Stage exists to fix, that the real
// `agy --input-format stream-json` CLI waits for a promoted `run_command`
// background task before emitting `result`, instead of killing it 5s after
// the model's last text the way argv-prompt mode does (measured,
// docs/evidence/antigravity/print-mode-background-tasks.md probe E). Gated
// behind KAOIRO_LIVE_AGY=1 (default skip) since it makes a real network call
// against the operator's own Antigravity account; run manually with a short
// external `timeout` wrapper, e.g.:
//   KAOIRO_LIVE_AGY=1 timeout 120 pnpm exec vitest run \
//     test/live_agy_stream_input.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBroker, type Envelope } from "@kaoiro/agent-common";
import { AntigravityHost } from "../src/host.js";
import type { AntigravityLaunchConfig } from "../src/gate.js";

const LIVE = process.env.KAOIRO_LIVE_AGY === "1";

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

describe.skipIf(!LIVE)("Antigravity Stage 1 stdin transport against the real agy CLI (issue #377, KAOIRO_LIVE_AGY=1)", () => {
  it("keeps a run_command promoted past 10s alive until result", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-live-377-"));
    const cfg: AntigravityLaunchConfig = {
      agent_id: "live.377",
      persona: { id: "p", name: "P", sprite_set: "p" },
      display_name: "P",
      server_url: "ws://localhost:4000/wrapper",
      model: "gemini-3.8-flash-low",
      // "never" auto-allows run_command at the wrapper's own gate (F4) so
      // this scratch probe never blocks on the no-op PermissionBroker
      // below waiting for an operator decision that will never arrive.
      approval: "never",
    };
    const logs: Envelope[] = [];
    let sessionId: string | undefined;
    const host = new AntigravityHost(cfg, {
      cwd: root,
      appendSystemPrompt:
        "You are a test probe. When asked to run a shell command, use run_command " +
        "exactly once and reply with its stdout verbatim, prefixed by RESULT=.",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {},
      onLog: (envelope) => logs.push(envelope),
      onSessionId: (id) => { sessionId = id; },
    });
    const startedAt = Date.now();
    try {
      await host.send(
        "Run `sleep 20 && echo done` via run_command (do not set a custom " +
          "WaitMsBeforeAsync) and reply with RESULT=<its stdout>.",
      );
      await waitFor(() => logs.some((envelope) => envelope.type === "result"), 90_000);
      const elapsedMs = Date.now() - startedAt;
      const result = logs.find((envelope) => envelope.type === "result");
      const text = String((result?.payload as { text?: string } | undefined)?.text ?? "");
      // Recorded for the issue #377 comment this run's operator posts.
      // eslint-disable-next-line no-console
      console.log(`[issue #377 M2 live run] elapsed_ms=${elapsedMs} conversation_id=${sessionId} payload=${JSON.stringify(result?.payload)}`);
      expect(text).toContain("done");
    } finally {
      host.close();
      rmSync(root, { force: true, recursive: true });
    }
  }, 120_000);
});
