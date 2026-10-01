import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareCodexToolHome } from "../src/tool_home.js";

it("uses a private standalone home and removes it on close", () => {
  const state = mkdtempSync(join(tmpdir(), "fuji464-state-"));
  try {
    const tool = prepareCodexToolHome(undefined, state);
    expect(tool.path).not.toBe(state);
    expect(existsSync(tool.path)).toBe(true);
    tool.cleanup();
    expect(existsSync(tool.path)).toBe(false);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

it("rejects a direct or symlinked state home and invalid paths before a turn", () => {
  const state = mkdtempSync(join(tmpdir(), "fuji464-state-"));
  const alias = join(state, "..", `fuji464-alias-${process.pid}-${Date.now()}`);
  symlinkSync(state, alias);
  try {
    expect(() => prepareCodexToolHome(state, state)).toThrow("must differ");
    expect(() => prepareCodexToolHome(alias, state)).toThrow("must differ");
    expect(() => prepareCodexToolHome("relative", state)).toThrow("absolute");
    expect(() => prepareCodexToolHome(join(state, "missing"), state)).toThrow();
  } finally {
    unlinkSync(alias);
    rmSync(state, { recursive: true, force: true });
  }
});
