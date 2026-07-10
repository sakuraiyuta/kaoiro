// Default child launcher (phase 4-4b): turns a resolved WrapperConfig into a
// real wrapper child process. Factored out from the supervisor so the
// supervision logic can be tested without spawning processes.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EngineKind, WrapperConfig } from "@kaoiro/protocol";
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

/** Engine kind -> wrapper package (ADR-0032 F4a). */
const ENGINE_PACKAGES: Record<EngineKind, string> = {
  "claude-code": "@kaoiro/claude-code",
  codex: "@kaoiro/codex",
};

// Leading argv for `process.execPath` (node) that runs the wrapper of the
// requested engine. Default (prod) runs the built dist directly; the wrapper
// packages declare no exports field so the subpath resolves, and the
// single-binary build bundles them alongside (ADR-0018). When
// KAOIRO_WRAPPER_DEV is set, run the wrapper from TS source under `tsx watch`
// so source edits hot-reload the running agent: tsx restarts the inner script
// on change while the supervised process (tsx) stays up. This is a dev-only
// path (scripts/dev.sh); prod is unaffected.
export function resolveWrapperLaunch(
  engine: EngineKind = "claude-code",
): string[] {
  const require = createRequire(import.meta.url);
  const pkg = ENGINE_PACKAGES[engine];
  if (process.env.KAOIRO_WRAPPER_DEV) {
    const tsxPkgPath = require.resolve("tsx/package.json");
    const tsxPkg = JSON.parse(readFileSync(tsxPkgPath, "utf8")) as {
      bin: string | Record<string, string>;
    };
    const tsxRel = typeof tsxPkg.bin === "string" ? tsxPkg.bin : tsxPkg.bin.tsx;
    if (tsxRel === undefined) {
      throw new Error("KAOIRO_WRAPPER_DEV: tsx package has no bin entry");
    }
    const tsxBin = join(dirname(tsxPkgPath), tsxRel);
    const wrapperPkgPath = require.resolve(`${pkg}/package.json`);
    const wrapperSrc = join(dirname(wrapperPkgPath), "src", "cli.ts");
    return [tsxBin, "watch", wrapperSrc];
  }
  return [require.resolve(`${pkg}/dist/cli.js`)];
}

/**
 * Builds the default launcher. It owns a private temp dir (0700 via mkdtemp)
 * holding the per-agent wrapper config files; those carry the server_token, so
 * each is written 0600 and removed when its child exits.
 */
export function makeLauncher(): LaunchFn {
  // Per-engine launch prefixes, resolved lazily: a host that never spawns
  // codex never require.resolves that package.
  const prefixes = new Map<EngineKind, string[]>();
  const launchPrefixFor = (engine: EngineKind): string[] => {
    let prefix = prefixes.get(engine);
    if (prefix === undefined) {
      prefix = resolveWrapperLaunch(engine);
      prefixes.set(engine, prefix);
    }
    return prefix;
  };
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
    const configPath = join(dir, `${agentId}-${counter}.json`);
    counter += 1;
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

    // wrapper CLI: [configPath] [prompt] [--resume <id>]. The prompt is the
    // positional after configPath, so it must precede the --resume flag.
    // The prefix is the engine's dist entry (prod) or `tsx watch src/cli.ts`
    // (dev).
    const args = [...launchPrefixFor(engine), configPath];
    if (initialPrompt !== undefined) args.push(initialPrompt);
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
