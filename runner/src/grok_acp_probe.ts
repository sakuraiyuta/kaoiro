// A short-lived Grok ACP process for questions the runner asks without a
// session of its own: `initialize`, then one operation (issue #644). Grok runs
// in its own process group so a stop, a deadline or an abort can end every
// process it started.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { acpProbesSettled, trackAcpProbe } from "./acp_probe.js";

export const GROK_PROBE_DEADLINE_MS = 10_000;
const KILL_GRACE_MS = 1_000;
const GROUP_POLL_MS = 25;
/** Room for one probe's teardown: two grace periods and some slack. */
export const GROK_PROBE_SETTLE_MS = 2 * KILL_GRACE_MS + 500;

/** The shared probe registry (acp_probe.ts): Grok and Muse probes settle
 *  on the same tracking and deadline, so shutdown waits for both. */
export const grokProbesSettled = acpProbesSettled;

export class GrokProbeError extends Error {
  constructor(
    readonly reason: "spawn" | "deadline" | "exit" | "protocol" | "rpc",
    readonly code?: number,
  ) {
    super(`grok probe failed: ${reason}${code === undefined ? "" : ` ${code}`}`);
  }
}

export class GrokProbeAborted extends Error {
  constructor() {
    super("grok probe aborted");
  }
}

export interface GrokProbeOptions {
  cwd: string;
  signal?: AbortSignal;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  deadlineMs?: number;
}

export type GrokProbeCall = (method: string, params: unknown) => Promise<unknown>;

type Kill = (pid: number, signal: NodeJS.Signals | 0) => void;

const ownGroup = (pid: number | undefined): pid is number =>
  pid !== undefined && Number.isSafeInteger(pid) && pid > 1;

/** Kills a probe's process group. Only an integer pid above 1 is signalled,
 *  so a missing pid can never become kill(0), and pid 1 never kill(-1). */
export function killProbeGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  kill: Kill = process.kill,
): boolean {
  if (!ownGroup(pid)) return false;
  try {
    kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Whether any process, a zombie included, is left in a probe's group. Only
 *  ESRCH means none; any other refusal counts as a live member. */
export function probeGroupAlive(pid: number | undefined, kill: Kill = process.kill): boolean {
  if (!ownGroup(pid)) return false;
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function groupGone(pid: number, withinMs: number, kill: Kill): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (probeGroupAlive(pid, kill)) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
  return true;
}

/** Ends a probe's whole group, within a bound: SIGTERM, then SIGKILL to
 *  whatever is left after the grace, then one more grace. The leader exiting
 *  first does not end the wait, since a process it started can outlive it in
 *  the group; a group still present after the SIGKILL grace is left, and the
 *  caller settles anyway. */
export async function endProbeGroup(
  pid: number | undefined,
  graceMs = KILL_GRACE_MS,
  kill: Kill = process.kill,
): Promise<void> {
  if (!ownGroup(pid) || !killProbeGroup(pid, "SIGTERM", kill)) return;
  if (await groupGone(pid, graceMs, kill)) return;
  killProbeGroup(pid, "SIGKILL", kill);
  await groupGone(pid, graceMs, kill);
}

/**
 * Runs `initialize` and then `operation` against a fresh Grok. Resolves to
 * the operation's value; rejects with GrokProbeAborted when `signal` aborts
 * and with GrokProbeError for every other failure. Either way the process
 * group gets endProbeGroup's bounded teardown before the promise settles,
 * which can leave a member that outlives the SIGKILL grace.
 */
export async function runGrokProbe<T>(
  options: GrokProbeOptions,
  operation: (call: GrokProbeCall, initialized: unknown) => Promise<T>,
): Promise<T> {
  if (options.signal?.aborted) throw new GrokProbeAborted();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      options.executable ?? "grok",
      ["--no-auto-update", "agent", "--no-leader", "stdio"],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        detached: true,
        stdio: "pipe",
      },
    );
  } catch {
    throw new GrokProbeError("spawn");
  }
  const pid = child.pid;
  let finished!: () => void;
  const running = new Promise<void>((resolve) => { finished = resolve; });
  trackAcpProbe(running);
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  let nextId = 0;
  let buffer = "";
  let settled = false;
  let fail!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => { fail = reject; });
  void failed.catch(() => {});
  const stop = (error: Error) => {
    if (settled) return;
    settled = true;
    fail(error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.once("error", () => stop(new GrokProbeError("spawn")));
  child.once("exit", () => stop(new GrokProbeError("exit")));
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    // A line the checks below miss must fail this probe, not the runner.
    try {
      readLines(chunk);
    } catch {
      stop(new GrokProbeError("protocol"));
    }
  });
  const readLines = (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) continue;
        message = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof message.method === "string") {
        // A request from Grok gets a refusal; the probe offers no client
        // capabilities. Notifications are ignored.
        if (message.id !== undefined) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id,
            error: { code: -32601, message: "not supported" } })}\n`);
        }
        continue;
      }
      const entry = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (!entry) continue;
      pending.delete(message.id as number);
      if (!("error" in message)) {
        entry.resolve(message.result);
        continue;
      }
      const error = message.error;
      if (typeof error !== "object" || error === null || Array.isArray(error)) {
        stop(new GrokProbeError("protocol"));
        entry.reject(new GrokProbeError("protocol"));
        continue;
      }
      const code = (error as { code?: unknown }).code;
      entry.reject(new GrokProbeError("rpc", typeof code === "number" ? code : undefined));
    }
  };
  const call: GrokProbeCall = (method, params) => {
    if (settled) return failed;
    const id = ++nextId;
    const answered = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return answered;
  };
  const timer = setTimeout(() => stop(new GrokProbeError("deadline")),
    options.deadlineMs ?? GROK_PROBE_DEADLINE_MS);
  // The group gets its SIGTERM now rather than after the next await, so it
  // is signalled even if the process exits before the teardown finishes.
  const onAbort = () => {
    stop(new GrokProbeAborted());
    killProbeGroup(pid, "SIGTERM");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const initialized = await Promise.race([
      call("initialize", { protocolVersion: 1, clientCapabilities: {} }),
      failed,
    ]);
    return await Promise.race([operation(call, initialized), failed]);
  } finally {
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    child.stdin.end();
    try {
      await endProbeGroup(pid);
    } finally {
      finished();
    }
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
