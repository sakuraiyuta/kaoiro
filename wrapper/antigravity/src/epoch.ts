/** issue #377 Stage 2: the epoch lifetime model. An epoch is one `agy`
 *  process spanning several turns; a turn only ends the epoch when its own
 *  requirements (a spec change, an operator interrupt, a broken gate, ...)
 *  demand it. `EpochSpec` is the recorded identity of a live epoch's launch
 *  arguments -- the next turn's OWN freshly computed spec is compared
 *  against it (`epochSpecsEqual`) to decide whether the epoch can be reused
 *  or must be ended and respawned. */
export interface EpochSpec {
  conversationId: string | null;
  model: string | undefined;
  effort: string | undefined;
  addDirs: readonly string[];
}

/** M6 (kohaku design review): an epoch's OWN `init` event is the only writer
 *  that ever updates a live epoch's recorded `conversationId` (to the
 *  engine-confirmed session id) -- never this comparison. Without that
 *  adoption, a freshly spawned epoch's spec (`conversationId: null`) would
 *  permanently mismatch every later turn's freshly computed spec (which
 *  reads the now-confirmed `#sessionId`), forcing a respawn on turn 2 of
 *  every epoch. */
export function epochSpecsEqual(a: EpochSpec, b: EpochSpec): boolean {
  return (
    a.conversationId === b.conversationId &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.addDirs.length === b.addDirs.length &&
    a.addDirs.every((dir, index) => dir === b.addDirs[index])
  );
}

/** N4: the closed set of reasons an epoch can end for, each producing one
 *  `epoch_ended` lifecycle event. A spontaneous exit while a turn is in
 *  flight is deliberately NOT one of these -- it settles as that turn's own
 *  `agy_exit_without_result` / `epoch_exit_before_turn` error, matching pre-
 *  epoch (Stage 1) behaviour, with no separate lifecycle event. */
export type EpochEndReason =
  | "idle_exit"
  | "spec_change"
  | "interrupt"
  | "watchdog"
  | "tamper"
  | "gate_broken"
  | "close"
  | "idle_ttl";

export const DEFAULT_EPOCH_IDLE_MS = 30 * 60 * 1_000;
export const MIN_EPOCH_IDLE_MS = 1_000;
export const EPOCH_IDLE_MS_ENV = "KAOIRO_ANTIGRAVITY_EPOCH_IDLE_MS";

/** Reads the idle-epoch lifetime bound (M7): an epoch that sits idle (no
 *  in-flight turn) for this long is ended with reason `idle_ttl`. Cleared at
 *  turn dequeue and re-armed only after that turn's result/error settles --
 *  see `AntigravityHost`'s `#clearIdleTtl` / `#armIdleTtl`. */
export function readEpochIdleMs(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env[EPOCH_IDLE_MS_ENV];
  if (raw === undefined || raw === "") return DEFAULT_EPOCH_IDLE_MS;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${EPOCH_IDLE_MS_ENV} must be an integer number of milliseconds`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_EPOCH_IDLE_MS) {
    throw new Error(`${EPOCH_IDLE_MS_ENV} must be an integer >= ${MIN_EPOCH_IDLE_MS}`);
  }
  return value;
}
