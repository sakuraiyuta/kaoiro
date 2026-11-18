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

describe("subcommand string generation and CustomizationDir", () => {
  it("quotes entryPath and nodeArgs unconditionally and builds all four surfaces from one prefix", async () => {
    const { readFileSync } = await import("node:fs");
    const { CustomizationDir } = await import("../src/customization.js");
    const { antigravitySubcommandPrefix, shellSingleQuote } = await import("../src/subcommand.js");

    expect(shellSingleQuote("/plain/kaoiro.js")).toBe("'/plain/kaoiro.js'");
    expect(shellSingleQuote("/path with space/it's/kaoiro.js")).toBe("'/path with space/it'\\''s/kaoiro.js'");

    const root = mkdtempSync(join(tmpdir(), "agy-custom-subcommand-"));
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    const entryPath = "/opt/kaoiro 'v2' app/dist/kaoiro.js";
    const nodeArgs = ["--require", "/tmp/my 'dir'/preload.cjs"];
    const dir = CustomizationDir.create({
      cwd,
      personaPrompt: "persona",
      nodePath: "/usr/bin/node",
      nodeArgs,
      entryPath,
    });
    try {
      const hookCmd = antigravitySubcommandPrefix({ nodePath: "/usr/bin/node", nodeArgs, entryPath, subcommand: "hook" });
      const bridgeCmd = antigravitySubcommandPrefix({ nodePath: "/usr/bin/node", nodeArgs, entryPath, subcommand: "bridge" });
      expect(hookCmd).toBe("/usr/bin/node '--require' '/tmp/my '\\''dir'\\''/preload.cjs' '/opt/kaoiro '\\''v2'\\'' app/dist/kaoiro.js' wrapper antigravity hook");
      expect(bridgeCmd).toBe("/usr/bin/node '--require' '/tmp/my '\\''dir'\\''/preload.cjs' '/opt/kaoiro '\\''v2'\\'' app/dist/kaoiro.js' wrapper antigravity bridge");

      const hooksJson = JSON.parse(readFileSync(join(dir.path, ".agents", "hooks.json"), "utf8")) as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
      };
      expect(hooksJson.hooks.PreToolUse[0]!.hooks[0]!.command).toBe(hookCmd);

      const agentsMd = readFileSync(join(dir.path, ".agents", "rules", "AGENTS.md"), "utf8");
      expect(agentsMd).toContain(`  ${bridgeCmd} list`);
      expect(agentsMd).toContain(`  ${bridgeCmd} call <tool_name> <base64url-json-object>`);
      expect(agentsMd).toContain("with Cwd set to the working directory and WaitMsBeforeAsync at least 5000.");

      const skillMd = readFileSync(join(dir.path, ".agents", "skills", "kaoiro", "SKILL.md"), "utf8");
      expect(skillMd).toContain(`- ${bridgeCmd} list`);
      expect(skillMd).toContain(`- ${bridgeCmd} call <tool_name> <base64url JSON object>`);
    } finally {
      dir.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
