// State -> expression mapping (Phase 2 task 2-2, placeholder stage).
// Today an expression is a CSS-drawn face variant; when persona sprite
// sets arrive (ADR-0008), this module becomes the lookup that resolves a
// state to a sprite frame instead. Keep consumers on `expressionFor` so
// the swap stays local.

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
