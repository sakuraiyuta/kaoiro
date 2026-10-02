import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SpawnResult } from "@kaoiro/protocol";
import { projectsDir } from "../src/sessions.js";
import { Supervisor } from "../src/supervisor.js";

it("restores at the launch cwd through default T3 queries and retains exact authorization", () => {
  const cwd = mkdtempSync(join(tmpdir(), "fuji480-runner-"));
  const previousHome = process.env.HOME;
  const home = join(cwd, "home");
  try {
    mkdirSync(home);
    process.env.HOME = home;
    const moved = join(cwd, "worktrees", "moved");
    const store = projectsDir(cwd);
    const sessionId = "11111111-2222-4333-8444-555555555555";
    mkdirSync(moved, { recursive: true });
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, `${sessionId}.jsonl`), "");
    expect(store).toBe(join(home, ".claude", "projects", basename(store)));
    const launches: Array<{ cwd: string; sessionId: string | undefined }> = [];
    const results: SpawnResult[] = [];
    const supervisor = new Supervisor({
      hostId: "restore-cwd-test",
      cwdAllowlist: [cwd],
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      launch: (_agentId, _config, launchCwd, resumeSessionId) => {
        launches.push({ cwd: launchCwd, sessionId: resumeSessionId });
        return { on() {}, kill() { return true; } };
      },
      sendResult: (result) => results.push(result),
      sendSessions() {},
      sendResetResult() {},
      sendStopAgent() {},
    });
    const payload = {
      version: "0",
      agent_id: "restore-cwd-test.resume",
      persona: { id: "fuji", name: "Fuji", sprite_set: "fuji" },
      cwd,
      engine: "claude-code",
      resume_session_id: sessionId,
    };
    try {
      supervisor.handleSpawn(payload);
      expect(results[0]).toMatchObject({ ok: true });
      expect(launches).toEqual([{ cwd, sessionId }]);

      supervisor.handleSpawn({ ...payload, agent_id: "restore-cwd-test.moved", cwd: moved });
      expect(results[1]).toMatchObject({ ok: false, reason: "cwd_not_found" });
      expect(launches).toHaveLength(1);

      supervisor.handleSpawn({
        ...payload,
        agent_id: "restore-cwd-test.missing",
        resume_session_id: "99999999-2222-4333-8444-555555555555",
      });
      expect(results[2]).toMatchObject({ ok: false, reason: "session_not_found" });
      expect(launches).toHaveLength(1);

      supervisor.handleSpawn({
        ...payload,
        agent_id: "restore-cwd-test.fresh",
        resume_session_id: undefined,
        apply_resume_snapshot: true,
      });
      expect(results[3]).toMatchObject({ ok: true });
      expect(launches[1]).toEqual({ cwd, sessionId: undefined });
    } finally {
      supervisor.stopAll();
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
  }
});
