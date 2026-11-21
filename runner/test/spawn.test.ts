import "../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { makeLauncher, toManagedChild } from "../src/spawn.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";
import * as engines from "../src/engines.js";
import { engineArtifact } from "../src/engines.js";

// The built entry, started by this test's own node: the command a runner
// started through `kaoiro runner` hands to its launcher.
const ENTRY = [process.execPath, fileURLToPath(new URL("../dist/kaoiro.js", import.meta.url))];

it("checks the prefix at creation and the engine before launch", () => {
  expect(() => makeLauncher([])).toThrow("makeLauncher: empty command");
  const launch = makeLauncher([""]);
  const config = { agent_id: "invalid" } as never;
  for (const id of ["unknown", "toString"]) {
    expect(() => launch("invalid", config, tmpdir(), undefined, undefined,
      id as never)).toThrow("Unknown bundled engine");
  }
  expect(() => launch("invalid", config, tmpdir(), undefined, undefined,
    "grok")).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
});

it.each(["claude-code", "codex", "antigravity", "grok"] as const)(
  "spawns the resolved command for %s", async engine => {
    const cwd = mkdtempSync(join(tmpdir(), "kaoiro launch "));
    const entry = join(cwd, "capture.cjs");
    const record = join(cwd, "observed.json");
    const capture = `
const fs = require("node:fs");
fs.writeFileSync("observed.json", JSON.stringify({
  executable: process.execPath, options: process.execArgv, argv: process.argv,
}));
`;
    const options = ["--no-warnings", "--trace-deprecation"];
    const prefix = [process.execPath, ...options, entry, ""];
    const config = { agent_id: "observe" } as never;
    const run = async (launch: ReturnType<typeof makeLauncher>) => {
      const child = launch("observe", config, cwd, undefined, undefined, engine);
      await new Promise<void>(resolve => child.on("exit", resolve));
      expect(child.exitCode).toBe(0);
      const seen = JSON.parse(readFileSync(record, "utf8"));
      rmSync(record);
      return seen;
    };
    try {
      writeFileSync(entry, capture);
      const launch = makeLauncher(prefix);
      prefix.length = 0;
      const file = expect.stringMatching(/observe-0\.json$/);
      expect(await run(launch)).toEqual({
        executable: process.execPath, options,
        argv: [process.execPath, entry, "", "wrapper", engine, "run", file],
      });

      // A distinct command proves the launcher consumes the resolver result.
      const original = engines.resolveBundledLaunch;
      const spy = vi.spyOn(engines, "resolveBundledLaunch")
        .mockImplementation((id, fixed) => {
          const { command } = original(id, fixed);
          return { command: [...command, "marker"] };
        });
      try {
        writeFileSync(join(cwd, "wrapper"), capture);
        expect(await run(makeLauncher([process.execPath]))).toEqual({
          executable: process.execPath, options: [],
          argv: [process.execPath, join(cwd, "wrapper"), engine, "marker",
            "run", file],
        });
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

it("uses a newly acquired matching engine on the next spawn", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kaoiro-store-spawn-"));
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS,
    KAOIRO_ENGINE_STORE_DIR: process.env.KAOIRO_ENGINE_STORE_DIR,
    KAOIRO_LAUNCH_CAPTURE: process.env.KAOIRO_LAUNCH_CAPTURE };
  const capture = join(scratch, "capture.cjs");
  writeFileSync(capture, `const fs = require('node:fs');
const path = require('node:path');
const file = process.argv.at(-1);
fs.writeFileSync(path.join(process.env.KAOIRO_LAUNCH_CAPTURE, path.basename(file) + '.result'),
  fs.readFileSync(file));
process.exit(0);`);
  try {
    process.env.NODE_OPTIONS = `--require=${capture}`;
    process.env.KAOIRO_LAUNCH_CAPTURE = scratch;
    process.env.KAOIRO_ENGINE_STORE_DIR = join(scratch, "engines");
    const artifact = engineArtifact("claude-code")!;
    const store = join(scratch, "engines", `${artifact.name.split("/")[1]}@${artifact.version}`);
    const launch = makeLauncher(ENTRY);
    const run = async () => new Promise<void>((resolve, reject) => {
      launch("agent", { agent_id: "agent" } as never, scratch).on("exit", resolve);
      setTimeout(() => reject(new Error("wrapper did not exit")), 10_000).unref();
    });
    await run();
    mkdirSync(store, { recursive: true });
    await run();
    writeFileSync(join(store, "claude"), "engine");
    await run();
    const first = JSON.parse(readFileSync(join(scratch, "agent-0.json.result"), "utf8"));
    const second = JSON.parse(readFileSync(join(scratch, "agent-1.json.result"), "utf8"));
    const third = JSON.parse(readFileSync(join(scratch, "agent-2.json.result"), "utf8"));
    expect(first.engine_executable).toBeUndefined();
    expect(second.engine_executable).toBeUndefined();
    expect(third.engine_executable).toBe(join(store, "claude"));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("the launcher starts `wrapper <engine> run <launch file>` and keeps the prompt and the resume target in the file", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kaoiro-launch-argv-"));
  const previous = { NODE_OPTIONS: process.env.NODE_OPTIONS, KAOIRO_LAUNCH_CAPTURE: process.env.KAOIRO_LAUNCH_CAPTURE };
  const capture = join(scratch, "capture.cjs");
  writeFileSync(capture, `const fs = require('node:fs');
const path = require('node:path');
const file = process.argv.at(-1);
fs.writeFileSync(path.join(process.env.KAOIRO_LAUNCH_CAPTURE, path.basename(file) + '.result'),
  JSON.stringify({ argv: process.argv.slice(2), mode: fs.statSync(file).mode & 0o777, config: JSON.parse(fs.readFileSync(file, 'utf8')) }));
process.exit(0);`);
  try {
    process.env.NODE_OPTIONS = `--require=${capture}`;
    process.env.KAOIRO_LAUNCH_CAPTURE = scratch;
    const launch = makeLauncher(ENTRY);
    const config = { agent_id: "argv", initial_prompt: "stale prompt", resume_session_id: "stale-session" } as never;
    const started = async (resume?: string, prompt?: string): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        launch("argv", config, scratch, resume, prompt, "grok").on("exit", resolve);
        setTimeout(() => reject(new Error("the wrapper did not exit")), 10_000).unref();
      });
    };
    await started("session-1", "first instruction");
    await started();
    const read = (n: number) => JSON.parse(readFileSync(join(scratch, `argv-${n}.json.result`), "utf8")) as {
      argv: string[]; mode: number; config: { initial_prompt?: string; resume_session_id?: string };
    };
    const first = read(0), relaunch = read(1);
    expect(first.argv).toEqual(["wrapper", "grok", "run", expect.stringMatching(/argv-0\.json$/)]);
    expect(first.mode).toBe(0o600);
    expect(first.config).toMatchObject({ initial_prompt: "first instruction", resume_session_id: "session-1" });
    expect(relaunch.argv).toEqual(["wrapper", "grok", "run", expect.stringMatching(/argv-1\.json$/)]);
    expect(relaunch.config).not.toHaveProperty("initial_prompt");
    expect(relaunch.config).not.toHaveProperty("resume_session_id");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** A child stub that can emit `exit` and `error` separately. */
class FakeChild {
  readonly #exit: Array<() => void> = [];
  readonly #error: Array<() => void> = [];
  kills = 0;
  on(event: "exit" | "error", listener: () => void): void {
    (event === "exit" ? this.#exit : this.#error).push(listener);
  }
  kill(): boolean {
    this.kills += 1;
    return true;
  }
  emitExit(): void {
    for (const listener of [...this.#exit]) listener();
  }
  emitError(): void {
    for (const listener of [...this.#error]) listener();
  }
}

describe("toManagedChild", () => {
  it("exit で 1 回発火する", () => {
    const child = new FakeChild();
    let n = 0;
    toManagedChild(child).on("exit", () => (n += 1));
    child.emitExit();
    expect(n).toBe(1);
  });

  it("error でも発火する(spawn 失敗を取りこぼさない)", () => {
    const child = new FakeChild();
    let n = 0;
    toManagedChild(child).on("exit", () => (n += 1));
    child.emitError();
    expect(n).toBe(1);
  });

  it("error と exit が両方来ても 1 回だけ発火する", () => {
    const child = new FakeChild();
    let n = 0;
    toManagedChild(child).on("exit", () => (n += 1));
    child.emitError();
    child.emitExit();
    expect(n).toBe(1);
  });

  it("kill を委譲する", () => {
    const child = new FakeChild();
    toManagedChild(child).kill();
    expect(child.kills).toBe(1);
  });
});

it("the launcher isolates bundled and configured commands before their first action", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "fuji464-runner-"));
  const previous = { CODEX_HOME: process.env.CODEX_HOME, NODE_OPTIONS: process.env.NODE_OPTIONS,
    FUJI464_CAPTURE: process.env.FUJI464_CAPTURE };
  const capture = join(scratch, "capture.cjs");
  writeFileSync(capture, `const fs = require('node:fs');
const path = require('node:path');
const configPath = process.argv.at(-1);
fs.writeFileSync(path.join(process.env.FUJI464_CAPTURE, path.basename(configPath) + '.result'),
  JSON.stringify({ argv: process.argv.slice(1, -1), mode: fs.statSync(configPath).mode & 0o777,
    home: process.env.CODEX_HOME ?? null, config: JSON.parse(fs.readFileSync(configPath, 'utf8')) }));
process.exit(0);`);
  try {
    process.env.CODEX_HOME = join(scratch, "state");
    process.env.NODE_OPTIONS = `--require=${capture}`;
    process.env.FUJI464_CAPTURE = scratch;
    const launch = makeLauncher(ENTRY, id => id === "sample"
      ? [process.execPath, capture, "fixed arg", ""] : undefined);
    const engines = ["codex", "claude-code", "antigravity", "grok", "sample"];
    for (const [index, engine] of engines.entries()) {
      const id = `fuji464-${engine}`;
      await new Promise<void>((resolve, reject) => {
        const child = launch(id, { agent_id: id, codex_tool_home: process.env.CODEX_HOME } as never, scratch, undefined, undefined, engine);
        child.on("exit", resolve);
        setTimeout(() => reject(new Error(`${engine} did not exit`)), 10_000).unref();
      });
      const resultFile = join(scratch, `${id}-${index}.json.result`);
      const result = JSON.parse(readFileSync(resultFile, "utf8")) as { argv: string[]; mode: number; home: string | null; config: { codex_tool_home?: string } };
      if (engine === "sample") {
        expect(result.argv).toEqual([capture, "fixed arg", "", "run"]);
        expect(result.mode).toBe(0o600);
        expect(Object.keys(result.config).sort()).toEqual(["agent_id", "recovery_checkpoint_path"]);
      }
      if (engine === "codex") {
        expect(result.home).toBe(process.env.CODEX_HOME);
        expect(result.config.codex_tool_home).not.toBe(result.home);
        expect(result.config.codex_tool_home).toContain("codex-tool-");
        expect(existsSync(result.config.codex_tool_home!)).toBe(false);
      } else {
        expect(result.home).toBeNull();
        expect(result.config.codex_tool_home).toBeUndefined();
      }
    }
    expect(statSync(scratch).isDirectory()).toBe(true);
  } finally {
    if (previous.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.CODEX_HOME;
    if (previous.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous.NODE_OPTIONS;
    if (previous.FUJI464_CAPTURE === undefined) delete process.env.FUJI464_CAPTURE;
    else process.env.FUJI464_CAPTURE = previous.FUJI464_CAPTURE;
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("the default launcher inherits inert old variables and preserves approval inputs", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ao563-runner-env-"));
  const names = ["KAOIRO_CODEX_OPERATOR_STEER", "KAOIRO_CODEX_OPERATOR_STEER_PERSONAS", "KAOIRO_CLAUDE_PHASE2_DELIVERY",
    "KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS", "KAOIRO_CODEX_APPROVAL_AXIS", "KAOIRO_CODEX_APPROVAL_AXIS_PERSONAS"] as const;
  const keep = ["NODE_OPTIONS", "AO563_CAPTURE", ...names].map(name => [name, process.env[name]] as const);
  const capture = join(scratch, "capture.cjs");
  writeFileSync(capture, `const fs = require('node:fs');
const path = require('node:path');
const seen = {};
for (const [key, value] of Object.entries(process.env)) if (key.startsWith('KAOIRO_')) seen[key] = value;
fs.writeFileSync(path.join(process.env.AO563_CAPTURE, path.basename(process.argv.at(-1)) + '.env'), JSON.stringify(seen));
process.exit(0);`);
  try {
    for (const name of names) process.env[name] = name.endsWith("PERSONAS") ? "P" : "1";
    process.env.NODE_OPTIONS = `--require=${capture}`;
    process.env.AO563_CAPTURE = scratch;
    const launch = makeLauncher(ENTRY);
    for (const engine of ["codex", "claude-code"] as const) {
      const id = `ao563-${engine}`;
      await new Promise<void>((resolve, reject) => {
        const child = launch(id, { agent_id: id } as never, scratch, undefined, undefined, engine);
        child.on("exit", resolve);
        setTimeout(() => reject(new Error(`${engine} did not exit`)), 10_000).unref();
      });
      const dump = join(scratch, `${id}-${engine === "codex" ? 0 : 1}.json.env`);
      const child = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
      for (const name of names) expect(child[name], `${engine} ${name}`).toBe(name.endsWith("PERSONAS") ? "P" : "1");
    }
    expect(process.env.KAOIRO_CODEX_OPERATOR_STEER).toBe("1");
    expect(process.env.KAOIRO_CODEX_OPERATOR_STEER_PERSONAS).toBe("P");
  } finally {
    for (const [name, value] of keep) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

it.each((["claude-code", "codex", "grok", "antigravity"] as const).flatMap(engine => [false, true].map(stalled => ({ engine, stalled }))))("collects stale initial from actual dist checkpoint failure ($engine, stalled=$stalled)", async ({ engine, stalled }) => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-recovery-launch-"));
  const preload = join(root, "fail-checkpoint.cjs");
  const nativeAttempts = join(root, "native-attempts");
  const previous = process.env.NODE_OPTIONS;
  writeFileSync(preload, `const fs = require('node:fs');
const original = fs.writeFileSync;
fs.writeFileSync = function(path, data, ...args) {
  if (String(path).endsWith('.recovery.tmp') && JSON.parse(String(data)).state === 'unbound') throw new Error('owned checkpoint write fault');
  return original.call(this, path, data, ...args);
};
const cp = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const originalCall = cp[name];
  cp[name] = function(...args) { fs.appendFileSync(${JSON.stringify(nativeAttempts)}, name + '\\n'); return originalCall.apply(this, args); };
}
require('node:module').syncBuiltinESMExports();
${stalled ? 'setInterval(() => {}, 1000);' : ''}`);
  let child: ReturnType<ReturnType<typeof makeLauncher>> | undefined;
  let exited = false;
  try {
    process.env.NODE_OPTIONS = `${previous ?? ""} --require=${preload}`;
    const started = performance.now();
    child = makeLauncher(ENTRY)("recovery-launch", {
      agent_id: "recovery-launch", persona: { id: "p", name: "P", sprite_set: "p" },
      display_name: "P", server_url: "ws://127.0.0.1:1/wrapper",
    }, root, undefined, undefined, engine);
    await new Promise<void>((resolve, reject) => {
      child!.on("exit", () => { exited = true; resolve(); });
      setTimeout(() => reject(new Error("recovery dist wrapper did not exit")), 15_000).unref();
    });
    if (!stalled) expect(performance.now() - started).toBeLessThan(8_000);
    expect(child.exitCode).toBe(79);
    expect(existsSync(nativeAttempts)).toBe(false);
    expect(child.recovery).toEqual({ ok: true, record: { version: 1, state: "initial" } });
    expect(child.readRecovery?.()).toEqual({ ok: false, reason: "unreadable" });
  } finally {
    if (!exited) child?.kill("SIGKILL");
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);


it("keeps native app-server exit 79 distinct from supervised wrapper exit 79", async () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-native-exit-control-"));
  const preload = join(root, "native-exit.cjs"), marker = join(root, "native-exits");
  const previous = process.env.NODE_OPTIONS;
  const wire = await phoenixLoopback(() => ({}));
  writeFileSync(preload, `const cp = require('node:child_process'), fs = require('node:fs');
const original = cp.spawn;
cp.spawn = function(command, args, options) {
  if (Array.isArray(args) && args.includes('app-server')) {
    const child = original.call(this, process.execPath, ['-e', 'process.exit(79)'], options);
    child.on('exit', code => fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(code) + '\\n'));
    return child;
  }
  return original.apply(this, arguments);
};
require('node:module').syncBuiltinESMExports();`);
  let child: ReturnType<ReturnType<typeof makeLauncher>> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let exited = false;
  try {
    process.env.NODE_OPTIONS = `${previous ?? ""} --require=${preload}`;
    child = makeLauncher(ENTRY)("native-exit-control", {
      agent_id: "native-exit-control", persona: { id: "p", name: "P", sprite_set: "p" },
      display_name: "P", server_url: wire.url, sandbox: "workspace-write", network_access: false,
    }, root, undefined, "owned process control", "codex");
    const finished = new Promise<void>((resolve, reject) => {
      child!.on("exit", () => { exited = true; resolve(); });
      timeout = setTimeout(() => reject(new Error("native-exit wrapper did not finish")), 15_000);
    });
    await vi.waitFor(() => expect(wire.joins).toBe(1));
    wire.push("persona_prompt", { prompt: "Fixture" });
    await finished;
    const nativeCodes = readFileSync(marker, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(nativeCodes.length).toBeGreaterThan(0); expect(nativeCodes.every(code => code === 79)).toBe(true);
    expect(child.exitCode).toBe(0); expect(child.signal).toBeNull();
    expect(child.recovery).toEqual({ ok: true, record: { version: 1, state: "unbound" } });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (!exited) child?.kill("SIGKILL");
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
    await wire.close(); rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
