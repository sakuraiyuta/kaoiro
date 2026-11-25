import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { MuseLaunchError } from "./errors.js";

export const SHUTDOWN_GRACE_MS = 3_000;

/** The argument vector for the resident ACP process. `muse acp` is
 *  experimental: `--trust-workspace` loads the project's own skills and
 *  rules, and `--model` (when a launch pick names one) sets the process
 *  start-up model. Approval flags are refused by `muse acp`, so none are
 *  ever passed; the approval mode is chosen through ACP instead. */
export function museAcpArgs(model?: string): string[] {
  const args = ["acp", "--trust-workspace"];
  if (model !== undefined && model !== "" && model !== "default") {
    args.push("--model", model);
  }
  return args;
}

/** The environment for the ACP child: the operator's environment, with the
 *  experimental ACP gate opened only when the operator has not set it
 *  either way (a closed gate makes `muse acp` exit with code 5). */
export function childEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out = { ...env };
  if (out.MUSE_EXPERIMENTAL_ACP === undefined) {
    out.MUSE_EXPERIMENTAL_ACP = "on";
  }
  return out;
}

export class MuseProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  #closing: Promise<void> | undefined;

  constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(executable, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
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
