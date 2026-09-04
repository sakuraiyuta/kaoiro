import { createConnection } from "node:net";

export interface HookDecision {
  decision: "allow" | "deny";
  reason?: string;
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
      if (!socket.destroyed) socket.destroy();
      callback(value);
    };
    const fail = (error: Error): void => settle(reject, error);
    const finish = (result: HookDecision): void => settle(resolve, result);
    socket.once("error", fail);
    socket.once("close", () => fail(new Error("gate socket closed")));
    socket.once("connect", () => {
      try {
        socket.write(`${JSON.stringify({ ...(body as Record<string, unknown>), nonce })}\n`);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as unknown;
        if (typeof parsed === "object" && parsed !== null && (parsed as { decision?: unknown }).decision === "allow") {
          finish({ decision: "allow" });
          return;
        }
        if (typeof parsed === "object" && parsed !== null && (parsed as { decision?: unknown }).decision === "deny") {
          const reason = (parsed as { reason?: unknown }).reason;
          finish({ decision: "deny", ...(typeof reason === "string" ? { reason } : {}) });
          return;
        }
        fail(new Error("malformed gate response"));
      } catch {
        fail(new Error("malformed gate response"));
      }
    });
  });
}
