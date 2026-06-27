// State machine — pure functions that derive the kaoiro state from the
// adapter's normalized events. The mapping mirrors the "state derivation
// mapping" section of docs/specs/agent-sdk-events.md.
//
// Parallel tool execution (issue #3): an assistant message may carry several
// tool_use blocks whose results arrive as separate messages. The machine
// tracks the unanswered tool_use ids and leaves tool_running only when the
// set drains, so the first tool_result no longer flips the state to thinking.

import type {
  AdapterEvent,
  AttachRejectedPayload,
  Envelope,
  InstructionRejectedPayload,
  KaoiroState,
  LogPayload,
  ResultPayload,
  WrapperConfig,
} from "./types.js";

const EMPTY_IDS: ReadonlySet<string> = new Set();

/** Machine state: the settled coarse state plus the unanswered tool_use ids. */
export interface MachineState {
  state: KaoiroState;
  /** tool_use ids issued by the latest assistant message, not yet answered. */
  pendingToolUses: ReadonlySet<string>;
}

/** Initial machine state (pending set empty). */
export function initialMachineState(state: KaoiroState = "idle"): MachineState {
  return { state, pendingToolUses: EMPTY_IDS };
}

/**
 * Pure step function: applies one event to the machine state.
 *
 * `emitted` holds the state(s) entered by this event, in order. Usually one
 * element; `result` emits two (the momentary done/error followed by
 * `waiting_input`, per protocol.md). Events with no transition (`ignore`, or
 * a tool_result while other tools are still pending) emit nothing.
 *
 * Pending-set lifecycle is self-healing: every assistant event resets the set
 * to its own tool_use ids (the model only resumes after all results, so older
 * ids are settled), and session_init/result clear it. A tool_result carrying
 * no extractable ids falls back to clearing the set — a premature thinking
 * beats a tool_running the machine can never leave.
 */
