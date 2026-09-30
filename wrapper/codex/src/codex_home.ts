import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The directory Codex keeps its state in: `CODEX_HOME`, else `~/.codex`.
 *  An empty value counts as unset, as it does for the Codex CLI itself. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.CODEX_HOME;
  return value !== undefined && value !== "" ? value : join(homedir(), ".codex");
}

/** Why the configured `CODEX_HOME` cannot be used, or null when it is unset or
 *  usable. The Codex CLI needs an existing directory and resolves a relative
 *  path against its own cwd, which differs between the runner and a wrapper. */
export function codexHomeProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.CODEX_HOME;
  if (value === undefined || value === "") return null;
  if (!isAbsolute(value)) return `CODEX_HOME=${value} is not an absolute path`;
  try {
    if (!statSync(value).isDirectory()) return `CODEX_HOME=${value} is not a directory`;
  } catch {
    return `CODEX_HOME=${value} does not exist`;
  }
  return null;
}
