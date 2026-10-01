// Finds and reaps the processes one test run started, however deep or
// detached: every descendant inherits an owner marker in its environment
// (OWNER_ENV=<tag>), and /proc/<pid>/environ is scanned for it. Process-tree
// walks miss what a sandbox reparents or moves into its own session. Linux
// only.
//
// Limits to keep in mind:
// - A process whose environment cannot be read (EACCES for another user,
//   ENOENT/ESRCH once gone, a zombie's empty environ) is treated as NOT
//   owned and is never signalled.
// - A runtime that filters the marker out of a child's environment (for
//   example a shell environment policy) makes that child invisible here.
//   Assert that the marker reached a known process before relying on an
//   empty result.
// - Ownership is only as fresh as the last read of /proc/<pid>/environ. If
//   the process exits and the kernel reuses the PID between that read and
//   kill(), an unrelated process can be signalled; the re-read just before
//   the kill narrows that window but cannot close it.
import { readFileSync, readdirSync } from "node:fs";

export const OWNER_ENV = "KAOIRO_TEST_OWNER";

function readProc(pid: number, file: string): string | null {
  try {
    return readFileSync(`/proc/${pid}/${file}`, "latin1");
  } catch {
    return null;
  }
}

export function isOwned(pid: number, tag: string): boolean {
  const environ = readProc(pid, "environ");
  return environ?.split("\0").includes(`${OWNER_ENV}=${tag}`) ?? false;
}

export function ownedPids(tag: string): number[] {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => isOwned(pid, tag));
}

export function ownedProcessSummary(tag: string): string {
  return ownedPids(tag)
    .map((pid) => {
      const cmdline = readProc(pid, "cmdline")?.split("\0").join(" ").trim();
      return `${pid} ${cmdline || "<unreadable>"}`;
    })
    .join("\n");
}

/** SIGKILLs every process still carrying the tag; returns the PIDs signalled. */
export function reapOwned(tag: string): number[] {
  const signalled: number[] = [];
  for (const pid of ownedPids(tag)) {
    if (!isOwned(pid, tag)) continue;
    try {
      process.kill(pid, "SIGKILL");
      signalled.push(pid);
    } catch {
      // Exited between the scan and the kill -- fine.
    }
  }
  return signalled;
}
