import { spawn, type ChildProcess } from "node:child_process";
import { signalTarget, type SignalTargetOperation } from "./subtree_termination.js";

export type AgyUsageFamily = "gemini" | "3p";
export type AgyUsageWindow = "five_hour" | "seven_day";

export type AgyUsageRateLimit = {
  utilization: number;
  resets_at?: number;
  status?: string;
};

export type AgyUsageRateLimits = ReadonlyMap<AgyUsageWindow, AgyUsageRateLimit>;

export const DEFAULT_USAGE_PROBE_TIMEOUT_MS = 10_000;
export const USAGE_PROBE_INTERVAL_MS = 5 * 60 * 1000;
export const USAGE_PROBE_STOP_TIMEOUT_MS = 2_000;
export const MAX_USAGE_PROBE_STDOUT_BYTES = 1024 * 1024;

export function modelToUsageFamily(model: string | undefined): AgyUsageFamily | null {
  if (typeof model !== "string" || model.trim() === "") return null;
  const normalized = model.toLowerCase();
  if (normalized.startsWith("gemini-")) return "gemini";
  if (normalized.startsWith("claude-") || normalized.startsWith("gpt-")) return "3p";
  return null;
}

type RawUsageBucket = {
  id?: unknown;
  window?: unknown;
  remaining_fraction?: unknown;
  reset_time?: unknown;
};

type RawUsageGroup = { buckets?: unknown };
type RawUsagePayload = {
  status?: unknown;
  command?: { name?: unknown; data?: { groups?: unknown } };
};

/** Parses the measured `/usage` JSON and returns only the requested family. */
export function parseAgyUsageOutput(
  stdout: string,
  family: AgyUsageFamily,
): Map<AgyUsageWindow, AgyUsageRateLimit> | null {
  let payload: RawUsagePayload;
  try {
    payload = JSON.parse(stdout) as RawUsagePayload;
  } catch {
    return null;
  }
  if (payload.status !== "SUCCESS" || payload.command?.name !== "usage") return null;

  const groups = payload.command.data?.groups;
  if (!Array.isArray(groups)) return null;
  const prefix = family === "gemini" ? "gemini-" : "3p-";
  const result = new Map<AgyUsageWindow, AgyUsageRateLimit>();
  for (const groupValue of groups) {
    if (typeof groupValue !== "object" || groupValue === null || Array.isArray(groupValue)) continue;
    const buckets = (groupValue as RawUsageGroup).buckets;
    if (!Array.isArray(buckets)) continue;
    for (const bucketValue of buckets) {
      if (typeof bucketValue !== "object" || bucketValue === null || Array.isArray(bucketValue)) continue;
      const bucket = bucketValue as RawUsageBucket;
      if (typeof bucket.id !== "string" || !bucket.id.startsWith(prefix)) continue;
      const window: AgyUsageWindow | null = bucket.window === "5h"
        ? "five_hour"
        : bucket.window === "weekly"
          ? "seven_day"
          : null;
      const remaining = typeof bucket.remaining_fraction === "number" && Number.isFinite(bucket.remaining_fraction)
        ? bucket.remaining_fraction
        : null;
      if (window === null || remaining === null) continue;

      const snapshot: AgyUsageRateLimit = { utilization: Math.max(0, Math.min(1, 1 - remaining)) };
      if (remaining < 1 && typeof bucket.reset_time === "string") {
        const resetMs = Date.parse(bucket.reset_time);
        if (Number.isFinite(resetMs)) snapshot.resets_at = Math.floor(resetMs / 1_000);
      }
      if (remaining <= 0) snapshot.status = "blocked";
      result.set(window, snapshot);
    }
  }
  return result.size > 0 ? result : null;
}

export type UsageProbeStopReason = "timeout" | "abort" | "host_close" | "stale_family" | "stdout_overflow";
export type UsageProbeRunState = "running" | "stopping" | "stop_timed_out" | "closed";

export interface UsageProbeClosedResult {
  stdout: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError: Error | null;
  stopReason: UsageProbeStopReason | null;
}

export type UsageProbeCompletion =
  | { kind: "closed"; result: UsageProbeClosedResult }
  | { kind: "stop_timed_out"; reason: UsageProbeStopReason };

