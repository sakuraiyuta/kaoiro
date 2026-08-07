// IA sidecar — the wrapper-host record of structured inter-agent messages
// (ADR-0051 D3-2 / D3-5, specs/protocol-inter-agent.md「IA sidecar と表示
// 復元」). The server keeps only a volatile projection of these; the file
// written here is what a restarted server is rebuilt from, so it has to
// survive the wrapper process, not the session.
//
// Layout:
//   - bound:   <engine transcript dir>/<session-id>.ia.jsonl
//   - pending: ${KAOIRO_IA_PENDING_DIR:-~/.kaoiro/ia-pending}/
//              <agent_id>__<generation>.ia.jsonl
//
// The pending journal exists because a fresh wrapper has no session_id until
// its first turn while IA can already arrive. It does NOT live beside the
// transcript: codex's rollout directory is date-nested and cannot be resolved
// before the session exists. `{agent_id, generation}` namespaces it so two
// wrappers in the same cwd — or a relaunch after a rollback — cannot write
// into each other's journal.
//
// Durability is deliberately best-effort (D7 (e)): no fsync, a truncated
// tail line is skipped with a warning rather than failing the replay, and a
// lost send-side ack simply means that message is not restorable. The
// alternative — blocking a turn on disk — costs more than the loss.

import { appendFileSync, closeSync, constants, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Envelope } from "./types.js";

/** One sidecar line. `ingress_stamp` is the server's ordering-domain value
 *  ([us, seq], protocol.md), stored verbatim: it is the only thing that can
 *  place a restored message against a `ClearWatermarks` cutoff, and a
 *  wrapper-side clock cannot substitute for it. */
export interface SidecarRecord {
  ingress_stamp: [number, number];
  envelope: Envelope;
}

/** Mirrors the server's per-pane projection cap (ADR-0051 D6). Replaying
 *  more could only ever be discarded on arrival. */
const MAX_REPLAY_RECORDS = 200;

/** Same charset the engines allow in a transcript filename. A session_id
 *  reaches us over the wire, so it is validated before it becomes a path
 *  component. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

const PENDING_SUFFIX = ".ia.jsonl";

export function isValidSidecarSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

/** Keeps an id usable as a single path component. agent_id and
 *  transition_id are server-minted, but neither is worth trusting with a
 *  path separator. */
function sanitizeComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function defaultPendingDir(): string {
  return (
    process.env.KAOIRO_IA_PENDING_DIR ?? join(homedir(), ".kaoiro", "ia-pending")
  );
}

export interface IaSidecarOptions {
  agentId: string;
  /** Namespaces the pending journal against a concurrent / previous
   *  generation of the same agent. The launch-time `transition_id` is the
   *  natural value; callers without one must pass a per-process id. */
  generation: string;
  /** Engine-specific: absolute sidecar path for a bound session, or null
   *  when the transcript directory cannot be resolved yet. */
  resolveSessionPath: (sessionId: string) => string | null;
  pendingDir?: string;
  warn?: (message: string) => void;
}

export class IaSidecar {
  readonly #agentId: string;
  readonly #resolveSessionPath: (sessionId: string) => string | null;
  readonly #pendingDir: string;
  readonly #pendingPath: string;
  readonly #warn: (message: string) => void;
  #path: string;
  #boundSessionId: string | null = null;