export function stepState(
  machine: MachineState,
  event: AdapterEvent,
): { next: MachineState; emitted: KaoiroState[] } {
  switch (event.kind) {
    case "session_init":
      // The SDK can emit system/init at the start of a turn, right after an
      // instruction is accepted. That must not revert the optimistic
      // `sending` to idle and flash it (#32; spec: sending exits on the first
      // SDKAssistantMessage). Hold `sending` and emit nothing until a real
      // activity state lands.
      if (machine.state === "sending") {
        return { next: initialMachineState("sending"), emitted: [] };
      }
      return { next: initialMachineState("idle"), emitted: ["idle"] };
    case "assistant": {
      if (event.error) {
        return { next: initialMachineState("error"), emitted: ["error"] };
      }
      // tool_use present => tool_running; text/thinking only => thinking.
      // Empty blocks (no content) settle to thinking; the adapter guarantees
      // non-empty content, so this is a defensive default, not a spec case.
      if (event.blocks.includes("tool_use")) {
        return {
          next: {
            state: "tool_running",
            pendingToolUses: new Set(event.toolUseIds ?? []),
          },
          emitted: ["tool_running"],
        };
      }
      return { next: initialMachineState("thinking"), emitted: ["thinking"] };
    }
    case "tool_result": {
      // A tool_result outside tool_running (stray/duplicate message) has no
      // state to end; ignore it rather than emit a spurious thinking.
      if (machine.state !== "tool_running") {
        return { next: machine, emitted: [] };
      }
      const ids = event.toolUseIds ?? [];
      const pending = new Set(machine.pendingToolUses);
      for (const id of ids) pending.delete(id);
      // No ids extracted -> legacy behavior: treat the tool phase as over.
      if (ids.length === 0) pending.clear();
      if (pending.size > 0) {
        // Foreign ids (none deleted) intentionally do NOT clear the set:
        // clearing would falsely end tools that are still running. A stale
        // pending set heals at the next assistant/result event.
        return {
          next: { state: machine.state, pendingToolUses: pending },
          emitted: [],
        };
      }
      // End of tool_running; the model resumes on the result.
      return { next: initialMachineState("thinking"), emitted: ["thinking"] };
    }
    case "result": {
      const emitted: KaoiroState[] =
        event.subtype === "success"
          ? ["done", "waiting_input"]
          : ["error", "waiting_input"];
      return { next: initialMachineState("waiting_input"), emitted };
    }
    case "permission_request":
      return {
        next: { ...machine, state: "waiting_permission" },
        emitted: ["waiting_permission"],
      };
    case "permission_resolved":
      // canUseTool is only invoked after a tool_use, so we return to
      // tool_running regardless of the previous state. Pending ids survive
      // the permission window untouched.
      return {
        next: { ...machine, state: "tool_running" },
        emitted: ["tool_running"],
      };
    case "user_send": {
      // An instruction was accepted while the agent was at rest: show the
      // optimistic `sending` state until the model's first message lands
      // (#32). A send mid-turn (thinking/tool_running/waiting_permission) is
      // only queued, so it leaves the visible state untouched.
      const atRest =
        machine.state === "idle" ||
        machine.state === "waiting_input" ||
        machine.state === "done" ||
        machine.state === "error";
      if (!atRest) return { next: machine, emitted: [] };
      return { next: { ...machine, state: "sending" }, emitted: ["sending"] };
    }
    case "ignore":
      return { next: machine, emitted: [] };
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
  let machine = initialMachineState(initial);
  for (const event of events) {
    const { next, emitted } = stepState(machine, event);
    machine = next;
    trace.push(...emitted);
  }
  return trace;
}

/** Wraps a state change into the common envelope v0. `ext` carries
 *  filter/adapter-added fields such as Claude Code status meta (#16). */
export function makeStateChange(
  config: WrapperConfig,
  state: KaoiroState,
  ts: string,
  payload: Record<string, unknown> = {},
  ext: Record<string, unknown> = {},
): Envelope {
  return {
    version: "0",
    agent_id: config.agent_id,
    persona: config.persona,
    ts,
    type: "state_change",
    state,
    payload,
    ext,
  };
}

/** Wraps a relayed log line into the common envelope v0 (protocol.md
 *  type="log"). `state` is the agent's state at relay time; the line
 *  itself does not drive state derivation. */
export function makeLog(
  config: WrapperConfig,
  state: KaoiroState,
  ts: string,
  payload: LogPayload,
): Envelope {
  return {
    version: "0",
    agent_id: config.agent_id,
    persona: config.persona,
    ts,
    type: "log",
    state,
    payload: payload as unknown as Record<string, unknown>,
    ext: {},
  };
}

/** Wraps a turn's final reply into the common envelope v0 (protocol.md
 *  type="result"). state mirrors the terminal done/error. `ext` carries
 *  filter-added fields such as `cost` (#8). */
export function makeResult(
  config: WrapperConfig,
  ts: string,
  payload: ResultPayload,
  ext: Record<string, unknown> = {},
): Envelope {
  return {
    version: "0",
    agent_id: config.agent_id,
    persona: config.persona,
    ts,
    type: "result",
    state: payload.is_error ? "error" : "done",
    payload: payload as unknown as Record<string, unknown>,
    ext,
  };
}

/** Wraps a pending tool-permission request into the common envelope v0
 *  (protocol.md; payload carries request_id / tool_name / input). */
export function makePermissionRequest(
  config: WrapperConfig,
  ts: string,
  payload: Record<string, unknown>,
): Envelope {
  return {
    version: "0",
    agent_id: config.agent_id,
    persona: config.persona,
    ts,
    type: "permission_request",
    state: "waiting_permission",
    payload,
    ext: {},
  };
}

/** Wraps an individual upload rejection into the common envelope v0
 *  (file-upload spec / ADR-0025 F9). `state` mirrors the agent's current
 *  state — the reject is informational and does not transition the machine. */
export function makeAttachRejected(
  config: WrapperConfig,
  state: KaoiroState,
  ts: string,
  payload: AttachRejectedPayload,
): Envelope {
  return {
    version: "0",
    agent_id: config.agent_id,
    persona: config.persona,
    ts,
    type: "attach_rejected",
    state,
    payload: payload as unknown as Record<string, unknown>,
    ext: {},
  };
}

/** Wraps a whole-instruction rejection into the common envelope v0
 *  (file-upload spec / ADR-0025 F9). */
export function makeInstructionRejected(
  config: WrapperConfig,
  state: KaoiroState,
  ts: string,
  payload: InstructionRejectedPayload,
): Envelope {
  return {
    version: "0",
    agent_id: config.agent_id,
    persona: config.persona,
    ts,
    type: "instruction_rejected",
    state,
    payload: payload as unknown as Record<string, unknown>,
    ext: {},
  };
}
