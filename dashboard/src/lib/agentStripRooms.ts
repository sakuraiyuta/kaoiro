import { expressionFor, type KnownState } from "./expression";

const URGENCY: readonly KnownState[] = [
  "waiting_permission", "waiting_question", "waiting_input", "error",
  "tool_running", "thinking", "sending", "done", "idle", "disconnected",
];

export function roomLamp(items: readonly { state: string }[]): KnownState {
  const states = new Set(items.map((item) => expressionFor(item.state).variant));
  return URGENCY.find((state) => states.has(state)) ?? "idle";
}
