import { spawn, type ChildProcess } from "node:child_process";

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

export type AgyUsageProbeSpawn = (
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: ("ignore" | "pipe")[] },
) => ChildProcess;

/** Spawns `agy -p /usage --output-format json` and returns stdout on exit 0. */
export async function runAgyUsageProbe(
  executable: string,
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    timeoutMs?: number | undefined;
    spawn?: AgyUsageProbeSpawn | undefined;
  } = {},
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
    };

    try {
      const spawnOpts: {
        stdio: ("ignore" | "pipe")[];
        cwd?: string;
        env?: NodeJS.ProcessEnv;
      } = {
        stdio: ["ignore", "pipe", "pipe"],
      };
      if (options.cwd !== undefined) spawnOpts.cwd = options.cwd;
      if (options.env !== undefined) spawnOpts.env = options.env;
      child = spawnFn(executable, ["-p", "/usage", "--output-format", "json"], spawnOpts);
    } catch (err) {
      reject(err);
      return;
    }

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill("SIGKILL");
      } catch {
        // Child may have already exited.
      }
      reject(new Error(`usage_probe_timeout:${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) {
        resolve(stdoutBuffer);
      } else {
        reject(new Error(`usage_probe_exit_${code ?? "signal"}`));
      }
    });
  });
}
