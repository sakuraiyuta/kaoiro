import { askGate } from "./hook_client.js";

export { askGate } from "./hook_client.js";

function deny(reason: string): void {
  process.stdout.write(`${JSON.stringify({ decision: "deny", reason })}\n`);
}

async function readStdin(): Promise<string> {
  let body = "";
  for await (const chunk of process.stdin) body += String(chunk);
  return body;
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