export interface AgyUsageProbeSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "ignore"];
  detached: false;
}

export type AgyUsageProbeSpawn = (
  executable: string,
  args: string[],
  options: AgyUsageProbeSpawnOptions,
) => ChildProcess;

export interface AgyUsageProbeRun {
  readonly child: ChildProcess;
  readonly completion: Promise<UsageProbeCompletion>;
  readonly closed: Promise<UsageProbeClosedResult>;
  readonly state: UsageProbeRunState;
  requestStop(reason: UsageProbeStopReason): void;
}

export interface StartAgyUsageProbeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stopTimeoutMs?: number;
  args?: string[];
  spawn?: AgyUsageProbeSpawn;
  signalTarget?: SignalTargetOperation;
}

/** Starts one bounded `/usage` child. Settlement waits for `close`, or for a
 *  bounded stop deadline; a later close remains observable through `closed`. */
export function startAgyUsageProbe(
  executable: string,
  options: StartAgyUsageProbeOptions = {},
): AgyUsageProbeRun {
  const timeoutMs = options.timeoutMs ?? DEFAULT_USAGE_PROBE_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? USAGE_PROBE_STOP_TIMEOUT_MS;
  const spawnFn = options.spawn ?? spawn;
  const sendSignal = options.signalTarget ?? signalTarget;
  const spawnOptions: AgyUsageProbeSpawnOptions = {
    stdio: ["ignore", "pipe", "ignore"],
    detached: false,
  };
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
  if (options.env !== undefined) spawnOptions.env = options.env;
  const child = spawnFn(
    executable,
    options.args ?? ["-p", "/usage", "--output-format", "json"],
    spawnOptions,
  );

  let state: UsageProbeRunState = "running";
  let stopReason: UsageProbeStopReason | null = null;
  let spawnError: Error | null = null;
  let stdout = "";
  let stdoutBytes = 0;
  let timeout: NodeJS.Timeout | null = null;
  let stopTimeout: NodeJS.Timeout | null = null;
  let resolveCompletion!: (completion: UsageProbeCompletion) => void;
  let resolveClosed!: (result: UsageProbeClosedResult) => void;
  let completionResolved = false;
  const completion = new Promise<UsageProbeCompletion>((resolve) => { resolveCompletion = resolve; });
  const closed = new Promise<UsageProbeClosedResult>((resolve) => { resolveClosed = resolve; });

  const settleCompletion = (value: UsageProbeCompletion): void => {
    if (completionResolved) return;
    completionResolved = true;
    resolveCompletion(value);
  };

  const clearTimers = (): void => {
    if (timeout !== null) clearTimeout(timeout);
    if (stopTimeout !== null) clearTimeout(stopTimeout);
    timeout = null;
    stopTimeout = null;
  };

  const run: AgyUsageProbeRun = {
    child,
    completion,
    closed,
    get state() { return state; },
    requestStop(reason) {
      if (state !== "running") return;
      state = "stopping";
      stopReason = reason;
      if (timeout !== null) clearTimeout(timeout);
      timeout = null;
      stopTimeout = setTimeout(() => {
        if (state !== "stopping") return;
        state = "stop_timed_out";
        settleCompletion({ kind: "stop_timed_out", reason });
      }, stopTimeoutMs);
      try {
        sendSignal(child, "pid", "SIGKILL");
      } catch {
        // The bounded close wait still runs; a failed signal cannot be treated
        // as proof that the child ended.
      }
    },
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: Buffer | string) => {
    if (state !== "running") return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const bytes = Buffer.byteLength(text);
    if (stdoutBytes + bytes > MAX_USAGE_PROBE_STDOUT_BYTES) {
      run.requestStop("stdout_overflow");
      return;
    }
    stdoutBytes += bytes;
    stdout += text;
  });
  child.once("error", (error) => { spawnError = error; });
  child.once("close", (code, signal) => {
    state = "closed";
    clearTimers();
    const result = { stdout, code, signal, spawnError, stopReason };
    resolveClosed(result);
    settleCompletion({ kind: "closed", result });
  });

  timeout = setTimeout(() => run.requestStop("timeout"), timeoutMs);
  return run;
}
