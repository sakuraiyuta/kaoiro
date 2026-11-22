import "../../../scripts/test/fixtures/test-isolation.mjs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CUSTOMIZATION_OWNER_NAMESPACE, sweepStaleCustomizationDirs } from "../src/customization.js";

describe("sweepStaleCustomizationDirs", () => {
  it("preserves invalid owner PIDs without probing them", () => {
    const root = mkdtempSync(join(tmpdir(), "agy-sweep-invalid-"));
    const values = [0, -1, Number.MAX_SAFE_INTEGER + 1, null, "NaN", 1.5, 41, 42];
    const probed: number[] = [];
    try {
      for (const [index, pid] of values.entries()) {
        const path = join(root, `kaoiro-agy-${index}`);
        mkdirSync(path);
        writeFileSync(join(path, ".kaoiro-owner.json"), JSON.stringify({ namespace: CUSTOMIZATION_OWNER_NAMESPACE, uid: 1000, pid }));
      }
      sweepStaleCustomizationDirs({
        baseDir: root, uid: 1000,
        isProcessAlive: (pid) => { probed.push(pid); return pid === 41; },
      });
      expect(probed.sort()).toEqual([41, 42]);
      for (let index = 0; index < values.length - 1; index++) {
        expect(existsSync(join(root, `kaoiro-agy-${index}`))).toBe(true);
      }
      expect(existsSync(join(root, "kaoiro-agy-7"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("同uid・namespaceの死んだ所有者だけを削除する", () => {
    const root = mkdtempSync(join(tmpdir(), "agy-sweep-test-"));
    const owned = join(root, "kaoiro-agy-owned");
    const foreign = join(root, "kaoiro-agy-foreign");
    try {
      for (const path of [owned, foreign]) mkdirSync(join(path, ".agents"), { recursive: true });
      writeFileSync(join(owned, ".kaoiro-owner.json"), JSON.stringify({ namespace: CUSTOMIZATION_OWNER_NAMESPACE, uid: 1000, pid: 42 }));
      writeFileSync(join(foreign, ".kaoiro-owner.json"), JSON.stringify({ namespace: "other", uid: 1000, pid: 42 }));
      sweepStaleCustomizationDirs({ baseDir: root, uid: 1000, isProcessAlive: () => false });
      expect(existsSync(owned)).toBe(false);
      expect(existsSync(foreign)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("読めないsweep rootでconstructor相当の掃除を失敗にしない", () => {
    const root = mkdtempSync(join(tmpdir(), "agy-sweep-eacces-"));
    try {
      chmodSync(root, 0o000);
      expect(() => sweepStaleCustomizationDirs({ baseDir: root, uid: 1000 })).not.toThrow();
    } finally {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CustomizationDir", () => {
  const nodeArgs = ["--require", "/tmp/my 'dir'/preload.cjs"];
  const entryPath = "/opt/kaoiro 'v2' app/dist/kaoiro.js";

  it("writes exactly the managed PreToolUse and Stop hooks, quoting the command, and nothing else", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { CustomizationDir, HOOK_TIMEOUT_SECONDS, STOP_HOOK_TIMEOUT_SECONDS } = await import("../src/customization.js");
    const { antigravitySubcommandPrefix, shellSingleQuote } = await import("../src/subcommand.js");
    expect(shellSingleQuote("/plain/kaoiro.js")).toBe("'/plain/kaoiro.js'");
    expect(shellSingleQuote("/path with space/it's/kaoiro.js")).toBe("'/path with space/it'\\''s/kaoiro.js'");
    const dir = CustomizationDir.create({ nodePath: "/usr/bin/node", nodeArgs, entryPath });
    try {
      const hookCmd = antigravitySubcommandPrefix({ nodePath: "/usr/bin/node", nodeArgs, entryPath, subcommand: "hook" });
      expect(hookCmd).toBe("/usr/bin/node '--require' '/tmp/my '\\''dir'\\''/preload.cjs' '/opt/kaoiro '\\''v2'\\'' app/dist/kaoiro.js' wrapper antigravity hook");
      expect(JSON.parse(readFileSync(join(dir.path, ".agents", "hooks.json"), "utf8"))).toEqual({
        hooks: {
          PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCmd, timeout: HOOK_TIMEOUT_SECONDS }] }],
          Stop: [{ type: "command", command: hookCmd, timeout: STOP_HOOK_TIMEOUT_SECONDS }],
        },
      });
      expect(STOP_HOOK_TIMEOUT_SECONDS).toBe(30);
      expect(readdirSync(join(dir.path, ".agents"))).toEqual(["hooks.json"]);
    } finally {
      dir.close();
    }
  });

  it("verify() reports a changed hooks.json, and rewrite() restores it", async () => {
    const { CustomizationDir } = await import("../src/customization.js");
    const dir = CustomizationDir.create({ nodePath: "/usr/bin/node", entryPath: "/k.js" });
    try {
      expect(dir.verify()).toBe(true);
      writeFileSync(join(dir.path, ".agents", "hooks.json"), "{}\n");
      expect(dir.verify()).toBe(false);
      dir.rewrite();
      expect(dir.verify()).toBe(true);
      rmSync(join(dir.path, ".agents", "hooks.json"));
      expect(dir.verify()).toBe(false);
    } finally {
      dir.close();
    }
  });
});

describe("checkHookList (design 4.3 item 1, D18)", () => {
  const source = "/c/.agents/hooks.json";
  const command = "node kaoiro.js wrapper antigravity hook";
  const managed = (actions?: unknown[], extra: Record<string, unknown> = {}) => ({
    name: "hooks", enabled: true, source,
    actions: actions ?? [
      { event: "PreToolUse", matcher: "*", type: "command", command, timeout_seconds: 3600 },
      { event: "Stop", type: "command", command, timeout_seconds: 30 },
    ],
    ...extra,
  });
  const list = (...groups: unknown[]) => ({ command: { name: "hooks", data: { hooks: groups } } });

  it("accepts exactly the two managed registrations, with disabled or non-Stop groups elsewhere", async () => {
    const { checkHookList } = await import("../src/customization.js");
    expect(checkHookList(list(managed()), { source, command })).toEqual({ ok: true });
    expect(checkHookList(list(
      managed(),
      { name: "off", enabled: false, source: "/w/.agents/hooks.json", actions: [{ event: "Stop", command: "x" }] },
      { name: "pre", enabled: true, source: "/g/hooks.json", actions: [{ event: "PreToolUse", matcher: "*", command: "y" }] },
    ), { source, command })).toEqual({ ok: true });
  });

  it.each([
    ["no managed group", list()],
    ["two managed groups", list(managed(), managed())],
    ["the managed group disabled", list(managed(undefined, { enabled: false }))],
    ["Stop missing", list(managed([{ event: "PreToolUse", matcher: "*", command, timeout_seconds: 3600 }]))],
    ["PreToolUse missing", list(managed([{ event: "Stop", command, timeout_seconds: 30 }]))],
    ["a third action", list(managed([{ event: "PreToolUse", matcher: "*", command, timeout_seconds: 3600 }, { event: "Stop", command, timeout_seconds: 30 }, { event: "Stop", command, timeout_seconds: 30 }]))],
    ["two PreToolUse", list(managed([{ event: "PreToolUse", matcher: "*", command, timeout_seconds: 3600 }, { event: "PreToolUse", matcher: "*", command, timeout_seconds: 3600 }]))],
    ["another matcher", list(managed([{ event: "PreToolUse", matcher: "run_command", command, timeout_seconds: 3600 }, { event: "Stop", command, timeout_seconds: 30 }]))],
    ["another PreToolUse command", list(managed([{ event: "PreToolUse", matcher: "*", command: "other", timeout_seconds: 3600 }, { event: "Stop", command, timeout_seconds: 30 }]))],
    ["another PreToolUse timeout", list(managed([{ event: "PreToolUse", matcher: "*", command, timeout_seconds: 60 }, { event: "Stop", command, timeout_seconds: 30 }]))],
    ["another Stop command", list(managed([{ event: "PreToolUse", matcher: "*", command, timeout_seconds: 3600 }, { event: "Stop", command: "other", timeout_seconds: 30 }]))],
    ["another Stop timeout", list(managed([{ event: "PreToolUse", matcher: "*", command, timeout_seconds: 3600 }, { event: "Stop", command, timeout_seconds: 60 }]))],
    ["an action that is not an object", list(managed([{ event: "PreToolUse", matcher: "*", command, timeout_seconds: 3600 }, "Stop"]))],
  ])("refuses %s", async (_label, value) => {
    const { checkHookList } = await import("../src/customization.js");
    expect(checkHookList(value, { source, command })).toEqual({ ok: false, reason: "registration_mismatch" });
  });

  it("refuses another enabled Stop anywhere and names its file", async () => {
    const { checkHookList } = await import("../src/customization.js");
    for (const enabled of [true, undefined]) {
      expect(checkHookList(list(managed(), { name: "foreign", ...(enabled === undefined ? {} : { enabled }), source: "/w/.agents/hooks.json", actions: [{ event: "Stop", command: "x", timeout_seconds: 30 }] }), { source, command }))
        .toEqual({ ok: false, reason: "foreign_stop_hook:/w/.agents/hooks.json" });
    }
  });

  it("finds the groups wherever the list nests them", async () => {
    const { checkHookList } = await import("../src/customization.js");
    expect(checkHookList({ a: [{ b: list(managed()) }] }, { source, command })).toEqual({ ok: true });
    expect(checkHookList(null, { source, command })).toEqual({ ok: false, reason: "registration_mismatch" });
  });
});
