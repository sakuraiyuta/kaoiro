import { spawn, type ChildProcess } from "node:child_process";
import { signalOwnedChild } from "./subtree_termination.js";

export type AgyUsageWindow = "five_hour" | "seven_day";

export type AgyUsageRateLimitSnapshot = {
  utilization: number;
  resets_at?: number;
  status?: string;
};

export type AgyUsageRateLimits = Map<AgyUsageWindow, AgyUsageRateLimitSnapshot>;

export const DEFAULT_USAGE_PROBE_TIMEOUT_MS = 10_000;
export const USAGE_PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_USAGE_PROBE_RETRIES = 3;

/** Resolves the bucket ID prefix from the active model slug.
 *  Returns null when the model cannot be classified into a known prefix. */
export function modelToBucketPrefix(model: string | undefined): "gemini-" | "3p-" | null {
  if (typeof model !== "string" || model.trim() === "") return null;
  const m = model.toLowerCase();
  if (m.startsWith("gemini-")) return "gemini-";
  if (m.startsWith("claude-") || m.startsWith("gpt-")) return "3p-";
  return null;
}

type RawUsageBucket = {
  id?: unknown;
  name?: unknown;
  window?: unknown;
  remaining_fraction?: unknown;
  reset_time?: unknown;
};

type RawUsageGroup = {
  name?: unknown;
  description?: unknown;
  buckets?: unknown;
};

type RawUsagePayload = {
  status?: unknown;
  command?: {
    name?: unknown;
    data?: {
      groups?: unknown;
    };
  };
};

/** Parses `agy -p /usage --output-format json` stdout.
 *  Uses bucket id prefix matching against activeModel.
 *  When activeModel cannot be resolved to a known bucket prefix, returns null
 *  so rate_limits are omitted rather than falsely guessed. */
export function parseAgyUsageOutput(
  stdout: string,
  activeModel: string | undefined,
): AgyUsageRateLimits | null {
  const prefix = modelToBucketPrefix(activeModel);
  if (prefix === null) return null;

  let payload: RawUsagePayload;
  try {
    payload = JSON.parse(stdout) as RawUsagePayload;
  } catch {
    return null;
  }

  if (payload.status !== "SUCCESS" || !payload.command || payload.command.name !== "usage") {
    return null;
  }

  const groups = payload.command.data?.groups;
  if (!Array.isArray(groups)) return null;

  const out: AgyUsageRateLimits = new Map();

  for (const group of groups as RawUsageGroup[]) {
    if (!Array.isArray(group.buckets)) continue;
    for (const rawBucket of group.buckets as RawUsageBucket[]) {
      if (typeof rawBucket.id !== "string" || !rawBucket.id.startsWith(prefix)) {
        continue;
      }

      let window: AgyUsageWindow | null = null;
      if (rawBucket.window === "5h") window = "five_hour";
      else if (rawBucket.window === "weekly") window = "seven_day";
      if (window === null) continue;

      const remaining = typeof rawBucket.remaining_fraction === "number" && Number.isFinite(rawBucket.remaining_fraction)
        ? rawBucket.remaining_fraction
        : null;
      if (remaining === null) continue;

      const utilization = Math.max(0, Math.min(1, 1 - remaining));
      const snapshot: AgyUsageRateLimitSnapshot = { utilization };

      // should 3: when remaining_fraction >= 1.0 (unused), reset_time is a moving placeholder
      // generated relative to invocation time. Omit resets_at in that case.
      if (remaining < 1.0 && typeof rawBucket.reset_time === "string") {
        const parsedMs = Date.parse(rawBucket.reset_time);
        if (Number.isFinite(parsedMs)) {
          snapshot.resets_at = Math.floor(parsedMs / 1000);
        }
      }

      // nit 1: status is omitted during normal operations, set to "blocked" only when exhausted.
      if (remaining <= 0) {
        snapshot.status = "blocked";
      }

      out.set(window, snapshot);
    }
  }

  return out.size > 0 ? out : null;
}

export const MAX_USAGE_PROBE_STDOUT_BYTES = 1024 * 1024; // 1MB

/** Kills the process group of child using verified signalOwnedChild guard,
 *  falling back to child.kill on fakes or non-ChildProcess instances. */
export function killChildGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!signalOwnedChild(child, signal, { group: true })) {
    try {
      child.kill(signal);
    } catch {
      // Process might have already exited.
    }
  }
}

export type AgyUsageProbeSpawnOptions = {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdio: ("ignore" | "pipe")[];
  detached?: boolean | undefined;
};

export type AgyUsageProbeSpawn = (
  executable: string,
  args: string[],
  options: AgyUsageProbeSpawnOptions,
) => ChildProcess;

export type RunAgyUsageProbeOptions = {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  spawn?: AgyUsageProbeSpawn | undefined;
  signal?: AbortSignal | undefined;
  onChildSpawned?: ((child: ChildProcess) => void) | undefined;
};

/** Spawns `agy -p /usage --output-format json` and returns stdout on exit 0. */
export async function runAgyUsageProbe(
  executable: string,
  options: RunAgyUsageProbeOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_USAGE_PROBE_TIMEOUT_MS;
  const spawnFn = options.spawn ?? spawn;

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let timer: NodeJS.Timeout | null = null;
    let stdoutBuffer = "";
    let settled = false;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (options.signal !== undefined) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const settleResolve = (data: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };

    const onAbort = () => {
      if (settled) return;
      killChildGroup(child, "SIGKILL");
      settleReject(new Error("usage_probe_aborted"));
    };

    try {
      const spawnOpts: AgyUsageProbeSpawnOptions = {
        stdio: ["ignore", "pipe", "ignore"], // should 3: ignore stderr
        detached: true, // should 2: separate process group for child tree
      };
      if (options.cwd !== undefined) spawnOpts.cwd = options.cwd;
      if (options.env !== undefined) spawnOpts.env = options.env;
      child = spawnFn(executable, ["-p", "/usage", "--output-format", "json"], spawnOpts);
      options.onChildSpawned?.(child);
    } catch (err) {
      reject(err);
      return;
    }

    if (options.signal?.aborted) {
      killChildGroup(child, "SIGKILL");
      settleReject(new Error("usage_probe_aborted"));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      if (settled) return;
      killChildGroup(child, "SIGKILL");
      settleReject(new Error(`usage_probe_timeout:${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      // nit 1: stdout buffer limit
      if (stdoutBuffer.length > MAX_USAGE_PROBE_STDOUT_BYTES) {
        killChildGroup(child, "SIGKILL");
        settleReject(new Error("usage_probe_stdout_overflow"));
      }
    });

    child.on("error", (err) => {
      settleReject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        settleResolve(stdoutBuffer);
      } else {
        settleReject(new Error(`usage_probe_exit_${code ?? "signal"}`));
      }
    });
  });
}
