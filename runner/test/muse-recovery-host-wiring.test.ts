import "../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { makeLauncher } from "../src/spawn.js";
import { Supervisor } from "../src/supervisor.js";

it.each(["mode", "switch"])(
  "revalidates approval after %s failure without replaying the queue", async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-muse-host-recovery-"));
    const result = join(root, "resumed.json");
    const prompts = join(root, "prompts.jsonl");
    vi.stubEnv("MUSE_RECOVERY_RESULT", result);
    vi.stubEnv("MUSE_HOST_SCENARIO", scenario);
    vi.stubEnv("KAOIRO_TEST_MUSE_PROMPTS_FILE", prompts);
    vi.stubEnv("MUSE_HOST_FAKE", fileURLToPath(
      new URL("../../wrapper/muse/test/fixtures/muse.mjs", import.meta.url)));
    const driver = fileURLToPath(
      new URL("./fixtures/muse-recovery-host-driver.mjs", import.meta.url));
    const supervisor = new Supervisor({ hostId: "fixture", cwdAllowlist: [root],
      wrapperServerUrl: "ws://fixture/wrapper", launch: makeLauncher([process.execPath, driver]),
      sendResult() {}, sendSessions() {}, sendResetResult() {}, sendStopAgent() {},
      listSessions: () => [], sessionExists: () => true });
    try {
      supervisor.handleSpawn({ version: "0", agent_id: "fixture.muse",
        persona: { id: "p", name: "P", sprite_set: "p" }, cwd: root, engine: "muse" });
      await vi.waitFor(() => expect(existsSync(result)).toBe(true), { timeout: 10_000 });
      const resumed = JSON.parse(readFileSync(result, "utf8"));
      expect(resumed).toMatchObject({ resume: "fixture-session",
        mode: { id: "promptUnmatched" }, initial: null });
      const sent = readFileSync(prompts, "utf8");
      expect(sent).not.toContain("must-not-replay");
    } finally {
      supervisor.stopAll();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000,
);
