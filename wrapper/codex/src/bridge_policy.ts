/** Must outlive the 300-second synchronous inter-agent waiter. */
export const BRIDGE_TOOL_TIMEOUT_SEC = 310;
export const BRIDGE_STARTUP_TIMEOUT_SEC = 30;

// The pinned CLI otherwise omits optional MCP servers after a one-second
// grace. A missing kaoiro bridge must fail startup, not silently remove tools.
export const BRIDGE_MCP_POLICY = {
  required: true,
  startup_timeout_sec: BRIDGE_STARTUP_TIMEOUT_SEC,
  default_tools_approval_mode: "approve",
  tool_timeout_sec: BRIDGE_TOOL_TIMEOUT_SEC,
} as const;

// Leave time to receive the CLI's startup failure before the RPC deadline.
export const BRIDGE_THREAD_OPEN_TIMEOUT_MS = (BRIDGE_STARTUP_TIMEOUT_SEC + 5) * 1000;
