import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { codexHome } from "./codex_home.js";

export interface CodexToolHome {
  path: string;
  cleanup(): void;
}

/** The native process keeps its state home; only its shell tools use this path. */
export function prepareCodexToolHome(
  configured: string | undefined,
  stateHome: string = codexHome(),
): CodexToolHome {
  const owned = configured === undefined;
  const path = configured ?? mkdtempSync(join(tmpdir(), "kaoiro-codex-tool-"));
  try {
    if (!isAbsolute(path) || !statSync(path).isDirectory()) {
      throw new Error("Codex tool home must be an existing absolute directory");
    }
    const toolRealpath = realpathSync(path);
    let stateRealpath: string;
    try { stateRealpath = realpathSync(stateHome); }
    catch { stateRealpath = resolve(stateHome); }
    if (toolRealpath === stateRealpath) {
      throw new Error("Codex tool home must differ from the state home");
    }
    return { path: toolRealpath, cleanup: () => {
      if (owned) rmSync(path, { recursive: true, force: true });
    } };
  } catch (error) {
    if (owned) rmSync(path, { recursive: true, force: true });
    throw error;
  }
}
