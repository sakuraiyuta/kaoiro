// Read-only ownership tag for processes a test launches. A test exports
// OWNER_TAG_ENV=<unique tag> into the environment of the tree it starts,
// then asks /proc which processes still carry it. Nothing here signals a
// process: a wrong answer can only make a test fail, never hit someone else.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";

// Must not contain KEY / SECRET / TOKEN: Codex drops such variables from the
// environment of the commands it runs.
export const OWNER_TAG_ENV = "KAOIRO_TEST_OWNER_TAG";

export interface TaggedProcess {
  pid: number;
  ppid: string;
  args: string;
}

export function newOwnerTag(): string {
  return `kaoiro-test-owner-${randomUUID()}`;
}

/**
 * True only when the process's environ holds exactly
 * `OWNER_TAG_ENV=<tag>`. Any read failure (EACCES, ENOENT, ESRCH, ...)
 * means false: a process that cannot be inspected is never counted.
 */
export function processHasTag(pid: number, tag: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let environ: string;
  try {
    environ = readFileSync(`/proc/${pid}/environ`, "latin1");
  } catch {
    return false;
  }
  return environ.split("\0").includes(`${OWNER_TAG_ENV}=${tag}`);
}

function describe(pid: number): TaggedProcess {
  let args = "<unreadable>";
  let ppid = "?";
  try {
    args = readFileSync(`/proc/${pid}/cmdline`, "latin1")
      .split("\0")
      .join(" ")
      .trim();
  } catch {
    // Exited between the scan and now.
  }
  try {
    // "pid (comm) state ppid ..." -- comm may itself contain ")".
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    ppid = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1] ?? "?";
  } catch {
    // Same.
  }
  return { pid, ppid, args };
}

/** Processes other than this one that carry `tag`. */
export function taggedProcesses(tag: string): TaggedProcess[] {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  return names
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => pid !== process.pid && processHasTag(pid, tag))
    .map(describe);
}

/**
 * Polls until no process carries `tag`; throws listing the survivors
 * (pid / ppid / args) once `timeoutMs` has passed. Never signals them.
 */
export async function waitForNoTagged(
  tag: string,
  timeoutMs = 10_000,
  intervalMs = 250,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let survivors = taggedProcesses(tag);
  while (survivors.length > 0 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    survivors = taggedProcesses(tag);
  }
  if (survivors.length === 0) return;
  throw new Error(
    `${survivors.length} process(es) tagged ${tag} survived ${timeoutMs}ms:\n` +
      survivors
        .map((p) => `pid=${p.pid} ppid=${p.ppid} args=${p.args}`)
        .join("\n"),
  );
}
