import { createConnection } from "node:net";

interface HookDecision {
  decision: "allow" | "deny";
  reason?: string;
}

function deny(reason: string): void {
  process.stdout.write(`${JSON.stringify({ decision: "deny", reason })}\n`);
}

async function readStdin(): Promise<string> {
  let body = "";
  for await (const chunk of process.stdin) body += String(chunk);
  return body;
}

async function askGate(socketPath: string, nonce: string, body: unknown, deadlineMs: number): Promise<HookDecision> {
  return new Promise<HookDecision>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("gate deadline exceeded"));
    }, deadlineMs);
    const finish = (result: HookDecision): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...(body as Record<string, unknown>), nonce })}\n`));
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
        reject(new Error("malformed gate response"));
      } catch {
        reject(new Error("malformed gate response"));
      }
    });
  });
}

async function main(): Promise<void> {
  const socketPath = process.env.KAOIRO_GATE_SOCKET;
  const nonce = process.env.KAOIRO_GATE_NONCE;
  const deadlineMs = Number.parseInt(process.env.KAOIRO_GATE_DEADLINE_MS ?? "", 10);
  if (socketPath === undefined || nonce === undefined || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    deny("kaoiro: gate environment is not configured");
    return;
  }
  let body: unknown;
  try { body = JSON.parse(await readStdin()); } catch { deny("kaoiro: malformed hook payload"); return; }
  try {
    const result = await askGate(socketPath, nonce, body, deadlineMs);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    deny(`kaoiro: gate unavailable (${error instanceof Error ? error.message : String(error)})`);
  }
}

void main().catch((error: unknown) => deny(`kaoiro: hook failure (${String(error)})`));
