// Hydration handshake driver (ADR-0051 D2, specs/protocol.md「投影
// hydration と再起動耐性」). The server decides whether its display
// projection for this agent needs rebuilding and says so in the wrapper
// channel's JOIN REPLY; this class turns that verdict into the
// `history_reset` → transcript → `replay_ia` → `history_replay_complete`
// sequence, once.
//
// Why the server decides: an unconditional startup replay and "hydrated
// means no wasted replay" cannot both hold, because the wrapper has no way
// to know in advance whether the server still holds its transcript. The
// server does, so it leads — and it allocates the `replay_id` so the reset,
// the restored IA and the completion boundary can never disagree about
// which attempt they belong to.

import type { Envelope } from "./types.js";
import type { SidecarRecord } from "./ia_sidecar.js";

/** Join-reply verdict. `null` means the reply carried no `hydration` key at
 *  all — an old server, where the wrapper falls back to its previous
 *  startup-replay behaviour. */
export interface HydrationVerdict {
  replay_required: boolean;
  replay_id?: string;
}

export interface HistoryReplayerOptions {
  /** Re-announce the agent's latest state. `history_reset` / the replayed
   *  envelopes are all no-ops on the server until it has an AgentStates
   *  entry to attach them to, and after a server restart it has none. */
  seedState: () => void;
  /** The session whose transcript should be replayed, or null when none has
   *  been assigned yet (a fresh wrapper before its first turn). */
  sessionId: () => string | null;
  /** Engine-specific transcript → display `log` envelopes. */
  readTranscript: (sessionId: string) => Envelope[];
  /** This generation's recorded inter-agent messages. */
  readSidecar: () => SidecarRecord[];
  sendHistoryReset: (replayId: string) => void;
  sendEnvelope: (envelope: Envelope) => void;
  sendReplayIa: (replayId: string, items: SidecarRecord[]) => void;
  sendHistoryReplayComplete: (replayId: string) => void;
  /** Session to replay when talking to a legacy server (the `--resume`
   *  target). Absent = the pre-ADR-0051 wrapper would not have replayed
   *  either, so neither does this one. */
  legacyResumeSessionId?: string;
  warn?: (message: string) => void;
}

export class HistoryReplayer {
  readonly #options: HistoryReplayerOptions;
  /** Verdicts can land before the wrapper can act on one: the join reply
   *  arrives while the CLI is still awaiting `persona_prompt` and building
   *  its host, and `seedState` needs that host. Hold the latest verdict
   *  until `markReady()`. */
  #ready = false;
  #pendingReplayId: string | null = null;
  #legacyStartupHandled = false;
  #running = false;

  constructor(options: HistoryReplayerOptions) {
    this.#options = options;
  }

  /** Feeds one join reply's verdict. Safe to call on every (re)join. */
  onVerdict(verdict: HydrationVerdict | null): void {
    if (verdict === null) {
      this.#onLegacyVerdict();
      return;
    }
    if (!verdict.replay_required) return;
    const replayId = verdict.replay_id;
    if (typeof replayId !== "string" || replayId === "") {
      this.#warn(
        "hydration: server asked for a replay without a replay_id; skipping",
      );
      return;
    }
    this.#pendingReplayId = replayId;
    this.#flush();
  }

  /** The wrapper has a live host and has announced a state, so a replay can
   *  now be attached to something. Runs a verdict that arrived earlier. */
  markReady(): void {
    this.#ready = true;
    this.#flush();
  }

  #onLegacyVerdict(): void {
    // Only the first join falls back: a legacy server's reconnect never
    // replayed before ADR-0051 either, and replaying on every reconnect
    // would be a behaviour change aimed at a server that cannot use it.
    if (this.#legacyStartupHandled) return;
    this.#legacyStartupHandled = true;
    const sessionId = this.#options.legacyResumeSessionId;
    if (sessionId === undefined || sessionId === "") return;
    this.#pendingReplayId = `resume-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.#flush();
  }

  #flush(): void {
    if (!this.#ready || this.#running) return;
    const replayId = this.#pendingReplayId;
    if (replayId === null) return;
    this.#pendingReplayId = null;
    this.#running = true;
    try {
      this.#run(replayId);
    } finally {
      this.#running = false;
    }
  }

  #run(replayId: string): void {
    this.#options.seedState();

    const sessionId = this.#options.sessionId();
    const transcript =
      sessionId === null ? [] : this.#readTranscript(sessionId);
    const sidecar = this.#readSidecar();

    // Reset first — unconditionally — so a server still holding this
    // session's pre-restart lines is overwritten rather than appended to,
    // even when both sources turn out empty (a fresh session's empty
    // replay is what marks it hydrated).
    this.#options.sendHistoryReset(replayId);
    for (const envelope of transcript) this.#options.sendEnvelope(envelope);
    if (sidecar.length > 0) {
      this.#options.sendReplayIa(replayId, sidecar);
    }
    this.#options.sendHistoryReplayComplete(replayId);
  }

  // Reading either source is filesystem work on someone else's files. A
  // failure means "restore less", never "abort the replay" — the completion
  // boundary still has to be sent or the server stays unhydrated forever.
  #readTranscript(sessionId: string): Envelope[] {
    try {
      return this.#options.readTranscript(sessionId);
    } catch (err) {
      this.#warn(`hydration: transcript read failed: ${String(err)}`);
      return [];
    }
  }

  #readSidecar(): SidecarRecord[] {
    try {
      return this.#options.readSidecar();
    } catch (err) {
      this.#warn(`hydration: sidecar read failed: ${String(err)}`);
      return [];
    }
  }

  #warn(message: string): void {
    if (this.#options.warn) {
      this.#options.warn(message);
      return;
    }
    process.stderr.write(`${message}\n`);
  }
}
