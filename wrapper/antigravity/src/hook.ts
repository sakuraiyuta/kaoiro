import { askGate, type HookDecision } from "./hook_client.js";

export { askGate } from "./hook_client.js";

/** Below the Stop hook's 30 s timeout, so the hook answers stop itself
 *  before `agy` kills it. */
const STOP_GATE_DEADLINE_MS = 25_000;

function deny(reason: string): void {
  process.stdout.write(`${JSON.stringify({ decision: "deny", reason })}\n`);
}

/** `{}` lets `agy` end its loop; only an explicit continue keeps it going. */
function stopOutput(result: HookDecision | undefined): string {
  return result?.decision === "continue"
    ? JSON.stringify({ decision: "continue", reason: result.reason })
    : "{}";
}

async function readStdin(): Promise<string> {
  let body = "";
  for await (const chunk of process.stdin) body += String(chunk);
  return body;
}

/** The payload as an object, or undefined when it is not one. */
function payloadRecord(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}

async function main(): Promise<void> {
  let body: unknown;
  try { body = JSON.parse(await readStdin()); } catch { /* Not JSON: no payload. */ }
  const payload = payloadRecord(body);
  const stop = payload?.hookEventName === "Stop";
  const socketPath = process.env.KAOIRO_GATE_SOCKET;
  const nonce = process.env.KAOIRO_GATE_NONCE;
  const deadlineMs = Number.parseInt(process.env.KAOIRO_GATE_DEADLINE_MS ?? "", 10);
  if (socketPath === undefined || nonce === undefined || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    if (stop) process.stdout.write(`${stopOutput(undefined)}\n`);
    else deny("kaoiro: gate environment is not configured");
    return;
  }
  if (payload === undefined) {
    deny("kaoiro: malformed hook payload");
    return;
  }
  if (stop) {
    let result: HookDecision | undefined;
    try {
      result = await askGate(socketPath, nonce, payload, Math.min(deadlineMs, STOP_GATE_DEADLINE_MS));
    } catch {
      result = undefined;
    }
    process.stdout.write(`${stopOutput(result)}\n`);
    return;
  }
  try {
    const result = await askGate(socketPath, nonce, payload, deadlineMs);
    if (result.decision === "allow" || result.decision === "deny") {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      deny("kaoiro: gate unavailable (malformed gate response)");
    }
  } catch (error) {
    deny(`kaoiro: gate unavailable (${error instanceof Error ? error.message : String(error)})`);
  }
}

export async function runAntigravityHook(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    deny(`kaoiro: hook failure (${String(error)})`);
  }
}
