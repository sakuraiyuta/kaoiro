// Failure-only, local diagnostics for Codex turn termination. This is not a
// transcript or a peer-facing error channel: it retains enough evidence to
// diagnose an absent turn.completed without letting raw subprocess/bridge
// text enter the fixed inter-agent peer_error template (issue #255).

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { classifyInterAgentError } from "@kaoiro/agent-common";
import type { ThreadEvent } from "@openai/codex-sdk";

const MAX_EVENTS = 24;
const MAX_EVENT_BYTES = 4096;
const MAX_STDERR_BYTES = 8192;

export function defaultCodexTurnTraceDir(): string {
  if (process.env.KAOIRO_CODEX_TURN_TRACE_DIR !== undefined) {
    return process.env.KAOIRO_CODEX_TURN_TRACE_DIR;
  }
  // Unit tests intentionally do not leave failure traces in a developer's
  // home directory. Production has no VITEST marker and uses the durable
  // per-user diagnostic location below.
  if (process.env.VITEST !== undefined) {
    return join(tmpdir(), "kaoiro-codex-turn-traces-test");
  }
  return join(homedir(), ".kaoiro", "codex-turn-traces");
}

export async function ensureCodexTurnTraceDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

function clipTail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maxBytes
    ? value
    : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function semanticEvent(event: ThreadEvent): string {
  return clipTail(JSON.stringify(event), MAX_EVENT_BYTES);
}

function childStatus(detail: string | undefined):
  | { exitCode?: number; signal?: string; stderrTail: string }
  | undefined {
  if (detail === undefined) return undefined;
  const exitCode = /(?:exited with code|exit code)\s+(\d+)/i.exec(detail)?.[1];
  const signal = /(?:signal|killed by)\s+([A-Z0-9_]+)/i.exec(detail)?.[1];
  return {
    ...(exitCode === undefined ? {} : { exitCode: Number(exitCode) }),
    ...(signal === undefined ? {} : { signal }),
    stderrTail: clipTail(detail, MAX_STDERR_BYTES),
  };
}

/** One trace is created per host turn, but it writes only when that turn
 * ends abnormally. `traceId` is retained in the local JSON for correlation
 * with the bridge stderr tail; no raw trace content goes to the peer. */
export class CodexTurnDiagnostics {
  readonly traceId = randomUUID();
  readonly #directory: string;
  readonly #bridgeStderrPath: string;
  readonly #events: string[] = [];

  constructor(directory = defaultCodexTurnTraceDir()) {
    this.#directory = directory;
    this.#bridgeStderrPath = join(directory, "bridge.stderr.log");
  }

  get directory(): string {
    return this.#directory;
  }

  get bridgeStderrPath(): string {
    return this.#bridgeStderrPath;
  }

  recordEvent(event: ThreadEvent): void {
    this.#events.push(semanticEvent(event));
    if (this.#events.length > MAX_EVENTS) this.#events.shift();
  }

  /** Starts a fresh bridge-stderr capture window for this serial host turn.
   * The bridge receives the fixed path from the host config, so a marker
   * carries this turn's correlation ID without exposing it to the model. */
  async begin(): Promise<void> {
    await ensureCodexTurnTraceDir(this.#directory);
    await writeFile(
      this.#bridgeStderrPath,
      `[kaoiro trace_id=${this.traceId}]\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  async writeFailure(input: {
    sessionId: string | null;
    turnToken: string;
    detail?: string;
    outcome: "turn_failed" | "stream_ended_without_terminal" | "run_streamed_rejected";
  }): Promise<string> {
    await ensureCodexTurnTraceDir(this.#directory);
    let bridgeStderr = "";
    try {
      bridgeStderr = clipTail(
        await readFile(this.#bridgeStderrPath, "utf8"),
        MAX_STDERR_BYTES,
      );
    } catch {
      // The bridge is optional and may never have started for this turn.
    }
    const classification = classifyInterAgentError(
      input.detail === undefined ? {} : { detail: input.detail },
    );
    const path = join(this.#directory, `${this.traceId}.jsonl`);
    const line = JSON.stringify({
      trace_id: this.traceId,
      session_id: input.sessionId,
      turn_token: input.turnToken,
      outcome: input.outcome,
      stdout_jsonl_tail: this.#events,
      child: childStatus(input.detail),
      bridge_stderr_tail: bridgeStderr,
      wrapper_classification: classification,
    });
    await writeFile(path, `${line}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return path;
  }
}
