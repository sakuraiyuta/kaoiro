// State -> expression mapping (Phase 2 task 2-2).
// `expressionFor` keeps the CSS-drawn face metadata (variant + label);
// `spriteUrlFor` resolves a state to a persona sprite from the ADR-0008
// manifest. Cards prefer the sprite and fall back to the CSS face.

import type { PersonaManifest } from "./protocol";

/** State set v0 (protocol.md) plus the server-derived disconnected. */
export const KNOWN_STATES = [
  "idle",
  "thinking",
  "tool_running",
  "waiting_permission",
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
  thinking: { variant: "thinking", label: "thinking" },
  tool_running: { variant: "tool_running", label: "tool running" },
  waiting_permission: {
    variant: "waiting_permission",
    label: "permission?",
  },
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
