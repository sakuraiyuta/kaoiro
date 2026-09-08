import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgyExecutable } from "../src/cli-path.js";

const roots: string[] = [];

function directory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `kaoiro-agy-${label}-`));
  roots.push(root);
  return root;
}

function executable(root: string): string {
  const path = join(root, "agy");
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("resolveAgyExecutable", () => {
  it("uses the first executable from absolute PATH directories without consulting cwd", () => {
    const relative = directory("relative");
    const skipped = directory("skipped");
    const selected = directory("selected");
    executable(relative);
    writeFileSync(join(skipped, "agy"), "not executable");
    chmodSync(join(skipped, "agy"), 0o600);
    const expected = executable(selected);

    expect(
      resolveAgyExecutable(
        undefined,
        ["", "relative", skipped, selected].join(delimiter),
      ),
    ).toEqual({ ok: true, path: expected });
  });

  it("preserves an explicit symlink spelling and accepts whitespace in its absolute path", () => {
    const root = directory("space path");
    const target = executable(root);
    const shim = join(root, "agy shim");
    symlinkSync(target, shim);

    expect(resolveAgyExecutable(shim)).toEqual({ ok: true, path: shim });
  });

  it("starts a real child through an explicitly configured path", () => {
    const root = directory("child");
    const path = executable(root);
    const resolved = resolveAgyExecutable(path);
    expect(resolved).toEqual({ ok: true, path });
    if (!resolved.ok) throw new Error("test setup did not resolve executable");

    const child = spawnSync(resolved.path, [], { encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(child.error).toBeUndefined();
  });

  it("does not fall back to PATH when an explicit executable is missing", () => {
    const fallback = directory("fallback");
    executable(fallback);

    expect(resolveAgyExecutable(join(fallback, "missing"), fallback)).toEqual({
      ok: false,
      reason: "executable_missing",
    });
  });

  it("does not treat a directory as an executable and distinguishes a denied PATH", () => {
    const root = directory("directory");
    mkdirSync(join(root, "agy"));

    expect(resolveAgyExecutable(undefined, root)).toEqual({
      ok: false,
      reason: "permission_denied",
    });
  });
});
