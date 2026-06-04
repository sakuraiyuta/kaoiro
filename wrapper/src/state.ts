// State machine — pure functions that derive the kaoiro state from the
// adapter's normalized events. The mapping mirrors the "state derivation
// mapping" section of docs/specs/agent-sdk-events.md.

import type {
  AdapterEvent,
  Envelope,
  KaoiroState,
  WrapperConfig,
} from "./types.js";

/**
 * Pure function returning the state(s) produced by a single event.
 *
 * Usually one element. Only `result` returns two: the momentary done/error
 * state followed by `waiting_input` it settles into (protocol.md's
 * done->waiting_input). Events with no coarse-state effect (`ignore`) return
 * an empty array, leaving the current state unchanged.
 *
 * @param prev The current settled state (the reducer input). Reserved for
 *   future branching; the current rules do not yet condition on it.
 */
export function deriveStates(
  prev: KaoiroState,
  event: AdapterEvent,
): KaoiroState[] {
  switch (event.kind) {
    case "session_init":
      return ["idle"];
    case "assistant":
      if (event.error) return ["error"];
      // tool_use present => tool_running; text/thinking only => thinking.
      // Empty blocks (no content) settle to thinking; the adapter guarantees
      // non-empty content, so this is a defensive default, not a spec case.
      return event.blocks.includes("tool_use")
        ? ["tool_running"]
        : ["thinking"];
    case "tool_result":
      // End of tool_running; the model resumes on the result.
      return ["thinking"];
    case "result":
      return event.subtype === "success"
        ? ["done", "waiting_input"]
        : ["error", "waiting_input"];
    case "permission_request":
      return ["waiting_permission"];
    case "permission_resolved":
      // canUseTool is only invoked after a tool_use, so we return to
      // tool_running regardless of prev.
      return ["tool_running"];
    case "ignore":
      return [];
  }
}

/**
 * Folds an event list into the full trace of states visited. The last element
 * is the settled current state.
 *
 * Returns an empty array when no event produces a transition (empty input, or
 * only `ignore` events); the effective current state is then `initial`.
 */
export function reduceStates(
  events: readonly AdapterEvent[],
  initial: KaoiroState = "idle",
): KaoiroState[] {
  const trace: KaoiroState[] = [];
  let current = initial;
  for (const event of events) {
    for (const next of deriveStates(current, event)) {
      trace.push(next);
      current = next;
    }
  }
  return trace;
}

/** Wraps a state change into the common envelope v0. */
export function makeStateChange(
  config: WrapperConfig,
  state: KaoiroState,
  ts: string,
  payload: Record<string, unknown> = {},
): Envelope {
  return {
    version: "0",
    agent_id: config.agent_id,
    persona: config.persona,
    ts,
    type: "state_change",
    state,
    payload,
    ext: {},
  };
}
