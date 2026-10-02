import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FORBIDDEN_PROCESS_KILL_PATTERN =
  /(\bprocess\.kill\s*=(?!=)|spyOn\(\s*process\s*,\s*["']kill["']|Object\.defineProperty\(\s*process\s*,\s*["']kill["'])/;

describe("no_process_kill_mock_gate", () => {
  it("ensures no test file attempts to mock, spy on, or redefine process.kill", () => {
    const testDir = new URL(".", import.meta.url).pathname;
    const entries = readdirSync(testDir, { withFileTypes: true });

    const violations: { file: string; line: number; match: string }[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js"))) {
        continue;
      }
      // setup_tmpdir.ts is the intentional lockdown barrier, and this gate itself inspects patterns
      if (entry.name === "setup_tmpdir.ts" || entry.name === "no_process_kill_mock_gate.test.ts") {
        continue;
      }

      const content = readFileSync(join(testDir, entry.name), "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Skip comment lines
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (FORBIDDEN_PROCESS_KILL_PATTERN.test(line)) {
          violations.push({
            file: entry.name,
            line: i + 1,
            match: line.trim(),
          });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  describe("negative controls", () => {
    it("detects vi.spyOn(process, 'kill')", () => {
      const code = 'const spy = vi.spyOn(process, "kill");';
      expect(FORBIDDEN_PROCESS_KILL_PATTERN.test(code)).toBe(true);
    });

    it("detects process.kill assignment", () => {
      const code = "process.kill = () => {};";
      expect(FORBIDDEN_PROCESS_KILL_PATTERN.test(code)).toBe(true);
    });

    it("detects Object.defineProperty on process kill", () => {
      const code = 'Object.defineProperty(process, "kill", { value: fn });';
      expect(FORBIDDEN_PROCESS_KILL_PATTERN.test(code)).toBe(true);
    });

    it("allows harmless code and unrelated spies", () => {
      expect(FORBIDDEN_PROCESS_KILL_PATTERN.test('vi.spyOn(process.stderr, "write")')).toBe(false);
      expect(FORBIDDEN_PROCESS_KILL_PATTERN.test('child.kill("SIGTERM")')).toBe(false);
      expect(FORBIDDEN_PROCESS_KILL_PATTERN.test('executeSignalPlanWith(plan, fakeKill)')).toBe(false);
    });
  });
});
