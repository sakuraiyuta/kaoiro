// Short-lived Muse probes use ACP for discovery and MSP for the catalog.
// Both use the existing probe registry and bounded group teardown.
// The child inherits the operator's environment and ACP gate settings.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { trackAcpProbe } from "./acp_probe.js";
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

export function runMuseProbe<T>(
  options: MuseProbeOptions,
  operation: (call: MuseProbeCall, initialized: unknown) => Promise<T>,
): Promise<T> {
  return runProbe(options, ["acp"], async (call) => {
    const initialized = await call("initialize", {
      protocolVersion: 1, clientCapabilities: {},
    });
    return operation(call, initialized);
  });
}

export function readMuseModelList(options: MuseProbeOptions): Promise<unknown> {
  return runProbe(
    options,
    ["serve", "--disable-shell", "--disable-write", "--no-session-log"],
    async (call, notify) => {
      await call("initialize", {
        clientInfo: { name: "kaoiro", version: "1" },
      });
      notify("initialized");
      return call("model/list", {});
    },
  );
}

type Notify = (method: "initialized") => void;

function runProbe<T>(
  options: MuseProbeOptions,
  args: string[],
  operation: (call: MuseProbeCall, notify: Notify) => Promise<T>,
): Promise<T> {
  const running = runMuseProbeInner(options, args, operation);
  trackAcpProbe(running);
  return running;
}

async function runMuseProbeInner<T>(
  options: MuseProbeOptions,
  args: string[],
  operation: (call: MuseProbeCall, notify: Notify) => Promise<T>,
): Promise<T> {
  if (options.signal?.aborted) throw new MuseProbeAborted();
  const env = { ...(options.env ?? process.env) };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.executable ?? "muse", args, {
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
  const notify: Notify = (method) => {
    if (settled) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  };
  const timer = setTimeout(() => stop(new MuseProbeError("deadline")),
    options.deadlineMs ?? MUSE_PROBE_DEADLINE_MS);
  const onAbort = () => stop(new MuseProbeAborted());
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation(call, notify), failed]);
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
