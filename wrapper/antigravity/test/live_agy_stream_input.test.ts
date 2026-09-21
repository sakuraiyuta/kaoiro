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
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBroker, type Envelope } from "@kaoiro/agent-common";
import { AntigravityHost, type SpawnedAgy } from "../src/host.js";
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

  // issue #377 Stage 2 (kohaku implementation review round 1, must-fix M-A):
  // the test above proves Stage 1's stdin-transport claim (a promoted
  // background task survives past 10s) but only ever runs ONE turn -- it
  // cannot measure Stage 2's own claim, that a SECOND turn reuses the same
  // `agy` process instead of spawning a fresh one. A fixture-based pin
  // cannot close that gap either: the fake agy in host.test.ts supplies the
  // "one process, two turns" premise itself, so it cannot refute it. Only a
  // real spawn count against the real CLI can.
  it("issue #377 Stage 2: turn 2 reuses turn 1's live agy process instead of respawning", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-live-377-s2-"));
    const cfg: AntigravityLaunchConfig = {
      agent_id: "live.377.s2",
      persona: { id: "p", name: "P", sprite_set: "p" },
      display_name: "P",
      server_url: "ws://localhost:4000/wrapper",
      model: "gemini-3.8-flash-low",
      approval: "never",
    };
    let spawnCount = 0;
    const countingSpawn = (
      command: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv },
    ): SpawnedAgy => {
      spawnCount += 1;
      // Mirrors AntigravityHost's own #defaultSpawn (issue #379 detached
      // process group) -- this test measures the wrapper's REUSE decision,
      // not a different spawn strategy, so the substrate must match.
      return nodeSpawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      }) as unknown as SpawnedAgy;
    };
    const logs: Envelope[] = [];
    const sessionIdsBySeq: Array<string | undefined> = [];
    // issue #377 Stage 2 review nit N3: if `sleep 20` actually promoted to a
    // background task, this records whether the CLI's own "waiting"
    // stderr line appeared, alongside the reuse measurement above.
    const stderrKinds: string[] = [];
    let sessionId: string | undefined;
    const host = new AntigravityHost(cfg, {
      cwd: root,
      appendSystemPrompt:
        "You are a test probe. When asked to run a shell command, use run_command " +
        "exactly once and reply with its stdout verbatim, prefixed by RESULT=. " +
        "When asked what command you previously ran, answer from your own turn " +
        "history, prefixed by RESULT=, without running any tool.",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {},
      onLog: (envelope) => logs.push(envelope),
      onSessionId: (id) => { sessionId = id; },
      onEpochStderrLine: (info) => stderrKinds.push(info.kind),
      spawn: countingSpawn,
    });
    const results = (): Envelope[] => logs.filter((envelope) => envelope.type === "result");
    try {
      const turn1StartedAt = Date.now();
      await host.send(
        "Run `sleep 20 && echo done` via run_command (do not set a custom " +
          "WaitMsBeforeAsync) and reply with RESULT=<its stdout>.",
      );
      await waitFor(() => results().length === 1, 90_000);
      const turn1ElapsedMs = Date.now() - turn1StartedAt;
      sessionIdsBySeq.push(sessionId);

      const turn2StartedAt = Date.now();
      await host.send(
        "What exact shell command did you run via run_command in the previous " +
          "turn? Reply with RESULT=<the exact command>, without running any tool.",
      );
      await waitFor(() => results().length === 2, 90_000);
      const turn2ElapsedMs = Date.now() - turn2StartedAt;
      sessionIdsBySeq.push(sessionId);

      const turn2Text = String(
        (results()[1]?.payload as { text?: string } | undefined)?.text ?? "",
      );
      // Recorded for the issue #377 comment this run's operator posts.
      // eslint-disable-next-line no-console
      console.log(
        `[issue #377 S2 live run] spawn_count=${spawnCount} ` +
          `turn1_elapsed_ms=${turn1ElapsedMs} turn2_elapsed_ms=${turn2ElapsedMs} ` +
          `conversation_id_turn1=${sessionIdsBySeq[0]} conversation_id_turn2=${sessionIdsBySeq[1]} ` +
          `turn2_text=${JSON.stringify(turn2Text)} epoch_stderr_kinds=${JSON.stringify(stderrKinds)}`,
      );
      expect(spawnCount).toBe(1);
      expect(sessionIdsBySeq[1]).toBe(sessionIdsBySeq[0]);
      // Turn 1 spends ~20s inside the sleep plus network overhead; turn 2
      // asks nothing that touches a tool, so a reused, already-warm process
      // answering from its own turn history should return in a small
      // fraction of that -- a respawn would instead re-pay the full CLI
      // startup + conversation-resume cost on top of the model round trip.
      expect(turn2ElapsedMs).toBeLessThan(turn1ElapsedMs / 2);
      expect(turn2Text.toLowerCase()).toContain("sleep");
    } finally {
      host.close();
      rmSync(root, { force: true, recursive: true });
    }
  }, 150_000);
});
