import type { Messages } from "../ja";

export const protocol = {
  disconnectOperator: "Stopped by the operator",
  disconnectRunner: "Stopped by the runner",
  disconnectQuotaExhausted: "Stopped because the quota ran out",
  disconnectCrash: "The agent crashed",
  disconnectAgentSelf: "Stopped by the agent itself",
  disconnectUnplanned: "Unexpected disconnection",
  errorSubtype: {
    error_max_turns: "Maximum turns reached",
    error_during_execution: "Error during execution",
    error_max_budget_usd: "Budget limit reached",
    error_max_structured_output_retries: "Structured output retry limit reached",
    error_rollout_corrupted: "Session corrupted (cannot be resumed)",
  },
  resetRequestedBy: ({ requester }) => `requested by ${requester}`,
} satisfies Messages["protocol"];
