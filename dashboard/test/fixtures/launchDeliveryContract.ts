// Client contract example; the dashboard remains independent of @kaoiro/protocol.
export const launchDeliveryContract = {
  in_flight_defaults: { codex: false },
  launch_delivery_policy: {
    version: "v1",
    ceiling: true,
    mechanisms: { operator_early: "none", inter_agent_early: "steer", inter_agent_yield: "none" },
  },
} as const;
