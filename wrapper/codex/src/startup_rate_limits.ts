import { AppServerTransport } from "./app_server_transport.js";
import type { AppServerRateLimits } from "./app_server_telemetry.js";
import type { CodexRateLimitSnapshot, CodexRateLimitWindow } from "./rollout.js";

export type StartupRateLimitTransportFactory = () => Pick<AppServerTransport, "readRateLimits" | "close">;

export function codexAccountRateLimits(
  account: AppServerRateLimits,
): Map<CodexRateLimitWindow, CodexRateLimitSnapshot> {
  // An anonymous legacy bucket cannot prove that it belongs to Codex's meter.
  const windows = account.buckets.find((bucket) => bucket.limitId === "codex")?.windows;
  return new Map(Object.entries(windows ?? {}) as Array<[
    CodexRateLimitWindow, CodexRateLimitSnapshot
  ]>);
}

export async function readStartupRateLimits(
  signal?: AbortSignal,
  createTransport: StartupRateLimitTransportFactory = () => new AppServerTransport(),
): Promise<Map<CodexRateLimitWindow, CodexRateLimitSnapshot>> {
  if (signal?.aborted) return new Map();
  const transport = createTransport();
  const abort = () => { void transport.close(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return codexAccountRateLimits(await transport.readRateLimits());
  } finally {
    signal?.removeEventListener("abort", abort);
    await transport.close();
  }
}
