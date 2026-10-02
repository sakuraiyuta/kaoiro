import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CUSTOMIZATION_OWNER_NAMESPACE,
  CustomizationDir,
  processIsAlive,
  sweepStaleCustomizationDirs,
} from "../src/customization.js";

describe("sweepStaleCustomizationDirs in isolated scratch (M4)", () => {
  it("preserves active process dir and cleans up stale dead-PID dir", () => {
    const scratch = mkdtempSync(join(tmpdir(), "sweep-scratch-"));

    try {
      // 1. Create a real CustomizationDir owned by current live process
      const liveDir = CustomizationDir.create({
        cwd: process.cwd(),
        personaPrompt: "persona",
        nodePath: process.execPath,
        hookPath: "/fake/hook.js",
        bridgePath: "/fake/bridge.js",
        baseDir: scratch,
      });

      expect(existsSync(liveDir.path)).toBe(true);

      // 2. Find a confirmed dead PID
      let deadPid = 4_000_000;
      while (deadPid > 100_000) {
        try {
          process.kill(deadPid, 0);
          deadPid--;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          deadPid--;
        }
      }

      // 3. Create a simulated stale directory owned by dead PID
      const staleDir = join(scratch, "kaoiro-agy-stale");
      mkdirSync(staleDir, { mode: 0o700 });
      writeFileSync(
        join(staleDir, ".kaoiro-owner.json"),
        JSON.stringify({
          namespace: CUSTOMIZATION_OWNER_NAMESPACE,
          uid: process.getuid?.(),
          pid: deadPid,
        }),
      );

      // 4. Run sweep under production default (no mock)
      sweepStaleCustomizationDirs({ baseDir: scratch });

      // Live directory must be preserved
      expect(existsSync(liveDir.path)).toBe(true);
      // Stale directory must be deleted
      expect(existsSync(staleDir)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  describe("fail-closed boundaries (S1)", () => {
    it("never deletes directory when PID <= 1", () => {
      const scratch = mkdtempSync(join(tmpdir(), "sweep-scratch-failclosed-"));
      try {
        const dir1 = join(scratch, "kaoiro-agy-pid1");
        mkdirSync(dir1, { mode: 0o700 });
        writeFileSync(
          join(dir1, ".kaoiro-owner.json"),
          JSON.stringify({
            namespace: CUSTOMIZATION_OWNER_NAMESPACE,
            uid: process.getuid?.(),
            pid: 1,
          }),
        );

        const dir0 = join(scratch, "kaoiro-agy-pid0");
        mkdirSync(dir0, { mode: 0o700 });
        writeFileSync(
          join(dir0, ".kaoiro-owner.json"),
          JSON.stringify({
            namespace: CUSTOMIZATION_OWNER_NAMESPACE,
            uid: process.getuid?.(),
            pid: 0,
          }),
        );

        sweepStaleCustomizationDirs({ baseDir: scratch });

        expect(existsSync(dir1)).toBe(true);
        expect(existsSync(dir0)).toBe(true);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it("processIsAlive fails closed for pid <= 1 even if killFn reports ESRCH", () => {
      const throwingKill = () => {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      };
      expect(processIsAlive(1, throwingKill)).toBe(true);
      expect(processIsAlive(0, throwingKill)).toBe(true);
      expect(processIsAlive(-1, throwingKill)).toBe(true);
      expect(processIsAlive(12345, throwingKill)).toBe(false);
    });

    it("never deletes directory when UID does not match", () => {
      const scratch = mkdtempSync(join(tmpdir(), "sweep-scratch-uid-"));
      try {
        const foreignDir = join(scratch, "kaoiro-agy-foreign");
        mkdirSync(foreignDir, { mode: 0o700 });
        writeFileSync(
          join(foreignDir, ".kaoiro-owner.json"),
          JSON.stringify({
            namespace: CUSTOMIZATION_OWNER_NAMESPACE,
            uid: (process.getuid?.() ?? 1000) + 9999,
            pid: 4_000_000,
          }),
        );

        sweepStaleCustomizationDirs({ baseDir: scratch });

        expect(existsSync(foreignDir)).toBe(true);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it("never deletes directory when kill check returns non-ESRCH error (e.g. EPERM)", () => {
      const scratch = mkdtempSync(join(tmpdir(), "sweep-scratch-eperm-"));
      try {
        const epermDir = join(scratch, "kaoiro-agy-eperm");
        mkdirSync(epermDir, { mode: 0o700 });
        writeFileSync(
          join(epermDir, ".kaoiro-owner.json"),
          JSON.stringify({
            namespace: CUSTOMIZATION_OWNER_NAMESPACE,
            uid: process.getuid?.(),
            pid: 12345,
          }),
        );

        sweepStaleCustomizationDirs({
          baseDir: scratch,
          isProcessAlive: () => true, // simulates EPERM fail-closed
        });

        expect(existsSync(epermDir)).toBe(true);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  });
});
