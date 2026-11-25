import "../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { makeLauncher } from "../src/spawn.js";
import { computeBehaviourRelay } from "../src/behaviour-settings.js";
import { Supervisor } from "../src/supervisor.js";

it.each(["candidate", "live"])(
  "reads a real %s checkpoint into the next Muse launch file", async (kind) => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-muse-recovery-wiring-"));
  const result = join(root, "resumed.json");
  vi.stubEnv("MUSE_RECOVERY_RESULT", result);
  vi.stubEnv("MUSE_RECOVERY_INITIAL_LIVE", kind === "live" ? "1" : "");
  const driver = fileURLToPath(new URL("./fixtures/muse-recovery-driver.mjs", import.meta.url));
  const supervisor = new Supervisor({
    hostId: "fixture", cwdAllowlist: [root], wrapperServerUrl: "ws://fixture/wrapper",
    launch: makeLauncher([process.execPath, driver]),
    sendResult() {}, sendSessions() {}, sendResetResult() {}, sendStopAgent() {},
    listSessions: () => [], sessionExists: () => true,
    behaviourRelay: computeBehaviourRelay({ host_id: "fixture",
      server_url: "ws://fixture/runner", cwd_allowlist: [root],
      permission_timeout_ms: 5000 }, {}),
  });
  try {
    supervisor.handleSpawn({ version: "0", agent_id: "fixture.muse",
      persona: { id: "p", name: "P", sprite_set: "p" }, cwd: root,
      engine: "muse", initial_prompt: "first" });
    await vi.waitFor(() => expect(existsSync(result)).toBe(true), { timeout: 10_000 });
    const config = JSON.parse(readFileSync(result, "utf8"));
    expect(config).toMatchObject({ resume_session_id: "fixture-session",
      permission_timeout_ms: 5000 });
    if (kind === "candidate") expect(config.recovery_resume_kind).toBe("candidate");
    else expect(config).not.toHaveProperty("recovery_resume_kind");
    expect(config).not.toHaveProperty("initial_prompt");
  } finally {
    supervisor.stopAll();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
