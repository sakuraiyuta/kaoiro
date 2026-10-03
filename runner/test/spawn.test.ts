import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeLauncher, resolveWrapperLaunch, toManagedChild } from "../src/spawn.js";

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
  readonly #exit: Array<(code: number | null) => void> = [];
  readonly #error: Array<() => void> = [];
  kills = 0;
  on(event: "exit" | "error", listener: (code: number | null) => void): void {
    (event === "exit" ? this.#exit : this.#error).push(listener);
  }
  kill(): boolean {
    this.kills += 1;
    return true;
  }
  emitExit(code: number | null = 0): void {
    for (const listener of [...this.#exit]) listener(code);
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

  it("passes the exit code through, and null for a spawn error", () => {
    const exited = new FakeChild();
    const codes: Array<number | null | undefined> = [];
    toManagedChild(exited).on("exit", (code) => codes.push(code));
    exited.emitExit(78);
    const failed = new FakeChild();
    toManagedChild(failed).on("exit", (code) => codes.push(code));
    failed.emitError();
    expect(codes).toEqual([78, null]);
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
    for (const engine of ["codex", "claude-code", "antigravity"] as const) {
      const id = `fuji464-${engine}`;
      await new Promise<void>((resolve, reject) => {
        const child = launch(id, { agent_id: id, codex_tool_home: process.env.CODEX_HOME } as never, scratch, undefined, undefined, engine);
        child.on("exit", () => resolve());
        setTimeout(() => reject(new Error(`${engine} did not exit`)), 10_000).unref();
      });
      const resultFile = join(scratch, `${id}-${["codex", "claude-code", "antigravity"].indexOf(engine)}.json.result`);
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
