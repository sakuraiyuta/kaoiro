import { AppServerTransport } from "./app_server_transport.js";
import type { AppServerRateLimits } from "./app_server_telemetry.js";
import type { CodexRateLimitSnapshot, CodexRateLimitWindow } from "./rollout.js";

export function codexAccountRateLimits(
  account: AppServerRateLimits,
): Map<CodexRateLimitWindow, CodexRateLimitSnapshot> {
  const windows = account.buckets.find((bucket) => bucket.limitId === "codex")?.windows;
  return new Map(Object.entries(windows ?? {}) as Array<[
    CodexRateLimitWindow, CodexRateLimitSnapshot
  ]>);
}

export async function readStartupRateLimits(signal?: AbortSignal): Promise<Map<CodexRateLimitWindow, CodexRateLimitSnapshot>> {
  if (signal?.aborted) return new Map();
  const transport = new AppServerTransport();
  const abort = () => { void transport.close(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return codexAccountRateLimits(await transport.readRateLimits());
  } finally {
    signal?.removeEventListener("abort", abort);
    await transport.close();
  }
}
