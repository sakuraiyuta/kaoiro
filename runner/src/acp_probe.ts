// Shared tracking for the runner's short-lived ACP probes (Grok, Muse).
// Both probes run their agent in its own process group with the same
// bounded TERM/KILL teardown; shutdown waits on this one registry, so a
// probe of either engine is never orphaned between TERM and KILL.

/** Room for one probe's teardown: two grace periods and some slack. */
export const ACP_PROBE_SETTLE_MS = 2_500;

// Every probe from spawn until its group's teardown has finished.
const inFlight = new Set<Promise<void>>();

export function trackAcpProbe(running: Promise<unknown>): void {
  const tracked = running.then(
    () => {},
    () => {},
  );
  inFlight.add(tracked);
  void tracked.then(() => inFlight.delete(tracked));
}

/** Resolves true once every probe of this process has finished its group
 *  teardown, false if that takes longer than `withinMs`. A shutdown awaits
 *  it after aborting the probes, so the TERM/KILL escalation runs before
 *  the process exits. */
export async function acpProbesSettled(withinMs = ACP_PROBE_SETTLE_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), withinMs);
  });
  const drained = (async () => {
    while (inFlight.size > 0) await Promise.all(inFlight);
    return true;
  })();
  try {
    return await Promise.race([drained, expired]);
  } finally {
    clearTimeout(timer);
  }
}
