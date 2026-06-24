// Default child launcher (phase 4-4b): turns a resolved WrapperConfig into a
// real wrapper child process. Factored out from the supervisor so the
// supervision logic can be tested without spawning processes.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WrapperConfig } from "@kaoiro/protocol";
import type { LaunchFn, ManagedChild } from "./supervisor.js";

/** The child-process surface toManagedChild needs; ChildProcess satisfies it. */
interface ExitErrorChild {
  on(event: "exit" | "error", listener: () => void): void;
  kill(): void;
}

/**
 * Adapts a child process to ManagedChild. The supervisor's single exit
 * listener fires ONCE, on whichever of `exit` or `error` comes first: a spawn
 * that fails with `error` and no `exit` (e.g. the cwd was removed after the
 * allow-list check) must still reach the supervisor, or the agent would be
 * stranded in its map forever (never restarted, never freed). Exported for
 * unit tests.
 */
export function toManagedChild(child: ExitErrorChild): ManagedChild {
  return {
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
    kill: (): void => {
      child.kill();
    },
  };
}

// Resolve the wrapper CLI entry from the runner's dependency on @kaoiro/wrapper.
// wrapper declares no exports field, so the dist subpath resolves directly; in
// the single-binary build the wrapper is bundled alongside (ADR-0018).
function resolveWrapperCli(): string {
  return createRequire(import.meta.url).resolve("@kaoiro/wrapper/dist/cli.js");
}

/**
 * Builds the default launcher. It owns a private temp dir (0700 via mkdtemp)
 * holding the per-agent wrapper config files; those carry the server_token, so
 * each is written 0600 and removed when its child exits.
 */
export function makeLauncher(): LaunchFn {
  const wrapperCli = resolveWrapperCli();
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
  ): ManagedChild => {
    const configPath = join(dir, `${agentId}-${counter}.json`);
    counter += 1;
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

    const args = [wrapperCli, configPath];
    if (resumeSessionId !== undefined) args.push("--resume", resumeSessionId);
    const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });

    const cleanup = (): void => {
      rmSync(configPath, { force: true });
    };
    child.on("exit", cleanup);
    child.on("error", cleanup);

    return toManagedChild(child);
  };
}
