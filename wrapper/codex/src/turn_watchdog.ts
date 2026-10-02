// Inactivity watchdog for one wrapper-fed Codex SDK turn.
//
// The timer starts only after the host has made a turn active. SDK output is
// the sole progress signal: server input and wrapper-local work do not keep a
// wedged Codex process alive.

import { performance } from "node:perf_hooks";
import {
  readDigitsMs,
  resolveDigitsMs,
  type SettingSource,
} from "@kaoiro/wrapper-core";

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

/** The runner-relayed values (WrapperConfig fields), when present. */
export interface TurnWatchdogConfigValues {
  turn_watchdog_inactivity_ms?: number;
  turn_watchdog_abort_grace_ms?: number;
}

export interface ResolvedTurnWatchdog {
  settings: TurnWatchdogSettings;
  sources: { inactivityMs: SettingSource; abortGraceMs: SettingSource };
}

/** Resolves each value as config field, then the environment variable, then
 *  the default (issue #469). Returning the sources with the settings lets the
 *  startup line report exactly what the watchdog is given. */
export function resolveTurnWatchdogSettings(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
  config?: TurnWatchdogConfigValues,
): ResolvedTurnWatchdog {
  const inactivity = resolveDigitsMs(
    env,
    TURN_WATCHDOG_INACTIVITY_ENV,
    config?.turn_watchdog_inactivity_ms,
    DEFAULT_TURN_WATCHDOG_INACTIVITY_MS,
    MIN_TURN_WATCHDOG_INACTIVITY_MS,
    MAX_TURN_WATCHDOG_DELAY_MS,
  );
  const abortGrace = resolveDigitsMs(
    env,
    TURN_WATCHDOG_ABORT_GRACE_ENV,
    config?.turn_watchdog_abort_grace_ms,
    DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS,
    1,
    MAX_TURN_WATCHDOG_DELAY_MS,
  );
  if (inactivity.value < DEFAULT_TURN_WATCHDOG_INACTIVITY_MS) {
    const name =
      inactivity.source === "config"
        ? "turn_watchdog_inactivity_ms"
        : TURN_WATCHDOG_INACTIVITY_ENV;
    warn(
      `[kaoiro] ${name}=${inactivity.value}ms is below ` +
        `the 30-minute default; choose the shorter inactivity value deliberately.\n`,
    );
  }
  return {
    settings: {
      inactivityMs: inactivity.value,
      abortGraceMs: abortGrace.value,
    },
    sources: {
      inactivityMs: inactivity.source,
      abortGraceMs: abortGrace.source,
    },
  };
}

export function readTurnWatchdogSettings(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
  config?: TurnWatchdogConfigValues,
): TurnWatchdogSettings {
  return resolveTurnWatchdogSettings(env, warn, config).settings;
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