  constructor(options: IaSidecarOptions) {
    this.#agentId = options.agentId;
    this.#resolveSessionPath = options.resolveSessionPath;
    this.#pendingDir = options.pendingDir ?? defaultPendingDir();
    this.#warn =
      options.warn ?? ((message) => process.stderr.write(`${message}\n`));
    this.#pendingPath = join(
      this.#pendingDir,
      `${sanitizeComponent(options.agentId)}__${sanitizeComponent(options.generation)}${PENDING_SUFFIX}`,
    );
    this.#path = this.#pendingPath;
    this.#collectOrphanJournals();
  }

  /** Where appends currently land — the pending journal until a session is
   *  bound. Exposed for tests and for the stderr breadcrumbs. */
  path(): string {
    return this.#path;
  }

  /** Records one delivered / accepted inter-agent message. Never throws:
   *  a failed append costs one unrestorable bubble, and letting it escape
   *  would take down a turn instead. */
  append(record: SidecarRecord): void {
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (err) {
      this.#warn(`ia sidecar: unserializable record dropped: ${String(err)}`);
      return;
    }
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      // O_NOFOLLOW: the sidecar path is fixed by the engine's transcript
      // layout, so a symlink there is someone else's doing, not ours.
      const fd = openSync(
        this.#path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.#warn(`ia sidecar: append failed (${this.#path}): ${String(err)}`);
    }
  }

  /** Points the sidecar at `sessionId`'s file and carries anything already
   *  written across (ADR-0051 D3-5 bind). Also covers a mid-session id
   *  change: replay only ever reads the CURRENT session, so leaving the
   *  rows under the old id would silently drop the running conversation. */
  bind(sessionId: string): void {
    if (this.#boundSessionId === sessionId) return;
    if (!isValidSidecarSessionId(sessionId)) {
      this.#warn(`ia sidecar: refusing to bind malformed session_id`);
      return;
    }
    const target = this.#resolveSessionPath(sessionId);
    if (target === null) {
      // The transcript directory is not resolvable yet (codex resolves the
      // rollout lazily). Keep appending to the current file and retry on
      // the next report rather than losing the rows.
      return;
    }
    if (target === this.#path) {
      this.#boundSessionId = sessionId;
      return;
    }
    this.#move(this.#path, target);
    this.#path = target;
    this.#boundSessionId = sessionId;
  }

  /** Reads back what this generation recorded, newest-last and capped.
   *  Malformed / truncated lines are skipped with a warning so one bad tail
   *  cannot stop the rest of the timeline from being restored (D3-2). */
  read(): SidecarRecord[] {
    let text: string;
    try {
      const fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        text = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return [];
    }

    const records: SidecarRecord[] = [];
    let skipped = 0;
    for (const raw of text.split("\n")) {
      if (raw.trim() === "") continue;
      const record = parseSidecarLine(raw);
      if (record === null) {
        skipped += 1;
        continue;
      }
      records.push(record);
    }
    if (skipped > 0) {
      this.#warn(
        `ia sidecar: skipped ${skipped} unreadable line(s) in ${this.#path}`,
      );
    }
    return records.length > MAX_REPLAY_RECORDS
      ? records.slice(-MAX_REPLAY_RECORDS)
      : records;
  }

  #move(from: string, to: string): void {
    let content: string;
    try {
      content = readFileSync(from, "utf8");
    } catch {
      // Nothing recorded yet; the next append creates the target.
      return;
    }
    try {
      mkdirSync(dirname(to), { recursive: true });
      let exists = true;
      try {
        statSync(to);
      } catch {
        exists = false;
      }
      if (exists) {
        // A resume onto a session that already has a sidecar: append rather
        // than clobber, and let the server's stamp identity dedupe.
        appendFileSync(to, content, { mode: 0o600 });
        rmSync(from, { force: true });
      } else {
        renameSync(from, to);
      }
    } catch (err) {
      this.#warn(`ia sidecar: bind ${from} -> ${to} failed: ${String(err)}`);
    }
  }

  /** Removes this agent's pending journals from previous generations
   *  (ADR-0051 D3-5 GC). A journal that never got bound belongs to a run
   *  that crashed before its session existed; replaying it would attach the
   *  rows to whatever session happens to come next, so it fails closed and
   *  is dropped. Only this agent's own files are touched. */
  #collectOrphanJournals(): void {
    let names: string[];
    try {
      names = readdirSync(this.#pendingDir);
    } catch {
      return;
    }
    const prefix = `${sanitizeComponent(this.#agentId)}__`;
    const keep = this.#pendingPath;
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(PENDING_SUFFIX)) continue;
      const path = join(this.#pendingDir, name);
      if (path === keep) continue;
      try {
        rmSync(path, { force: true });
      } catch (err) {
        this.#warn(`ia sidecar: orphan journal cleanup failed: ${String(err)}`);
      }
    }
  }
}

/** Structural narrow of one persisted line. Anything that does not carry a
 *  well-formed `[us, seq]` stamp is unusable — the server drops stampless
 *  rows fail-closed (D3-4), so sending them would only waste a round trip. */
export function parseSidecarLine(raw: string): SidecarRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { ingress_stamp: stamp, envelope } = parsed as {
    ingress_stamp?: unknown;
    envelope?: unknown;
  };
  if (!isIngressStamp(stamp)) return null;
  if (typeof envelope !== "object" || envelope === null) return null;
  if ((envelope as { type?: unknown }).type !== "inter_agent_message") {
    return null;
  }
  return { ingress_stamp: stamp, envelope: envelope as Envelope };
}

/** The wire form of the server's ordering tuple: exactly two integers. */
export function isIngressStamp(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isSafeInteger(value[0]) &&
    Number.isSafeInteger(value[1])
  );
}
