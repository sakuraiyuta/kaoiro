import "../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeLauncher, resolveWrapperLaunch, toManagedChild } from "../src/spawn.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

describe("resolveWrapperLaunch", () => {
  afterEach(() => {
    delete process.env.KAOIRO_WRAPPER_DEV;
  });

  it("prod は dist の cli を 1 つ返す", () => {
    delete process.env.KAOIRO_WRAPPER_DEV;
    const prefix = resolveWrapperLaunch();
    expect(prefix).toHaveLength(1);
    expect(prefix[0]).toMatch(/claude-code\/dist\/cli\.js$/);
  });

  it("engine=codex は @kaoiro/codex の dist を返す", () => {
    delete process.env.KAOIRO_WRAPPER_DEV;
    const prefix = resolveWrapperLaunch("codex");
    expect(prefix).toHaveLength(1);
    expect(prefix[0]).toMatch(/codex\/dist\/cli\.js$/);
  });

  it("KAOIRO_WRAPPER_DEV で tsx watch + src を返す(ホットリロード)", () => {
    process.env.KAOIRO_WRAPPER_DEV = "1";
    const prefix = resolveWrapperLaunch();
    expect(prefix).toHaveLength(3);
    expect(prefix[0]).toMatch(/tsx/);
    expect(prefix[1]).toBe("watch");
    expect(prefix[2]).toMatch(/claude-code\/src\/cli\.ts$/);
  });
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

it("the default launcher isolates every built wrapper before its first action", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "fuji464-runner-"));
  const previous = { CODEX_HOME: process.env.CODEX_HOME, NODE_OPTIONS: process.env.NODE_OPTIONS,
    FUJI464_CAPTURE: process.env.FUJI464_CAPTURE };
  const capture = join(scratch, "capture.cjs");
  writeFileSync(capture, `const fs = require('node:fs');
const path = require('node:path');
const configPath = process.argv[2];
fs.writeFileSync(path.join(process.env.FUJI464_CAPTURE, path.basename(configPath) + '.result'),
  JSON.stringify({ home: process.env.CODEX_HOME ?? null, config: JSON.parse(fs.readFileSync(configPath, 'utf8')) }));
process.exit(0);`);
  try {
    process.env.CODEX_HOME = join(scratch, "state");
    process.env.NODE_OPTIONS = `--require=${capture}`;
    process.env.FUJI464_CAPTURE = scratch;
    const launch = makeLauncher();
    for (const engine of ["codex", "claude-code", "antigravity", "grok"] as const) {
      const id = `fuji464-${engine}`;
      await new Promise<void>((resolve, reject) => {
        const child = launch(id, { agent_id: id, codex_tool_home: process.env.CODEX_HOME } as never, scratch, undefined, undefined, engine);
        child.on("exit", resolve);
        setTimeout(() => reject(new Error(`${engine} did not exit`)), 10_000).unref();
      });
      const resultFile = join(scratch, `${id}-${["codex", "claude-code", "antigravity", "grok"].indexOf(engine)}.json.result`);
      const result = JSON.parse(readFileSync(resultFile, "utf8")) as { home: string | null; config: { codex_tool_home?: string } };
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
fs.writeFileSync(path.join(process.env.AO563_CAPTURE, path.basename(process.argv[2]) + '.env'), JSON.stringify(seen));
process.exit(0);`);
  try {
    for (const name of names) process.env[name] = name.endsWith("PERSONAS") ? "P" : "1";
    process.env.NODE_OPTIONS = `--require=${capture}`;
    process.env.AO563_CAPTURE = scratch;
    const launch = makeLauncher();
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
    child = makeLauncher()("recovery-launch", {
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
    child = makeLauncher()("native-exit-control", {
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
    expect(child.exitCode).toBe(1); expect(child.signal).toBeNull();
    expect(child.recovery).toEqual({ ok: true, record: { version: 1, state: "unbound" } });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (!exited) child?.kill("SIGKILL");
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
    await wire.close(); rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
