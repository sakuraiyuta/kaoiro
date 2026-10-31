import type { Envelope } from "./protocol";
import type { GridSort } from "./settings.svelte";

/** Orders the live grid. "name" is the agent_id order; "recent" puts the
 *  agent whose latest state change is newest first. `Envelope.ts` is the
 *  wrapper's timestamp of that change, so an agent that is thinking or
 *  running tools rises and a quiet one sinks. Ties and unparseable
 *  timestamps fall back to agent_id so the order is stable. */
export function sortAgents(envelopes: Envelope[], mode: GridSort): Envelope[] {
  const byName = (a: Envelope, b: Envelope) =>
    a.agent_id.localeCompare(b.agent_id);
  if (mode === "name") return [...envelopes].sort(byName);
  const at = (e: Envelope) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) ? t : 0;
  };
  return [...envelopes].sort((a, b) => at(b) - at(a) || byName(a, b));
}
