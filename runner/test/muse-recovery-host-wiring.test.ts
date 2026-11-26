import "../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { makeLauncher } from "../src/spawn.js";
import { Supervisor } from "../src/supervisor.js";

it("refuses runner recovery after watchdog cancel followed by interrupt", async () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-muse-watchdog-recovery-"));
  const result = join(root, "blocked.json");
  vi.stubEnv("MUSE_RECOVERY_RESULT", result);
  vi.stubEnv("MUSE_CANCEL_FILE", join(root, "cancel"));
  vi.stubEnv("MUSE_HOST_SCENARIO", "watchdog");
  vi.stubEnv("MUSE_HOST_FAKE", fileURLToPath(
    new URL("../../wrapper/muse/test/fixtures/muse.mjs", import.meta.url)));
  const driver = fileURLToPath(
    new URL("./fixtures/muse-recovery-host-driver.mjs", import.meta.url));
  const launch = makeLauncher([process.execPath, driver]);
  let launches = 0;
  const supervisor = new Supervisor({ hostId: "fixture", cwdAllowlist: [root],
    wrapperServerUrl: "ws://fixture/wrapper",
    launch: (...args) => { launches += 1; return launch(...args); },
    sendResult() {}, sendSessions() {}, sendResetResult() {}, sendStopAgent() {},
    listSessions: () => [], sessionExists: () => true });
  const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    supervisor.handleSpawn({ version: "0", agent_id: "fixture.muse",
      persona: { id: "p", name: "P", sprite_set: "p" }, cwd: root, engine: "muse" });
    await vi.waitFor(() => expect(diagnostic.mock.calls.some(([value]) =>
      String(value).includes("checkpoint=blocked:watchdog"))).toBe(true),
    { timeout: 10_000 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({
      state: "blocked", reason: "watchdog", session_id: "fixture-session",
    });
    expect(launches).toBe(1);
  } finally {
    supervisor.stopAll();
    diagnostic.mockRestore();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

it(
  "revalidates approval after mode failure without replaying the queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-muse-host-recovery-"));
    const result = join(root, "resumed.json");
    const prompts = join(root, "prompts.jsonl");
    vi.stubEnv("MUSE_RECOVERY_RESULT", result);
    vi.stubEnv("MUSE_HOST_SCENARIO", "mode");
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

it.each(["none", "before-response", "before-checkpoint"])(
  "carries persona evidence through runner after %s", async (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-muse-persona-recovery-"));
  const result = join(root, "resumed.json");
  const prompts = join(root, "prompts.jsonl");
  vi.stubEnv("MUSE_RECOVERY_RESULT", result);
  if (scenario === "before-response")
    vi.stubEnv("MUSE_PROMPT_CRASH_MARKER", join(root, "received"));
  if (scenario === "before-checkpoint")
    vi.stubEnv("MUSE_RESPONSE_CRASH_MARKER", join(root, "confirmed"));
  vi.stubEnv("KAOIRO_TEST_MUSE_PROMPTS_FILE", prompts);
  vi.stubEnv("MUSE_HOST_FAKE", fileURLToPath(
    new URL("../../wrapper/muse/test/fixtures/muse.mjs", import.meta.url)));
  const driver = fileURLToPath(
    new URL("./fixtures/muse-persona-recovery-driver.mjs", import.meta.url));
  const supervisor = new Supervisor({ hostId: "fixture", cwdAllowlist: [root],
    wrapperServerUrl: "ws://fixture/wrapper", launch: makeLauncher([process.execPath, driver]),
    sendResult() {}, sendSessions() {}, sendResetResult() {}, sendStopAgent() {},
    listSessions: () => [], sessionExists: () => true });
  try {
    supervisor.handleSpawn({ version: "0", agent_id: "fixture.muse",
      persona: { id: "p", name: "P", sprite_set: "p" }, cwd: root, engine: "muse" });
    await vi.waitFor(() => expect(existsSync(result)).toBe(true), { timeout: 10_000 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({
      resume: "fixture-session", delivered: true,
    });
    const inputs = readFileSync(prompts, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as string);
    expect(inputs).toHaveLength(scenario === "none" ? 2 : 3);
    expect(inputs[0]).toContain("PERSONA_AND_FOOTER");
    if (scenario !== "none") expect(inputs[1]).toContain("PERSONA_AND_FOOTER");
    expect(inputs.at(-1)).toBe("third");
  } finally {
    supervisor.stopAll();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
