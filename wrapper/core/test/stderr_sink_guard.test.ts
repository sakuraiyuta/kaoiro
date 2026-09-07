import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const SOURCE_ROOTS = [
  { packageName: "core", root: "wrapper/core/src", allowed: ["wrapper/core/src/redact.ts"] },
  { packageName: "agent-common", root: "wrapper/agent-common/src", allowed: [] },
  { packageName: "codex", root: "wrapper/codex/src", allowed: [] },
  { packageName: "claude-code", root: "wrapper/claude-code/src", allowed: [] },
  { packageName: "antigravity", root: "wrapper/antigravity/src", allowed: [] },
] as const;
function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return entry.isFile() && child.endsWith(".ts") ? [child] : [];
  });
}

function executableSource(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

function directStderrWrites(root: string): readonly string[] {
  return sourceFiles(resolve(REPOSITORY_ROOT, root)).flatMap((path) => {
      const source = executableSource(readFileSync(path, "utf8"));
      const matches = source.match(/process\.stderr\.write\s*\(/g) ?? [];
      return matches.map(() => relative(REPOSITORY_ROOT, path));
    });
}

function directConsoleErrors(root: string): readonly string[] {
  return sourceFiles(resolve(REPOSITORY_ROOT, root))
    .filter((path) =>
      /console\.error\s*\(/.test(executableSource(readFileSync(path, "utf8"))),
    )
    .map((path) => relative(REPOSITORY_ROOT, path));
}

describe("wrapper stderr sink guard", () => {
  it.each(SOURCE_ROOTS)(
    "$packageName sends error diagnostics through the common sink",
    ({ root, allowed }) => {
      expect(directStderrWrites(root)).toEqual(allowed);
      expect(directConsoleErrors(root)).toEqual([]);
    },
  );

  it("does not mistake prose-only stderr mentions for a sink", () => {
    expect(
      executableSource("// process.stderr.write(ignored)\nconst prose = 'stderr';"),
    ).not.toMatch(/process\.stderr\.write\s*\(/);
  });
});
