// Inactivity watchdog for one wrapper-fed Codex SDK turn.
//
// The timer starts only after the host has made a turn active. SDK output is
// the sole progress signal: server input and wrapper-local work do not keep a
// wedged Codex process alive.

import { performance } from "node:perf_hooks";

export const DEFAULT_TURN_WATCHDOG_INACTIVITY_MS = 30 * 60 * 1_000;
export const DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS = 60 * 1_000;
export const MIN_TURN_WATCHDOG_INACTIVITY_MS = 60 * 1_000;
export const MAX_TURN_WATCHDOG_DELAY_MS = 2_147_483_647;

export const TURN_WATCHDOG_INACTIVITY_ENV =
  "KAOIRO_CODEX_TURN_WATCHDOG_INACTIVITY_MS";
export const TURN_WATCHDOG_ABORT_GRACE_ENV =
  "KAOIRO_CODEX_TURN_WATCHDOG_ABORT_GRACE_MS";

export interface TurnWatchdogSettings {
  inactivityMs: number;
  abortGraceMs: number;
}

function readMilliseconds(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be an integer number of milliseconds`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer >= ${minimum} and <= ${maximum}`,
    );
  }
  return value;
}

export function readTurnWatchdogSettings(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
): TurnWatchdogSettings {
  const inactivityMs = readMilliseconds(
    env,
    TURN_WATCHDOG_INACTIVITY_ENV,
    DEFAULT_TURN_WATCHDOG_INACTIVITY_MS,
    MIN_TURN_WATCHDOG_INACTIVITY_MS,
    MAX_TURN_WATCHDOG_DELAY_MS,
  );
  const abortGraceMs = readMilliseconds(
    env,
    TURN_WATCHDOG_ABORT_GRACE_ENV,
    DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS,
    1,
    MAX_TURN_WATCHDOG_DELAY_MS,
  );
  if (inactivityMs < DEFAULT_TURN_WATCHDOG_INACTIVITY_MS) {
    warn(
      `[kaoiro] ${TURN_WATCHDOG_INACTIVITY_ENV}=${inactivityMs}ms is below ` +
        `the 30-minute default; choose the shorter inactivity value deliberately.\n`,
    );
  }
  return { inactivityMs, abortGraceMs };
}

export type TurnWatchdogWarning =
  | {
      kind: "inactivity_timeout";
      turnToken: string;
      idleMs: number;
      inactivityMs: number;
    }
  | { kind: "abort_grace_expired"; turnToken: string; abortGraceMs: number }
  | { kind: "interrupt_unavailable"; turnToken: string }
  | { kind: "fail_stop_unavailable"; turnToken: string }
  | {
      kind: "start_conflict";
      watchedTurnToken: string;
      startedTurnToken: string;
    };

export interface TurnWatchdogOptions {
  settings: TurnWatchdogSettings;
  onWarning: (warning: TurnWatchdogWarning) => void;
  requestInterrupt: (turnToken: string) => boolean;
  failStop: (turnToken: string) => boolean;
  failStopUnattributed: () => void;
  nowMs?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

interface WatchedTurn {
  turnToken: string;
  lastProgressAtMs: number;
  phase: "monitoring" | "interrupting" | "failed";
}

export class TurnWatchdog {
  readonly #settings: TurnWatchdogSettings;
  readonly #onWarning: (warning: TurnWatchdogWarning) => void;
  readonly #requestInterrupt: (turnToken: string) => boolean;
  readonly #failStop: (turnToken: string) => boolean;
  readonly #failStopUnattributed: () => void;
  readonly #nowMs: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  #watched: WatchedTurn | null = null;
  #timer: unknown | null = null;

  constructor(options: TurnWatchdogOptions) {
    this.#settings = options.settings;
    this.#onWarning = options.onWarning;
    this.#requestInterrupt = options.requestInterrupt;
    this.#failStop = options.failStop;
    this.#failStopUnattributed = options.failStopUnattributed;
    // Keep the Performance receiver bound. A bare performance.now reference
    // throws ERR_INVALID_THIS in Node when the default production seam runs.
    this.#nowMs = options.nowMs ?? (() => performance.now());
    this.#setTimer =
      options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as never));
  }

  start(turnToken: string): void {
    const watched = this.#watched;
    if (watched !== null) {
      if (watched.turnToken !== turnToken) {
        this.#onWarning({
          kind: "start_conflict",
          watchedTurnToken: watched.turnToken,
          startedTurnToken: turnToken,
        });
        this.#failClosed();
      }
      return;
    }
    this.#watched = {
      turnToken,
      lastProgressAtMs: this.#nowMs(),
      phase: "monitoring",
    };
    this.#arm(this.#settings.inactivityMs);
  }

  progress(turnToken: string): void {
    const watched = this.#watched;
    if (watched === null || watched.turnToken !== turnToken) return;
    if (watched.phase === "failed") return;
    watched.lastProgressAtMs = this.#nowMs();
    watched.phase = "monitoring";
    this.#arm(this.#settings.inactivityMs);
  }

  end(turnToken: string | undefined): void {
    if (turnToken === undefined || this.#watched?.turnToken !== turnToken) return;
    this.#watched = null;
    this.#disarm();
  }

  dispose(): void {
    this.#watched = null;
    this.#disarm();
  }

  #arm(delayMs: number): void {
    this.#disarm();
    this.#timer = this.#setTimer(() => this.#onTimer(), delayMs);
  }

  #disarm(): void {
    if (this.#timer === null) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
  }

  #onTimer(): void {
    this.#timer = null;
    const watched = this.#watched;
    if (watched === null || watched.phase === "failed") return;
    if (watched.phase === "monitoring") {
      const idleMs = this.#nowMs() - watched.lastProgressAtMs;
      if (idleMs < this.#settings.inactivityMs) {
        this.#arm(this.#settings.inactivityMs - idleMs);
        return;
      }
      watched.phase = "interrupting";
      this.#onWarning({
        kind: "inactivity_timeout",
        turnToken: watched.turnToken,
        idleMs,
        inactivityMs: this.#settings.inactivityMs,
      });
      if (!this.#requestInterrupt(watched.turnToken)) {
        this.#onWarning({
          kind: "interrupt_unavailable",
          turnToken: watched.turnToken,
        });
        this.#failClosed();
        return;
      }
      this.#arm(this.#settings.abortGraceMs);
      return;
    }

    watched.phase = "failed";
    this.#onWarning({
      kind: "abort_grace_expired",
      turnToken: watched.turnToken,
      abortGraceMs: this.#settings.abortGraceMs,
    });
    if (!this.#failStop(watched.turnToken)) {
      this.#onWarning({
        kind: "fail_stop_unavailable",
        turnToken: watched.turnToken,
      });
      this.#failClosed();
    }
  }

  #failClosed(): void {
    if (this.#watched !== null) this.#watched.phase = "failed";
    this.#disarm();
    this.#failStopUnattributed();
  }
}
