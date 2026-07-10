// Claude permissionMode -> sandbox × approval two-axis mapping (ADR-0033 F2).
// A DISPLAY approximation: the value handed to the SDK stays the mode itself;
// this table only feeds ext.permission so server / dashboard reason about one
// engine-neutral vocabulary. Placeholder in phase-13 — wired into the
// state_change ext in phase-14 (14-3 / 14-4) once @kaoiro/protocol grows the
// ext.permission type.

import type { PermissionMode } from "@kaoiro/agent-common";

export interface PermissionAxes {
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approval: "untrusted" | "on-request" | "on-failure" | "never";
}

/** ADR-0033 F2 の写像 table (表示用近似)。 */
export const PERMISSION_MODE_AXES: Record<PermissionMode, PermissionAxes> = {
  default: { sandbox: "workspace-write", approval: "untrusted" },
  acceptEdits: { sandbox: "workspace-write", approval: "on-request" },
  plan: { sandbox: "read-only", approval: "on-request" },
  bypassPermissions: { sandbox: "danger-full-access", approval: "never" },
  dontAsk: { sandbox: "workspace-write", approval: "never" },
  auto: { sandbox: "workspace-write", approval: "on-request" },
};
