import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { WrapperConfig } from "@kaoiro/protocol";

export const RECOVERY_CHECKPOINT_UNAVAILABLE_EXIT_CODE = 79;
export type RecoveryBlockReason = "watchdog" | "session_binding" | "resume_rejected" | "session_unusable" | "checkpoint_unavailable";
export type RecoveryRecord = { version: 1 } & (
  | { state: "initial" }
  | { state: "unbound"; candidate_id?: string }
  | { state: "live"; session_id: string }
  | { state: "blocked"; reason: RecoveryBlockReason; session_id?: string }
);
export type RecoverySnapshot = { ok: true; record: RecoveryRecord } | { ok: false; reason: "unreadable" | "invalid" };
const reasons: readonly string[] = ["watchdog", "session_binding", "resume_rejected", "session_unusable", "checkpoint_unavailable"];
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function readRecoveryCheckpoint(path: string): RecoverySnapshot {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch { return { ok: false, reason: "unreadable" }; }
  try {
    const record: unknown = JSON.parse(raw);
    if (record === null || typeof record !== "object") throw new Error();
    const r = record as Record<string, unknown>;
    if (r.version !== 1) throw new Error();
    switch (r.state) {
      case "initial": break;
      case "unbound": if (r.candidate_id !== undefined && !nonempty(r.candidate_id)) throw new Error(); break;
      case "live": if (!nonempty(r.session_id)) throw new Error(); break;
      case "blocked":
        if (!reasons.includes(String(r.reason)) || (r.session_id !== undefined && !nonempty(r.session_id))) throw new Error();
        break;
      default: throw new Error();
    }
    return { ok: true, record: record as RecoveryRecord };
  } catch { return { ok: false, reason: "invalid" }; }
}

export function writeRecoveryCheckpoint(path: string, record: RecoveryRecord): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export class RecoveryFailure extends Error {
  constructor(readonly exitCode: number, readonly reason: string) {
    super(`wrapper recovery stopped: ${reason}`);
  }
}

export function recoveryExitCode(error: unknown): number {
  return process.exitCode === 79 ? 79 : error instanceof RecoveryFailure ? error.exitCode : 1;
}

export async function shutdownForRecovery(failure: RecoveryFailure,
  closeHost: () => void | Promise<void>, disconnect: () => void | Promise<unknown>, closeLink: () => void): Promise<void> {
  process.exitCode = failure.exitCode;
  const deadline = setTimeout(() => process.exit(recoveryExitCode(failure)), 10_000);
  deadline.unref();
  let closing: void | Promise<void> = undefined;
  try { closing = closeHost(); } catch { /* Disconnect still closes admission to the server. */ }
  try {
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([disconnect(), new Promise<void>(resolve => {
        flushTimer = setTimeout(resolve, 1_000); flushTimer.unref();
      })]);
    } finally { if (flushTimer !== undefined) clearTimeout(flushTimer); }
  } finally { closeLink(); }
  await closing;
}

/** Identity publication is separate from successful attachment: error frames
 * can echo a requested id, and a fresh native id may not yet be resumable. */
export class RecoveryReporter {
  #record: RecoveryRecord = { version: 1, state: "unbound" };
  #failure: RecoveryFailure | undefined;
  readonly #path: string | undefined;
  constructor(config: WrapperConfig, readonly requestedId: string | undefined,
    readonly onFailure: (failure: RecoveryFailure) => void) {
    this.#path = config.recovery_checkpoint_path;
    if (config.recovery_resume_kind === "candidate" && requestedId !== undefined)
      this.#record = { version: 1, state: "unbound", candidate_id: requestedId };
    this.launchKind = config.recovery_resume_kind;
    this.#write(this.#record);
  }
  readonly launchKind: "candidate" | undefined;
  get failure(): RecoveryFailure | undefined { return this.#failure; }
  get active(): boolean { return this.#path !== undefined; }
  #write(record: RecoveryRecord): boolean {
    if (this.#failure || this.#record.state === "blocked") return false;
    try {
      if (this.#path !== undefined) writeRecoveryCheckpoint(this.#path, record);
      this.#record = record;
      return true;
    } catch { this.#fail(79, "checkpoint_unavailable"); return false; }
  }
  #fail(code: number, reason: string): void {
    if (this.#failure?.exitCode === 79) return;
    this.#failure = new RecoveryFailure(code, reason);
    this.onFailure(this.#failure);
  }
  observe(id: string): boolean {
    if (!this.active) return true;
    if (this.#failure || this.#record.state === "blocked") return false;
    if (this.#record.state === "live" && this.#record.session_id === id) return true;
    return this.#write({ version: 1, state: "unbound", candidate_id: id });
  }
  confirm(id: string): boolean {
    if (!this.active) return true;
    if (this.#record.state === "live" && this.#record.session_id === id) return !this.#failure;
    if (this.#record.state === "unbound" && this.#record.candidate_id !== undefined && this.#record.candidate_id !== id) return false;
    return this.#write({ version: 1, state: "live", session_id: id });
  }
  accept(id: string, expected?: string): boolean {
    if (!this.active) return true;
    if (expected !== undefined && id !== expected) {
      const candidate = this.#record.state === "unbound" && this.#record.candidate_id === expected;
      if (candidate) this.#fallback();
      else { this.block("session_binding"); this.#fail(this.#failure?.exitCode ?? 1, "session_binding"); }
      return false;
    }
    return expected === undefined ? this.observe(id) : this.confirm(id);
  }
  refuseLaunch(): void {
    if (!this.active) return;
    if (this.launchKind === "candidate") this.#fallback();
    else { this.block("resume_rejected"); this.#fail(this.#failure?.exitCode ?? 1, "resume_rejected"); }
  }
  #fallback(): void {
    if (this.#write({ version: 1, state: "unbound" })) this.#fail(1, "candidate_attach_unavailable");
  }
  block(reason: RecoveryBlockReason): void {
    if (!this.active) return;
    const id = this.#record.state === "live" ? this.#record.session_id
      : this.#record.state === "unbound" ? this.#record.candidate_id : undefined;
    this.#write({ version: 1, state: "blocked", reason, ...(id === undefined ? {} : { session_id: id }) });
  }
}
