import { HistoryReplayer, writeRedactedStderr, type Envelope, type HydrationVerdict, type HistoryReplayerOptions } from "@kaoiro/agent-common";
import type { AppServerHistory } from "./app_server_history.js";
import { MAX_HISTORY } from "./history.js";

export type AppServerHistoryJob = (read: () => Promise<AppServerHistory>) => Promise<void>;
interface Options extends HistoryReplayerOptions {
  backend: () => "exec" | "app-server";
  schedule: (job: AppServerHistoryJob) => void;
  captureFence: () => () => boolean;
}
type Request = { verdict: HydrationVerdict | null; current: () => boolean };

/** Asynchronous preparation stays outside the shared, synchronous replay cycle. */
export class CodexHistoryReplay {
  readonly #options: Options;
  readonly #exec: HistoryReplayer;
  #ready = false;
  #closed = false;
  #latest: Request | undefined;
  #current: Request | undefined;
  #lastReplayId: string | undefined;
  #legacyHandled = false;
  #holding = false;
  #users: Envelope[] = [];

  constructor(options: Options) {
    this.#options = options;
    this.#exec = new HistoryReplayer(options);
  }

  onVerdict(verdict: HydrationVerdict | null): void {
    if (this.#closed) return;
    if (!this.#ready || this.#options.backend() === "exec") this.#exec.onVerdict(verdict);
    this.#latest = { verdict, current: this.#options.captureFence() };
    if (this.#ready && this.#options.backend() === "app-server") this.#schedule(this.#latest);
  }

  markReady(): void {
    if (this.#closed || this.#ready) return;
    this.#ready = true;
    if (this.#options.backend() === "exec") this.#exec.markReady();
    else if (this.#latest) this.#schedule(this.#latest);
  }

  sendLiveLog(envelope: Envelope): void {
    if (this.#closed) return;
    if (this.#holding && envelope.type === "log" && envelope.payload.kind === "user") {
      this.#users.push(envelope);
      if (this.#users.length > MAX_HISTORY) this.#users.shift();
    } else this.#options.sendEnvelope(envelope);
  }

  close(): void {
    this.#closed = true;
    this.#current = undefined;
    this.#users = [];
  }

  #releaseUsers(): void {
    this.#holding = false;
    const users = this.#users;this.#users = [];
    for (const envelope of users) this.#options.sendEnvelope(envelope);
  }

  #schedule(request: Request): void {
    const verdict = request.verdict;
    if (verdict === null) {
      if (this.#legacyHandled) return;
      this.#legacyHandled = true;
      if (!this.#options.legacyResumeSessionId) return;
    } else {
      if (!verdict.replay_required) {
        this.#current = undefined;this.#releaseUsers();return;
      }
      if (!verdict.replay_id) { this.#warn("invalid_verdict");return; }
      if (verdict.replay_id === this.#lastReplayId) return;
      this.#lastReplayId = verdict.replay_id;
    }
    this.#current = request;
    this.#options.schedule(async read => {
      if (this.#closed || this.#current !== request || !request.current()) return;
      this.#holding = true;
      try {
        const snapshot = await read();
        if (this.#closed || this.#current !== request || !request.current()) return;
        if (snapshot.coverage === "incomplete") {
          this.#warn(snapshot.reason ?? "invalid_response");return;
        }
        // full and tail both finish the bounded display window, not an archive.
        const replay = new HistoryReplayer({ ...this.#options, readTranscript: () => snapshot.logs });
        replay.onVerdict(verdict);replay.markReady();
      } finally {
        // A superseding read inherits user rows that its reset would otherwise erase.
        if (!this.#closed && this.#current === request && request.current()) this.#releaseUsers();
      }
    });
  }

  #warn(reason: string): void {
    const message = `codex history_unavailable: ${reason}; retry requires a new hydration verdict`;
    if (this.#options.warn) this.#options.warn(message);
    else writeRedactedStderr(`${message}\n`);
  }
}
