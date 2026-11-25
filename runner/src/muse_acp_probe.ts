// A short-lived Muse ACP process for questions the runner asks without a
// session of its own: `initialize`, then one operation. Modeled on the Grok
// probe (grok_acp_probe.ts), with Muse's launch shape: `muse acp`, and the
// experimental ACP gate opened for the child unless the operator set it.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { endProbeGroup } from "./grok_acp_probe.js";

export const MUSE_PROBE_DEADLINE_MS = 10_000;

export class MuseProbeError extends Error {
  constructor(
    readonly reason: "spawn" | "deadline" | "exit" | "protocol" | "rpc",
    readonly code?: number,
  ) {
    super(`muse probe failed: ${reason}${code === undefined ? "" : ` ${code}`}`);
  }
}

export class MuseProbeAborted extends Error {
  constructor() {
    super("muse probe aborted");
  }
}

export interface MuseProbeOptions {
  cwd: string;
  signal?: AbortSignal;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  deadlineMs?: number;
}

export type MuseProbeCall = (method: string, params: unknown) => Promise<unknown>;

/** Runs `initialize` and then `operation` against a fresh `muse acp`.
 *  Rejects with MuseProbeAborted when `signal` aborts and with
 *  MuseProbeError for every other failure; the process group gets the
 *  shared bounded teardown either way. */
export async function runMuseProbe<T>(
  options: MuseProbeOptions,
  operation: (call: MuseProbeCall, initialized: unknown) => Promise<T>,
): Promise<T> {
  if (options.signal?.aborted) throw new MuseProbeAborted();
  const env = { ...(options.env ?? process.env) };
  if (env.MUSE_EXPERIMENTAL_ACP === undefined) env.MUSE_EXPERIMENTAL_ACP = "on";
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.executable ?? "muse", ["acp"], {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: "pipe",
    });
  } catch {
    throw new MuseProbeError("spawn");
  }
  const pid = child.pid;
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
  child.once("error", () => stop(new MuseProbeError("spawn")));
  child.once("exit", () => stop(new MuseProbeError("exit")));
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    try {
      readLines(chunk);
    } catch {
      stop(new MuseProbeError("protocol"));
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
        // A request from the agent gets a refusal; the probe offers no
        // client capabilities. Notifications are ignored.
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
        stop(new MuseProbeError("protocol"));
        entry.reject(new MuseProbeError("protocol"));
        continue;
      }
      const code = (error as { code?: unknown }).code;
      entry.reject(new MuseProbeError("rpc", typeof code === "number" ? code : undefined));
    }
  };
  const call: MuseProbeCall = (method, params) => {
    if (settled) return failed;
    const id = ++nextId;
    const answered = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return answered;
  };
  const timer = setTimeout(() => stop(new MuseProbeError("deadline")),
    options.deadlineMs ?? MUSE_PROBE_DEADLINE_MS);
  const onAbort = () => stop(new MuseProbeAborted());
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
    await endProbeGroup(pid);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
