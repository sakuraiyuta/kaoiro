// State -> expression mapping (Phase 2 task 2-2).
// `expressionFor` keeps the CSS-drawn face metadata (variant + label);
// `spriteUrlFor` resolves a state to a persona sprite from the ADR-0008
// manifest. Cards prefer the sprite and fall back to the CSS face.

import {
  sessionCapabilitiesFrom,
  type Envelope,
  type PersonaManifest,
} from "./protocol";

/** State set v0 (protocol.md) plus the wrapper-raised `sending` (#32) and
 *  the server-derived `disconnected`. */
export const KNOWN_STATES = [
  "idle",
  "sending",
  "thinking",
  "tool_running",
  "waiting_permission",
  "waiting_question",
  "waiting_input",
  "done",
  "error",
  "disconnected",
] as const;

export type KnownState = (typeof KNOWN_STATES)[number];

export interface Expression {
  /** CSS hook: face variant class, one per known state. */
  variant: KnownState;
  /** Short human label shown next to the face. */
  label: string;
}

const EXPRESSIONS: Record<KnownState, Expression> = {
  idle: { variant: "idle", label: "idle" },
  sending: { variant: "sending", label: "sending" },
  thinking: { variant: "thinking", label: "thinking" },
  tool_running: { variant: "tool_running", label: "tool running" },
  waiting_permission: {
    variant: "waiting_permission",
    label: "permission?",
  },
  waiting_question: { variant: "waiting_question", label: "choose?" },
  waiting_input: { variant: "waiting_input", label: "your turn" },
  done: { variant: "done", label: "done" },
  error: { variant: "error", label: "error" },
  disconnected: { variant: "disconnected", label: "offline" },
};

function isKnownState(state: string): state is KnownState {
  return (KNOWN_STATES as readonly string[]).includes(state);
}

/** Unknown states (forward compat) fall back to the idle face. */
export function expressionFor(state: string): Expression {
  return isKnownState(state) ? EXPRESSIONS[state] : EXPRESSIONS.idle;
}

/** Context usage at or above which the dashboard renders the fatigue
 * modifier (issue #172 P4). This is intentionally an independent constant
 * from the wrapper's notification threshold: both happen to be 60, but they
 * live in separate hosts and serve separate decisions. */
const FATIGUE_THRESHOLD_PERCENT = 60;

/** The sole fatigue predicate (issue #172 P1/P2). Keeping the envelope input
 * and its signal lookup here means a future switch to context_budget changes
 * this function and its tests only. Unknown capability or malformed context
 * fails closed: do not infer fatigue from an unsupported session. */
export function isFatigued(envelope: Envelope): boolean {
  if (sessionCapabilitiesFrom(envelope)?.supports_context_usage !== true) {
    return false;
  }
  const context = envelope.ext?.context as Record<string, unknown> | undefined;
  const percentage = context?.used_percentage;
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) {
    return false;
  }
  return percentage >= FATIGUE_THRESHOLD_PERCENT;
}

// `disconnected` is deliberately absent: this allowlist is the one and only
// priority mechanism. The former early return duplicated that property and
// was removed by こはく裁定 after its deletion mutation remained green.
const FATIGUE_ELIGIBLE_STATES = new Set<string>(["idle", "waiting_input"]);

/** Resolve the sprite state without adding fatigue to the protocol state
 * vocabulary. `disconnected` remains visibly offline because it is not in
 * the fatigue allowlist. */
export function spriteStateFor(state: string, fatigued: boolean): string {
  if (fatigued && FATIGUE_ELIGIBLE_STATES.has(state)) return "fatigued";
  return state;
}

/**
 * Sprite URL for a persona's state, or null when no usable sprite
 * exists (the caller falls back to the CSS face). States without a
 * sprite fall back to idle: that covers unknown states (forward
 * compat) and disconnected, which has no image by spec — personas.md
 * mandates greying out the idle sprite via CSS instead.
 */
export function spriteUrlFor(
  manifest: PersonaManifest | null,
  spriteSet: string | undefined,
  state: string,
): string | null {
  if (!manifest || !spriteSet) return null;
  const states = manifest.personas[spriteSet]?.states;
  if (!states) return null;
  return (states[state] ?? states.idle)?.url ?? null;
}
