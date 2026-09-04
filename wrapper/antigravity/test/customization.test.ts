import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CUSTOMIZATION_OWNER_NAMESPACE, sweepStaleCustomizationDirs } from "../src/customization.js";

describe("sweepStaleCustomizationDirs", () => {
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
