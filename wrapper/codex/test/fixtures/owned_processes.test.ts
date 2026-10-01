import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it } from "vitest";
import {
  OWNER_ENV,
  isOwned,
  ownedPids,
  reapOwned,
} from "./owned_processes.js";

const isLinux = process.platform === "linux";
const spawned: ChildProcess[] = [];

const pid1EnvironCode = (() => {
  try {
    readFileSync("/proc/1/environ");
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? null;
  }
})();

// Own session (detached), so nothing here is reachable through this
// process's group or its parent link.
function start(command: string, args: string[], tag?: string): ChildProcess {
  const env = { ...process.env };
  delete env[OWNER_ENV];
  if (tag !== undefined) env[OWNER_ENV] = tag;
  const child = spawn(command, args, {
    detached: true,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  spawned.push(child);
  return child;
}

function stat(pid: number): { state: string; ppid: number } | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0]!, ppid: Number(fields[1]) };
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  const entry = stat(pid);
  return entry !== null && entry.state !== "Z";
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function firstNumber(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim())));
  });
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => {
    if (child.signalCode !== null || child.exitCode !== null) {
      resolve(child.signalCode);
      return;
    }
    child.once("exit", (_code, signal) => resolve(signal));
  });
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already gone -- fine.
    }
  }
});

const byNumber = (a: number, b: number) => a - b;

it.skipIf(!isLinux)(
  "finds a tagged descendant that was reparented away and reaps it with its ancestor",
  async () => {
    const tag = randomUUID();
    // The subshell exits at once, so the inner sleep is orphaned while the
    // outer process is still running.
    const root = start("sh", ["-c", "(sleep 60 & echo $!); exec sleep 60"], tag);
    const orphanPid = await firstNumber(root);
    await waitUntil(() => stat(orphanPid)?.ppid !== root.pid);
    expect(stat(orphanPid)?.ppid).not.toBe(root.pid);

    const expected = [root.pid!, orphanPid].sort(byNumber);
    expect(ownedPids(tag).sort(byNumber)).toEqual(expected);

    const rootExit = exited(root);
    expect(reapOwned(tag).sort(byNumber)).toEqual(expected);
    expect(await rootExit).toBe("SIGKILL");
    await waitUntil(() => !isRunning(orphanPid));
    expect(ownedPids(tag)).toEqual([]);
  },
);

it.skipIf(!isLinux)(
  "neither finds nor signals processes without the tag or with a different tag",
  () => {
    const tag = randomUUID();
    const otherTag = `${tag}-other`;
    const untagged = start("sleep", ["60"]);
    const other = start("sleep", ["60"], otherTag);

    // The prefix-sharing tag is real and visible, so the empty result for
    // `tag` is not an empty scan.
    expect(ownedPids(otherTag)).toEqual([other.pid]);
    expect(ownedPids(tag)).toEqual([]);
    expect(reapOwned(tag)).toEqual([]);
    expect(isRunning(untagged.pid!)).toBe(true);
    expect(isRunning(other.pid!)).toBe(true);
  },
);

it.skipIf(!isLinux)(
  "treats a PID whose environ is gone (ENOENT) as not owned and reaps nothing",
  async () => {
    const tag = randomUUID();
    const child = start("sleep", ["60"], tag);
    expect(isOwned(child.pid!, tag)).toBe(true);

    const gone = exited(child);
    process.kill(child.pid!, "SIGKILL");
    await gone;

    expect(isOwned(child.pid!, tag)).toBe(false);
    expect(reapOwned(tag)).toEqual([]);
  },
);

it.skipIf(!isLinux || pid1EnvironCode !== "EACCES")(
  "treats a PID whose environ is unreadable (EACCES) as not owned",
  () => {
    expect(isOwned(1, randomUUID())).toBe(false);
  },
);
