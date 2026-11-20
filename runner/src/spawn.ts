// Default child launcher (phase 4-4b): turns a resolved WrapperConfig into a
// real wrapper child process. Factored out from the supervisor so the
// supervision logic can be tested without spawning processes.

import { readRecoveryCheckpoint, selfCommand, writeRecoveryCheckpoint } from "@kaoiro/wrapper-core";
import type { RecoverySnapshot } from "@kaoiro/wrapper-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineKind, WrapperConfig } from "@kaoiro/protocol";
import { storedEngineExecutable } from "./engines.js";
import type { LaunchFn, ManagedChild } from "./supervisor.js";

/** The child-process surface toManagedChild needs; ChildProcess satisfies it. */
interface ExitErrorChild {
  on(event: "exit", listener: (code?: number | null, signal?: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: () => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Adapts a child process to ManagedChild. The supervisor's single exit
 * listener fires ONCE, on whichever of `exit` or `error` comes first: a spawn
 * that fails with `error` and no `exit` (e.g. the cwd was removed after the
 * allow-list check) must still reach the supervisor, or the agent would be
 * stranded in its map forever (never restarted, never freed). Exported for
 * unit tests.
 */
export function toManagedChild(child: ExitErrorChild, readRecovery?: () => RecoverySnapshot, cleanup?: () => void): ManagedChild {
  const managed: ManagedChild = {
    on: (_event: "exit", listener: () => void): void => {
      let fired = false;
      const fire = (): void => {
        if (fired) return;
        fired = true;
        listener();
      };
      child.on("exit", fire);
      child.on("error", fire);
    },
    kill: (signal?: NodeJS.Signals): boolean => {
      return child.kill(signal);
    },
    ...(readRecovery === undefined ? {} : { readRecovery }),
  };
  let collected = false;
  const collect = (): void => {
    if (collected) return;
    collected = true;
    if (readRecovery !== undefined) managed.recovery = readRecovery();
    cleanup?.();
  };
  child.on("exit", (code, signal) => {
    managed.exitCode = code ?? null;
    managed.signal = signal ?? null;
    collect();
  });
  child.on("error", collect);
  return managed;
}

/**
 * Builds the default launcher. It owns a private temp dir (0700 via mkdtemp)
 * holding the per-agent wrapper config files; those carry the server_token, so
 * each is written 0600 and removed when its child exits. `command` starts the
 * kaoiro entry; a wrapper is `<command...> wrapper <engine> run <launch file>`
 * (ADR-0076).
 */
export function makeLauncher(command: string[] = selfCommand()): LaunchFn {
  const [node, ...entry] = command;
  if (node === undefined) throw new Error("makeLauncher: empty command");
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-runner-"));
  let counter = 0;

  // The temp dir lives for the runner's lifetime (per-agent config files are
  // removed as their children exit); drop the dir itself on shutdown so a
  // long-lived host does not leave empty dirs behind. once: makeLauncher is a
  // per-process singleton, but `once` keeps it from stacking listeners.
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort; /tmp is cleared by the OS if this is missed.
    }
  });

  return (
    agentId: string,
    config: WrapperConfig,
    cwd: string,
    resumeSessionId?: string,
    initialPrompt?: string,
    engine: EngineKind = "claude-code",
  ): ManagedChild => {
    const executable = storedEngineExecutable(engine);
    const configPath = join(dir, `${agentId}-${counter}.json`);
    const checkpointPath = `${configPath}.recovery`;
    counter += 1;
    const toolHome = engine === "codex"
      ? mkdtempSync(join(dir, "codex-tool-")) : undefined;
    const childConfig = { ...config, recovery_checkpoint_path: checkpointPath };
    if (executable === undefined) delete childConfig.engine_executable;
    else childConfig.engine_executable = executable;
    if (toolHome === undefined) delete childConfig.codex_tool_home;
    else childConfig.codex_tool_home = toolHome;
    // Both travel in the 0600 launch file, never in the arguments, which any
    // local user can read from the process list. They are per launch, so a
    // value on `config` is not carried over: a relaunch gets no prompt.
    if (initialPrompt === undefined) delete childConfig.initial_prompt;
    else childConfig.initial_prompt = initialPrompt;
    if (resumeSessionId === undefined) delete childConfig.resume_session_id;
    else childConfig.resume_session_id = resumeSessionId;
    const childEnv = { ...process.env };
    if (engine !== "codex") delete childEnv.CODEX_HOME;
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(configPath, { force: true });
        rmSync(checkpointPath, { force: true });
        rmSync(`${checkpointPath}.tmp`, { force: true });
      }
      finally {
        if (toolHome !== undefined) rmSync(toolHome, { recursive: true, force: true });
      }
    };

    const args = [...entry, "wrapper", engine, "run", configPath];
    let child: ReturnType<typeof spawn>;
    try {
      writeRecoveryCheckpoint(checkpointPath, { version: 1, state: "initial" });
      writeFileSync(configPath, JSON.stringify(childConfig), { mode: 0o600 });
      child = spawn(node, args, { cwd, stdio: "inherit", env: childEnv });
    } catch (error) {
      cleanup();
      throw error;
    }
    const managed = toManagedChild(child, () => readRecoveryCheckpoint(checkpointPath), cleanup);
    managed.recoveryTarget = { expected: resumeSessionId !== undefined, kind: config.recovery_resume_kind ?? "strict" };
    return managed;
  };
}
