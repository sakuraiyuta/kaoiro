import { performance } from "node:perf_hooks";

export const DEFAULT_TURN_WATCHDOG_INACTIVITY_MS = 30 * 60 * 1_000;
export const DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS = 60 * 1_000;
// Matches the Bash tool ceiling of the Claude Code engine, so the same git
// command is bounded alike on every engine (issue #350).
export const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60 * 1_000;
export const MIN_TURN_WATCHDOG_INACTIVITY_MS = 60 * 1_000;
export const MIN_TOOL_TIMEOUT_MS = 1_000;
export const MAX_TURN_WATCHDOG_DELAY_MS = 2_147_483_647;
export const TURN_WATCHDOG_INACTIVITY_ENV =
  "KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_INACTIVITY_MS";
export const TURN_WATCHDOG_ABORT_GRACE_ENV =
  "KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_ABORT_GRACE_MS";
export const TOOL_TIMEOUT_ENV = "KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS";

export interface TurnWatchdogSettings {
  inactivityMs: number;
  abortGraceMs: number;
  /** Absolute wall-clock bound from a tool step's ACTIVE to its DONE/ERROR.
   *  Stream progress never extends it. */
  toolTimeoutMs: number;
}

function readMilliseconds(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer number of milliseconds`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_TURN_WATCHDOG_DELAY_MS) {
    throw new Error(`${name} must be an integer >= ${minimum} and <= ${MAX_TURN_WATCHDOG_DELAY_MS}`);
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
  );
  const abortGraceMs = readMilliseconds(
    env,
    TURN_WATCHDOG_ABORT_GRACE_ENV,
    DEFAULT_TURN_WATCHDOG_ABORT_GRACE_MS,
    1,
  );
  const toolTimeoutMs = readMilliseconds(
    env,
    TOOL_TIMEOUT_ENV,
    DEFAULT_TOOL_TIMEOUT_MS,
    MIN_TOOL_TIMEOUT_MS,
  );
  if (inactivityMs < DEFAULT_TURN_WATCHDOG_INACTIVITY_MS) {
    warn(`[kaoiro] ${TURN_WATCHDOG_INACTIVITY_ENV}=${inactivityMs}ms is below the 30-minute default; choose the shorter inactivity value deliberately.\n`);
  }
  return { inactivityMs, abortGraceMs, toolTimeoutMs };
}

export interface ToolTimeoutInfo {
  stepIndex: number;
  toolName: string;
  elapsedMs: number;
  toolTimeoutMs: number;
}

export type TurnWatchdogInterruptCause =
  | { kind: "inactivity"; idleMs: number }
  | ({ kind: "tool_timeout" } & ToolTimeoutInfo);

export type TurnWatchdogWarning =
  | { kind: "inactivity_timeout"; turnToken: string; idleMs: number; inactivityMs: number }
  | ({ kind: "tool_timeout"; turnToken: string } & ToolTimeoutInfo)
  | { kind: "abort_grace_expired"; turnToken: string; abortGraceMs: number }
  | { kind: "interrupt_unavailable"; turnToken: string }
  | { kind: "fail_stop_unavailable"; turnToken: string }
  | { kind: "start_conflict"; watchedTurnToken: string; startedTurnToken: string };

export interface TurnWatchdogOptions {
  settings: TurnWatchdogSettings;
  onWarning: (warning: TurnWatchdogWarning) => void;
  requestInterrupt: (turnToken: string, cause: TurnWatchdogInterruptCause) => boolean;
  failStop: (turnToken: string) => boolean;
  failStopUnattributed: () => void;
  nowMs?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

interface ActiveTool {
  toolName: string;
  startedAtMs: number;
}

interface WatchedTurn {
  turnToken: string;
  lastProgressAtMs: number;
  phase: "monitoring" | "interrupting" | "failed";
  interruptCause: TurnWatchdogInterruptCause | null;
  activeTools: Map<number, ActiveTool>;
}

export class TurnWatchdog {
  readonly #settings: TurnWatchdogSettings;
  readonly #onWarning: (warning: TurnWatchdogWarning) => void;
  readonly #requestInterrupt: (turnToken: string, cause: TurnWatchdogInterruptCause) => boolean;
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
    this.#nowMs = options.nowMs ?? (() => performance.now());
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as never));
  }

  start(turnToken: string): void {
    const watched = this.#watched;
    if (watched !== null) {
      if (watched.turnToken !== turnToken) {
        this.#onWarning({ kind: "start_conflict", watchedTurnToken: watched.turnToken, startedTurnToken: turnToken });
        this.#failClosed();
      }
      return;
    }
    this.#watched = {
      turnToken,
      lastProgressAtMs: this.#nowMs(),
      phase: "monitoring",
      interruptCause: null,
      activeTools: new Map(),
    };
    this.#armMonitoring(this.#watched);
  }

  progress(turnToken: string): void {
    const watched = this.#watched;
    if (watched === null || watched.turnToken !== turnToken || watched.phase === "failed") return;
    watched.lastProgressAtMs = this.#nowMs();
    // A tool deadline is absolute: output after its SIGTERM keeps the abort
    // grace running instead of reopening monitoring.
    if (watched.phase === "interrupting" && watched.interruptCause?.kind === "tool_timeout") return;
    watched.phase = "monitoring";
    watched.interruptCause = null;
    this.#armMonitoring(watched);
  }

  toolStart(turnToken: string, stepIndex: number, toolName: string): void {
    const watched = this.#watched;
    if (watched === null || watched.turnToken !== turnToken || watched.phase !== "monitoring") return;
    // A repeated ACTIVE for the same step keeps the original start.
    if (!watched.activeTools.has(stepIndex)) {
      watched.activeTools.set(stepIndex, { toolName, startedAtMs: this.#nowMs() });
    }
    this.#armMonitoring(watched);
  }

  toolEnd(turnToken: string, stepIndex: number): void {
    const watched = this.#watched;
    if (watched === null || watched.turnToken !== turnToken) return;
    if (!watched.activeTools.delete(stepIndex)) return;
    if (watched.phase === "monitoring") this.#armMonitoring(watched);
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

  #oldestTool(watched: WatchedTurn): (ActiveTool & { stepIndex: number }) | null {
    let oldest: (ActiveTool & { stepIndex: number }) | null = null;
    for (const [stepIndex, tool] of watched.activeTools) {
      if (oldest === null || tool.startedAtMs < oldest.startedAtMs) oldest = { stepIndex, ...tool };
    }
    return oldest;
  }

  #armMonitoring(watched: WatchedTurn): void {
    const now = this.#nowMs();
    let delayMs = this.#settings.inactivityMs - (now - watched.lastProgressAtMs);
    const oldest = this.#oldestTool(watched);
    if (oldest !== null) {
      delayMs = Math.min(delayMs, this.#settings.toolTimeoutMs - (now - oldest.startedAtMs));
    }
    this.#arm(Math.max(0, delayMs));
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
      const now = this.#nowMs();
      const oldest = this.#oldestTool(watched);
      const idleMs = now - watched.lastProgressAtMs;
      let cause: TurnWatchdogInterruptCause;
      if (oldest !== null && now - oldest.startedAtMs >= this.#settings.toolTimeoutMs) {
        cause = {
          kind: "tool_timeout",
          stepIndex: oldest.stepIndex,
          toolName: oldest.toolName,
          elapsedMs: now - oldest.startedAtMs,
          toolTimeoutMs: this.#settings.toolTimeoutMs,
        };
        this.#onWarning({ ...cause, turnToken: watched.turnToken });
      } else if (idleMs >= this.#settings.inactivityMs) {
        cause = { kind: "inactivity", idleMs };
        this.#onWarning({ kind: "inactivity_timeout", turnToken: watched.turnToken, idleMs, inactivityMs: this.#settings.inactivityMs });
      } else {
        this.#armMonitoring(watched);
        return;
      }
      watched.phase = "interrupting";
      watched.interruptCause = cause;
      if (!this.#requestInterrupt(watched.turnToken, cause)) {
        this.#onWarning({ kind: "interrupt_unavailable", turnToken: watched.turnToken });
        this.#failClosed();
        return;
      }
      this.#arm(this.#settings.abortGraceMs);
      return;
    }
    watched.phase = "failed";
    this.#onWarning({ kind: "abort_grace_expired", turnToken: watched.turnToken, abortGraceMs: this.#settings.abortGraceMs });
    if (!this.#failStop(watched.turnToken)) {
      this.#onWarning({ kind: "fail_stop_unavailable", turnToken: watched.turnToken });
      this.#failClosed();
    }
  }

  #failClosed(): void {
    if (this.#watched !== null) this.#watched.phase = "failed";
    this.#disarm();
    this.#failStopUnattributed();
  }
}
