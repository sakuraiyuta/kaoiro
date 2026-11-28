import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MuseLaunchError } from "./errors.js";

export const SHUTDOWN_GRACE_MS = 3_000;
export const MAX_PERSONA_ARG_BYTES = 16_384;
const MAX_SETTINGS_BYTES = 1024 * 1024;

export async function checkUserAppend(env: NodeJS.ProcessEnv): Promise<void> {
  const xdg = env.XDG_CONFIG_HOME;
  const root = xdg ? xdg : env.HOME ? join(env.HOME, ".config") : "";
  if (!root || !isAbsolute(root)) {
    throw new MuseLaunchError("muse user settings could not be checked");
  }
  const path = join(root, "muse", "settings.json");
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new MuseLaunchError("muse user settings could not be checked");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error();
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_SETTINGS_BYTES) throw new Error();
    const value: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error();
    }
    const settings = value as Record<string, unknown>;
    const run = settings.run;
    if (run !== undefined &&
      (typeof run !== "object" || run === null || Array.isArray(run))) {
      throw new Error();
    }
    if (Object.hasOwn(settings, "run.system_prompt_append") ||
      (run !== undefined && Object.hasOwn(run, "system_prompt_append"))) {
      throw new MuseLaunchError(
        "muse user settings contain system_prompt_append; remove it or move " +
        "instructions to developer_prompt (a different instruction position)",
      );
    }
  } catch (error) {
    if (error instanceof MuseLaunchError) throw error;
    throw new MuseLaunchError("muse user settings could not be checked");
  } finally {
    try {
      await file.close();
    } catch {
      throw new MuseLaunchError("muse user settings could not be checked");
    }
  }
}

/** The argument vector for the resident ACP process. `--trust-workspace`
 *  loads the project's own skills and rules, so it is passed only when the
 *  operator opted in (`KAOIRO_MUSE_TRUST_WORKSPACE`); kaoiro's cwd
 *  allowlist authorizes where an agent may launch, it does not imply
 *  trusting the workspace contents. `--model` (when a launch pick names
 *  one) sets the process start-up model. Approval flags are refused by
 *  `muse acp`, so none are ever passed; the approval mode is chosen
 *  through ACP instead. */
export function museAcpArgs(model?: string, trustWorkspace = false,
  personaPrompt = ""): string[] {
  const args = ["acp"];
  const personaArg = `run.system_prompt_append=${JSON.stringify(personaPrompt)}`;
  const bytes = Buffer.byteLength(personaArg, "utf8");
  if (bytes > MAX_PERSONA_ARG_BYTES) {
    throw new MuseLaunchError(
      `muse persona argument is ${bytes} bytes (maximum ${MAX_PERSONA_ARG_BYTES})`,
    );
  }
  args.push("-c", personaArg);
  if (trustWorkspace) args.push("--trust-workspace");
  if (model !== undefined && model !== "" && model !== "default") {
    args.push("--model", model);
  }
  return args;
}

/** The environment for the ACP child: the operator's environment, passed
 *  through unchanged. The experimental ACP gate is on by default
 *  upstream; forcing `MUSE_EXPERIMENTAL_ACP=on` here would re-open a gate
 *  the operator (or a remote configuration) deliberately closed. A closed
 *  gate makes `muse acp` exit with code 5, which surfaces as a launch
 *  failure. */
export function childEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...env };
}

export class MuseProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  #closing: Promise<void> | undefined;

  constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    try {
      this.child = spawn(executable, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: "pipe",
      });
    } catch {
      throw new MuseLaunchError("muse spawn failed");
    }
    this.exited = new Promise((resolve, reject) => {
      this.child.once("error", () =>
        reject(new MuseLaunchError("muse spawn failed")),
      );
      this.child.once("exit", () => resolve());
    });
    // Startup may fail before the ACP reader has attached its own waiter.
    void this.exited.catch(() => {});
    this.child.stderr.resume();
  }

  #signal(signal: NodeJS.Signals | 0): boolean {
    const pid = this.child.pid;
    if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0)
      return false;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#terminate());
  }

  async #terminate(): Promise<void> {
    this.child.stdin.end();
    if (!this.#signal("SIGTERM")) return;
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (this.#signal(0) && Date.now() < deadline) {
      await delay(25);
    }
    if (this.#signal(0)) this.#signal("SIGKILL");
    await this.exited.catch(() => {});
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}
