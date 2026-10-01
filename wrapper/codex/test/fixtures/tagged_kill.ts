import { processHasTag } from "./owner_tag.js";

/**
 * SIGKILL `pid` only while it still carries `tag`. A pid that was reused
 * since the scan, or one a faulty search handed over, has no tag and is left
 * alone. Callers pass only pids of processes their own test started.
 */
export function forceKillIfTagged(pid: number | undefined, tag: string): void {
  if (pid === undefined || !processHasTag(pid, tag)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone -- fine.
  }
}
