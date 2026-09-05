// Failure-only, local diagnostics for Codex turn termination. This is not a
// transcript or a peer-facing error channel: it preserves a bounded, safe
// event shape without letting subprocess/bridge text enter peer notices.

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { classifyInterAgentError } from "@kaoiro/agent-common";

const MAX_EVENTS = 24;
const MAX_STDERR_BYTES = 8192;
const MAX_TRACE_FILES = 20;
const MAX_CAPTURE_DIRECTORIES = 20;

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

/** A host-private directory. The stable hashed agent segment helps operators
 * group traces without placing an arbitrary agent_id in a filesystem path. */
export function codexTurnTraceCaptureDir(
  baseDirectory: string,
  agentId: string,
  captureId: string,
): string {
  const agentKey = createHash("sha256").update(agentId).digest("hex").slice(0, 16);
  return join(baseDirectory, "agents", agentKey, captureId);
}

/** Retains a bounded number of former host-private capture directories for
 * one agent. The current host has a new capture id, so startup may prune its
 * predecessors before this host first writes diagnostics. */
export async function pruneCodexTurnTraceCaptureDirs(
  baseDirectory: string,
  agentId: string,
): Promise<void> {
  const agentKey = createHash("sha256").update(agentId).digest("hex").slice(0, 16);
  const agentDirectory = join(baseDirectory, "agents", agentKey);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(agentDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const captures = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(agentDirectory, entry.name);
        try {
          return { path, mtimeMs: (await stat(path)).mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  const stale = captures
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(MAX_CAPTURE_DIRECTORIES);
  await Promise.all(stale.map(({ path }) => rm(path, { recursive: true, force: true })));
}

/** Creates or repairs the exact private capture directory. `mkdir`'s mode is
 * ignored for an existing inode, so chmod is deliberately unconditional. */
export async function ensureCodexTurnTraceDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

/** Keeps the LAST `maxBytes` UTF-8 bytes of `value` (a cut may land
 *  mid-codepoint; toString renders the partial byte as U+FFFD). Exported
 *  for reuse by adapter.ts's operator-facing stderr-tail extraction
 *  (issue #300) -- same byte-safe tail-take, different consumer; this
 *  file's own trace output stays host-private regardless of who else
 *  calls this helper. */
export function clipTail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maxBytes
    ? value
    : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function errorCode(detail: unknown): string | null {
  if (typeof detail !== "string") return null;
  try {
    return classifyInterAgentError({ detail }).code;
  } catch {
    return null;
  }
}

function semanticItem(item: unknown): Record<string, unknown> {
  if (!isRecord(item)) return { item_type: "malformed" };
  const itemType = stringOrNull(item.type) ?? "malformed";
  const base = { item_type: itemType, item_id: stringOrNull(item.id) };
  switch (itemType) {
    case "command_execution":
      return {
        ...base,
        status: stringOrNull(item.status),
        exit_code: typeof item.exit_code === "number" ? item.exit_code : null,
      };
    case "file_change":
      return { ...base, status: stringOrNull(item.status) };
    case "mcp_tool_call":
      return {
        ...base,
        status: stringOrNull(item.status),
        server: stringOrNull(item.server),
        tool: stringOrNull(item.tool),
        error_code: errorCode(
          isRecord(item.error) ? item.error.message : undefined,
        ),
      };
    case "todo_list":
      return {
        ...base,
        item_count: Array.isArray(item.items) ? item.items.length : null,
      };
    case "error":
      return {
        ...base,
        error_code: errorCode(item.message),
      };
    default:
      // agent_message/reasoning deliberately omit text; web_search omits its
      // query; no semantic trace may retain model or tool input/output.
      return base;
  }
}

/** A deliberately minimized view of stdout JSONL. It has event/item kind and
 * status useful for failure ordering, but never command/query/text/arguments,
 * MCP result, error message, path, or token-bearing payload. */
function semanticEvent(event: unknown): Record<string, unknown> {
  if (!isRecord(event) || typeof event.type !== "string") {
    return { type: "malformed_event" };
  }
  switch (event.type) {
    case "turn.failed":
      return {
        type: event.type,
        error_code: errorCode(
          isRecord(event.error) ? event.error.message : undefined,
        ),
      };
    case "error":
      return {
        type: event.type,
        error_code: errorCode(event.message),
      };
    case "item.started":
    case "item.updated":
    case "item.completed":
      return { type: event.type, ...semanticItem(event.item) };
    default:
      return { type: event.type };
  }
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

async function pruneTraceFiles(directory: string): Promise<void> {
  const candidates = await Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const path = join(directory, name);
        try {
          return { path, mtimeMs: (await stat(path)).mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  const stale = candidates
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, Math.max(0, candidates.length - (MAX_TRACE_FILES - 1)));
  await Promise.all(stale.map(({ path }) => unlink(path).catch(() => {})));
}

/** One trace is created per host turn, but it writes only when that turn
 * ends abnormally. The directory must already be host-private; `traceId` is
 * retained for correlation with the bridge's per-host stderr capture. */
export class CodexTurnDiagnostics {
  readonly traceId = randomUUID();
  readonly #directory: string;
  readonly #bridgeStderrPath: string;
  readonly #events: Record<string, unknown>[] = [];

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

  recordEvent(event: unknown): void {
    let semantic: Record<string, unknown> = { type: "malformed_event" };
    try {
      semantic = semanticEvent(event);
    } catch {
      // Diagnostic capture must never turn an SDK shape regression into a
      // wrapper failure. The fallback has no untrusted event payload.
    }
    this.#events.push(semantic);
    if (this.#events.length > MAX_EVENTS) this.#events.shift();
  }

  /** Starts a fresh bridge-stderr capture window for this serial host turn.
   * The bridge receives this host-private path from the host config. */
  async begin(): Promise<void> {
    await ensureCodexTurnTraceDir(this.#directory);
    await writeFile(
      this.#bridgeStderrPath,
      `[kaoiro trace_id=${this.traceId}]\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    // writeFile does not change mode when it truncates an existing inode.
    await chmod(this.#bridgeStderrPath, 0o600);
  }

  async writeFailure(input: {
    sessionId: string | null;
    turnToken: string;
    conversationIds: readonly string[];
    detail?: string;
    outcome: "turn_failed" | "stream_ended_without_terminal" | "run_streamed_rejected";
  }): Promise<string> {
    await ensureCodexTurnTraceDir(this.#directory);
    await pruneTraceFiles(this.#directory);
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
      captured_at: new Date().toISOString(),
      session_id: input.sessionId,
      turn_token: input.turnToken,
      conversation_ids: input.conversationIds,
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
