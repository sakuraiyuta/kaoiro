import "../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeLauncher } from "../src/spawn.js";
import { Supervisor } from "../src/supervisor.js";

let settingsRoot: string;
beforeEach(() => {
  settingsRoot = mkdtempSync(join(tmpdir(), "muse-runner-settings-"));
  vi.stubEnv("HOME", settingsRoot);
  vi.stubEnv("XDG_CONFIG_HOME", join(settingsRoot, "config"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(settingsRoot, { recursive: true, force: true });
});

function expectPersonaArgs(args: string[], persona: string) {
  const index = args.indexOf("-c");
  expect(index).toBeGreaterThanOrEqual(0);
  expect(args[index + 1]).toBe(`run.system_prompt_append=${JSON.stringify(persona)}`);
  expect(args).not.toContain("--trust-workspace");
}

it.each([
  ["spawn", "low", 1], ["spawn", undefined, 0],
  ["resume", "low", 0], ["resume", undefined, 0],
  ["fresh-restore", "low", 0],
])("starts %s with effort %s and %i warning", async (operation, effort, warnings) => {
  expect(process.env.HOME).toBe(settingsRoot);
  expect(process.env.XDG_CONFIG_HOME).toBe(join(settingsRoot, "config"));
  const root = mkdtempSync(join(tmpdir(), "muse-spawn-effort-"));
  const ready = join(root, "ready");
  const result = join(root, "resumed.json");
  const launch = join(root, "native-launch.json");
  const methods = join(root, "native-methods");
  vi.stubEnv("KAOIRO_TEST_LAUNCH_FILE", launch);
  vi.stubEnv("KAOIRO_TEST_ACP_METHODS_FILE", methods);
  vi.stubEnv("MUSE_RECOVERY_RESULT", result);
  vi.stubEnv("MUSE_SWITCH_READY", ready);
  vi.stubEnv("MUSE_HOST_SCENARIO", "switch-effort");
  vi.stubEnv("MUSE_HOST_FAKE", fileURLToPath(
    new URL("../../wrapper/muse/test/fixtures/muse.mjs", import.meta.url)));
  const driver = fileURLToPath(
    new URL("./fixtures/muse-recovery-host-driver.mjs", import.meta.url));
  const results: unknown[] = [];
  const supervisor = new Supervisor({ hostId: "fixture", cwdAllowlist: [root],
    wrapperServerUrl: "ws://fixture/wrapper", launch: makeLauncher([process.execPath, driver]),
    getMuseCatalog: () => [{
      value: "muse-spark-1.2", display_name: "Spark", effort_levels: ["low"],
    }],
    sendResult: (value) => results.push(value), sendSessions() {},
    sendResetResult() {}, sendStopAgent() {}, listSessions: () => [], sessionExists: () => true });
  try {
    supervisor.handleSpawn({ version: "0", agent_id: "fixture.muse", cwd: root,
      persona: { id: "p", name: "P", sprite_set: "p" }, engine: "muse",
      model: "muse-spark-1.2",
      ...(operation === "resume" ? { resume_session_id: "fixture-session" } : {}),
      ...(operation === "fresh-restore" ? { apply_resume_snapshot: true } : {}),
      ...(operation !== "spawn" ? { resume_snapshot: {
        model: "muse-spark-1.2", model_source: "launch",
        ...(effort ? { effort, effort_source: "launch" } : {}),
      } } : (effort ? { effort } : {})) });
    const output = operation === "resume" ? result : ready;
    await vi.waitFor(() => expect(existsSync(output)).toBe(true), { timeout: 10_000 });
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ warnings });
    expect(results).toContainEqual(expect.objectContaining({ ok: true }));
    const args = JSON.parse(readFileSync(launch, "utf8")).args as string[];
    expectPersonaArgs(args, "persona");
    const explicitEffort = operation === "spawn" && effort;
    const expected = ["acp", "-c", 'run.system_prompt_append="persona"',
      "--model", "muse-spark-1.2"];
    if (explicitEffort) {
      expected.push("-c", 'model_reasoning_efforts={"muse-spark-1.2":"low"}');
    }
    expect(args).toEqual(expected);
    const calls = readFileSync(methods, "utf8").split("\n");
    expect(calls).toContain(operation === "resume" ? "session/resume" : "session/new");
    expect(calls).not.toContain("session/set_config_option");
  } finally {
    supervisor.stopAll();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it.each([" ", "x".repeat(257)])(
  "switches to a session with ignored effort %j", async (effort) => {
    const root = mkdtempSync(join(tmpdir(), "muse-switch-effort-"));
    const ready = join(root, "ready");
    const result = join(root, "resumed.json");
    const launch = join(root, "native-launch.json");
    const methods = join(root, "native-methods");
    vi.stubEnv("KAOIRO_TEST_LAUNCH_FILE", launch);
    vi.stubEnv("KAOIRO_TEST_ACP_METHODS_FILE", methods);
    vi.stubEnv("MUSE_RECOVERY_RESULT", result);
    vi.stubEnv("MUSE_SWITCH_READY", ready);
    vi.stubEnv("MUSE_HOST_SCENARIO", "switch-effort");
    vi.stubEnv("MUSE_HOST_FAKE", fileURLToPath(
      new URL("../../wrapper/muse/test/fixtures/muse.mjs", import.meta.url)));
    const driver = fileURLToPath(
      new URL("./fixtures/muse-recovery-host-driver.mjs", import.meta.url));
    const results: unknown[] = [];
    const supervisor = new Supervisor({ hostId: "fixture", cwdAllowlist: [root],
      wrapperServerUrl: "ws://fixture/wrapper", launch: makeLauncher([process.execPath, driver]),
      sendResult: (value) => results.push(value), sendSessions() {},
      sendResetResult() {}, sendStopAgent() {}, listSessions: () => [], sessionExists: () => true });
    try {
      supervisor.handleSpawn({ version: "0", agent_id: "fixture.muse",
        persona: { id: "p", name: "P", sprite_set: "p" }, cwd: root, engine: "muse" });
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });
      supervisor.handleSwitchSession({ agent_id: "fixture.muse",
        resume_session_id: "fixture-session", request_id: "switch-effort",
        resume_snapshot: { effort, effort_source: "config" } });
      await vi.waitFor(() => expect(existsSync(result)).toBe(true), { timeout: 10_000 });
      expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({
        resume: "fixture-session", warnings: 0, mode: { id: "promptUnmatched" },
      });
      expect(results).not.toContainEqual(expect.objectContaining({ ok: false }));
      expectPersonaArgs(JSON.parse(readFileSync(launch, "utf8")).args, "persona");
      const calls = readFileSync(methods, "utf8").split("\n");
      expect(calls).toContain("session/new");
      expect(calls).toContain("session/resume");
      expect(calls).not.toContain("session/set_config_option");
    } finally {
      supervisor.stopAll();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000,
);

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
  "recovers native persona through runner after %s", async (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-muse-persona-recovery-"));
  const result = join(root, "resumed.json");
  const prompts = join(root, "prompts.jsonl");
  const launch = join(root, "launch.json");
  vi.stubEnv("MUSE_RECOVERY_RESULT", result);
  vi.stubEnv("KAOIRO_TEST_LAUNCH_FILE", launch);
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
      resume: "fixture-session", delivered: false,
      checkpoint: expect.objectContaining({ state: "live",
        session_id: "fixture-session", muse_persona_delivered: false }),
    });
    const inputs = readFileSync(prompts, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as string);
    expect(inputs).toEqual(["first", "second"]);
    expectPersonaArgs(JSON.parse(readFileSync(launch, "utf8")).args,
      "PERSONA_AND_FOOTER");
  } finally {
    supervisor.stopAll();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
