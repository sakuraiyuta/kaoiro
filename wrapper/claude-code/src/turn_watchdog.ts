// Inactivity watchdog for one wrapper-fed Claude SDK turn (issue #238).
//
// This is deliberately not a wall-clock turn limit. AgentHost starts it only
// after #input() has made a token active, and every SDK output frame for that
// active token resets it. A queued SDK input therefore spends no watchdog
// budget while it is waiting behind an earlier turn.

import { performance } from "node:perf_hooks";
import {
  readDigitsMs,
  resolveDigitsMs,
  type SettingSource,
} from "@kaoiro/wrapper-core";

export const DEFAULT_TURN_WATCHDOG_INACTIVITY_MS = 30 * 60 * 1_000;
export const DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS = 60 * 1_000;
export const MIN_TURN_WATCHDOG_INACTIVITY_MS = 60 * 1_000;
/** Node clamps a larger setTimeout delay to 1ms. Reject rather than turning a
 * deliberately long operational timeout into a tight loop or instant abort. */
export const MAX_TURN_WATCHDOG_DELAY_MS = 2_147_483_647;

export const TURN_WATCHDOG_INACTIVITY_ENV =
  "KAOIRO_CLAUDE_TURN_WATCHDOG_INACTIVITY_MS";
export const TURN_WATCHDOG_ABORT_GRACE_ENV =
  "KAOIRO_CLAUDE_TURN_WATCHDOG_ABORT_GRACE_MS";

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
        `the 30-minute default. commit e97e708 removed a max_wallclock ` +
        `limit because short limits preferentially kill normal xhigh turns; ` +
        `this is an inactivity watchdog, but choose the shorter value deliberately.\n`,
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
  | {
      kind: "abort_grace_expired";
      turnToken: string;
      abortGraceMs: number;
    }
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
  /** Must synchronously verify that this exact token is still host-active,
   * then request the SDK interrupt. It is not a terminal acknowledgement. */
  requestInterrupt: (turnToken: string) => boolean;
  /** Marks the host admission-closed. It must not settle an unknown active
   * token; operator recovery owns that uncertain outcome. */
  failStop: (turnToken: string) => boolean;
  /** Mandatory fallback for any correlation invariant failure. It closes
   * admission using the host's CURRENT active token if known, rather than
   * guessing that the stale watched token still owns the SDK stream. */
  failStopUnattributed: () => void;
  /** Monotonic elapsed-time source; wall-clock changes must not postpone
   * liveness recovery. */
  nowMs?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

interface WatchedTurn {
  turnToken: string;
  lastProgressAtMs: number;
  phase: "monitoring" | "interrupting" | "failed";
}

/** Owns one active token's inactivity timer. The host's input barrier makes
 * overlap impossible; a duplicate start for the same token is a no-op, while
 * a different token is an attribution invariant violation and fail-stops
 * admission rather than replacing the ownership record. */
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
    // Performance#now validates its receiver in Node. Keeping the bare
    // method here made the first production start() throw ERR_INVALID_THIS;
    // retain the Performance receiver inside a closure (issue #239).
    this.#nowMs = options.nowMs ?? (() => performance.now());
    this.#setTimer =
      options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as never));
  }

  /** Starts timing only after AgentHost has made this token SDK-active. */
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

  /** One received SDK output frame is meaningful liveness evidence. Server
   * instructions and local timers never call this method. If output resumes
   * after an interrupt request, return to ordinary inactivity monitoring. */
  progress(turnToken: string): void {
    const watched = this.#watched;
    if (watched === null || watched.turnToken !== turnToken) return;
    // A late SDK frame is still consumed by AgentHost for exact terminal
    // attribution, but it must not resurrect a fail-stopped watchdog.
    if (watched.phase === "failed") return;
    watched.lastProgressAtMs = this.#nowMs();
    watched.phase = "monitoring";
    this.#arm(this.#settings.inactivityMs);
  }

  /** A ResultMessage or token-scoped abort has made the exact outcome known. */
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

  /** A stale/missing exact token is not evidence that it is safe to continue.
   * Preserve the recorded failed phase and irreversibly close admission via
   * the host's actual current token (if one exists). */
  #failClosed(): void {
    if (this.#watched !== null) this.#watched.phase = "failed";
    this.#disarm();
    this.#failStopUnattributed();
  }
}
