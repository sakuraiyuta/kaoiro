import { resolveDigitsMs } from "@kaoiro/wrapper-core";

export interface WatchdogSettings {
  inactivityMs: number;
  abortGraceMs: number;
}

export interface MuseSettings {
  watchdog: WatchdogSettings;
  /** Whether the ACP child is launched with `--trust-workspace`, which
   *  loads the workspace's own skills and rules. Off unless the operator
   *  opts in: kaoiro's cwd allowlist authorizes where an agent may launch,
   *  it does not imply trusting the workspace contents. */
  trustWorkspace: boolean;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function resolveTurnWatchdogSettings(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
  config?: {
    turn_watchdog_inactivity_ms?: number;
    turn_watchdog_abort_grace_ms?: number;
  },
) {
  const inactivity = resolveDigitsMs(
    env,
    "KAOIRO_MUSE_TURN_WATCHDOG_INACTIVITY_MS",
    config?.turn_watchdog_inactivity_ms,
    30 * 60_000,
    60_000,
    2_147_483_647,
  );
  const abortGrace = resolveDigitsMs(
    env,
    "KAOIRO_MUSE_TURN_WATCHDOG_ABORT_GRACE_MS",
    config?.turn_watchdog_abort_grace_ms,
    3_000,
    1,
    2_147_483_647,
  );
  if (inactivity.value < 30 * 60_000) {
    const name = inactivity.source === "config"
      ? "turn_watchdog_inactivity_ms"
      : "KAOIRO_MUSE_TURN_WATCHDOG_INACTIVITY_MS";
    warn(
      `[kaoiro] ${name}=${inactivity.value}ms is below ` +
      "the 30-minute default; choose the shorter inactivity value " +
      "deliberately.\n",
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
  config?: {
    turn_watchdog_inactivity_ms?: number;
    turn_watchdog_abort_grace_ms?: number;
  },
): WatchdogSettings {
  return resolveTurnWatchdogSettings(env, warn, config).settings;
}

/** The operator's Muse settings from the environment. `--trust-workspace`
 *  is opt-in through `KAOIRO_MUSE_TRUST_WORKSPACE` (1/true/yes/on). */
export function resolveMuseSettings(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
  config?: {
    turn_watchdog_inactivity_ms?: number;
    turn_watchdog_abort_grace_ms?: number;
  },
): { settings: MuseSettings; watchdog: ReturnType<typeof resolveTurnWatchdogSettings> } {
  const watchdog = resolveTurnWatchdogSettings(env, warn, config);
  const raw = env.KAOIRO_MUSE_TRUST_WORKSPACE;
  return {
    watchdog,
    settings: {
      watchdog: watchdog.settings,
      trustWorkspace: raw !== undefined && TRUTHY.has(raw.trim().toLowerCase()),
    },
  };
}
