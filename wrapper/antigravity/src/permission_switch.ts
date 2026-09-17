// Antigravity runtime permission-switch final gate (ADR-0057 F4c Stage B0,
// issue #359). The runner resolves each axis ceiling and the wrapper advertises
// it as session_capabilities.permission_switch_axes; the server clamps against
// that advertisement (first gate). This module is the wrapper's own fail-closed
// re-check (final gate) before it applies a server-originated set_permission —
// defense-in-depth against a widening the first gate somehow let through.

import type { PermissionAxesExt, PermissionConfiguration } from "@kaoiro/protocol";

type Sandbox = PermissionAxesExt["sandbox"];
type Approval = PermissionAxesExt["approval"];

// Permissive orders (strict -> permissive); the index is the rank a ceiling
// comparison uses. `on-failure` is excluded — this engine rejects it at spawn,
// and an approval value outside this order is treated as a ceiling violation
// (fail-closed) rather than silently allowed.
const SANDBOX_ORDER: readonly Sandbox[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];
const APPROVAL_ORDER: readonly Approval[] = [
  "untrusted",
  "on-request",
  "local",
  "never",
];

/** The per-axis ceiling the runner relayed as WrapperConfig.max_*. */
export interface SwitchCeiling {
  sandbox: Sandbox;
  network_access: boolean;
  approval: Approval;
}

/** Returns a human-readable detail when `target` would widen past `ceiling` on
 *  any axis, else null. An axis value outside the closed permissive order is
 *  reported as a violation (fail-closed). */
export function ceilingExceeded(
  target: PermissionConfiguration,
  ceiling: SwitchCeiling,
): string | null {
  const violations: string[] = [];

  const targetSandbox = SANDBOX_ORDER.indexOf(target.sandbox);
  const ceilingSandbox = SANDBOX_ORDER.indexOf(ceiling.sandbox);
  if (targetSandbox < 0 || targetSandbox > ceilingSandbox) {
    violations.push(`sandbox=${target.sandbox} exceeds ceiling ${ceiling.sandbox}`);
  }

  if (target.approval !== undefined) {
    const targetApproval = APPROVAL_ORDER.indexOf(target.approval);
    const ceilingApproval = APPROVAL_ORDER.indexOf(ceiling.approval);
    if (targetApproval < 0 || targetApproval > ceilingApproval) {
      violations.push(
        `approval=${target.approval} exceeds ceiling ${ceiling.approval}`,
      );
    }
  }

  if (target.network_access && !ceiling.network_access) {
    violations.push("network_access=true exceeds ceiling false");
  }

  return violations.length === 0 ? null : violations.join("; ");
}
