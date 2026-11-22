import { createConnection } from "node:net";

export type HookDecision =
  | { decision: "allow"; reason?: string }
  | { decision: "deny"; reason?: string }
  | { decision: "continue"; reason: string }
  | { decision: "stop" };

/** One gate answer line, or null when it is not one of the four forms. */
function decode(line: string): HookDecision | null {
  let parsed = null as { decision?: unknown; reason?: unknown } | null;
  try { parsed = JSON.parse(line) as typeof parsed; } catch { /* Not JSON: no decision. */ }
  const decision = parsed?.decision;
  const reason = parsed?.reason;
  if (decision === "allow") return { decision: "allow" };
  if (decision === "deny") return { decision: "deny", ...(typeof reason === "string" ? { reason } : {}) };
  if (decision === "continue" && typeof reason === "string") return { decision: "continue", reason };
  if (decision === "stop") return { decision: "stop" };
  return null;
}

export async function askGate(socketPath: string, nonce: string, body: unknown, deadlineMs: number): Promise<HookDecision> {
  return new Promise<HookDecision>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      settle(reject, new Error("gate deadline exceeded"));
    }, deadlineMs);
    const settle = <T>(callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    const fail = (error: Error): void => settle(reject, error);
    const finish = (result: HookDecision): void => settle(resolve, result);
    socket.once("error", fail);
    socket.once("close", () => fail(new Error("gate socket closed")));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ ...(body as Record<string, unknown>), nonce })}\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const result = decode(buffer.slice(0, newline));
      if (result === null) fail(new Error("malformed gate response"));
      else finish(result);
    });
  });
}
