// Antigravity runtime permission-switch ceiling resolution (ADR-0057 F4c
// Stage B0, issue #359). Pure helpers so the supervisor and its tests can
// reason about the clamp rules in isolation.
//
// The threat-model MUST (specs/threat-model.md) is that a server-originated
// `set_permission` cannot widen a wrapper's execution ceiling. On Antigravity
// the sandbox x approval cell matrix *is* the ceiling, so the runner resolves
// a per-axis ceiling from the operator's host-local `antigravity.max_*` config
// and the launch values, and relays it to the wrapper as
// `WrapperConfig.max_*`. The wrapper advertises these verbatim as
// `session_capabilities.permission_switch_axes` (source of truth); the server
// clamps against them (first gate) and the wrapper re-checks fail-closed
// (final gate).
//
// Resolution is per axis:
//   - explicit config ceiling present and at least as permissive as launch
//     -> the explicit ceiling wins;
//   - explicit config ceiling present but LESS permissive than launch -> a
//     contradiction (the agent launched above its own declared ceiling): the
//     spawn is rejected fail-closed, and the safe default is used defensively
//     for the relayed value should the reject ever be bypassed;
//   - explicit config ceiling absent -> the default: the launch value itself
//     for sandbox / network_access (no widening by default) and
//     permissive_max(launch, "local") for approval (so an on-request agent can
//     be widened to the advisory allowlist at runtime, but never to "never").

import type { PermissionAxesExt } from "@kaoiro/protocol";

type Sandbox = PermissionAxesExt["sandbox"];
type Approval = PermissionAxesExt["approval"];

/** Permissive orders (strict -> permissive); the index is the rank a ceiling
 *  comparison uses. Duplicated as runtime arrays because `@kaoiro/protocol` is
 *  types-only (same pattern as `SANDBOX_VALUES` / `APPROVAL_VALUES` in
 *  resume_snapshot.ts). `on-failure` is excluded from the approval order: the
 *  runner rejects it at spawn before ceiling resolution runs. */
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

/** Launch values the ceiling is resolved against. Absent axes fall back to the
 *  wrapper's own launch defaults so the runner and wrapper agree on the
 *  baseline (host.ts: sandbox "workspace-write", approval "on-request",
 *  network_access false). */
export interface AntigravityLaunch {
  sandbox: Sandbox | undefined;
  approval: Approval | undefined;
  networkAccess: boolean | undefined;
}

/** Operator-declared host-local ceilings from `antigravity.max_*` config. Each
 *  axis is optional; absent means "use the default ceiling for this axis". */
export interface AntigravityMaxConfig {
  max_sandbox?: Sandbox;
  max_approval?: Approval;
  max_network_access?: boolean;
}

/** Resolved per-axis ceiling relayed to the wrapper as `WrapperConfig.max_*`. */
export interface AntigravityCeiling {
  max_sandbox: Sandbox;
  max_approval: Approval;
  max_network_access: boolean;
}

export interface AntigravityCeilingResolution {
  ceiling: AntigravityCeiling;
  /** Human-readable conflict detail (naming the axis and the two values) when
   *  an explicit config ceiling is less permissive than the launch value, else
   *  null. A non-null value fails the spawn closed. */
  conflict: string | null;
}

function sandboxRank(value: Sandbox): number {
  return SANDBOX_ORDER.indexOf(value);
}

function approvalRank(value: Approval): number {
  return APPROVAL_ORDER.indexOf(value);
}

function permissiveMaxApproval(a: Approval, b: Approval): Approval {
  return approvalRank(a) >= approvalRank(b) ? a : b;
}

/** Resolves the antigravity permission-switch ceiling. Always returns a safe
 *  ceiling (never wider than the operator intended); `conflict` is set when an
 *  explicit config ceiling contradicts the launch value so the caller can
 *  reject the spawn. `on-failure` / any value outside the closed orders is
 *  treated as absent for that axis (defense-in-depth; the runner rejects
 *  `on-failure` upstream). */
export function resolveAntigravityCeiling(
  launch: AntigravityLaunch,
  config: AntigravityMaxConfig | undefined,
): AntigravityCeilingResolution {
  const launchSandbox: Sandbox = launch.sandbox ?? "workspace-write";
  const launchApproval: Approval = launch.approval ?? "on-request";
  const launchNetwork = launch.networkAccess ?? false;

  const conflicts: string[] = [];

  // Sandbox: default = launch; explicit must be >= launch.
  let maxSandbox = launchSandbox;
  const cfgSandbox = config?.max_sandbox;
  if (cfgSandbox !== undefined && sandboxRank(cfgSandbox) >= 0) {
    if (sandboxRank(cfgSandbox) >= sandboxRank(launchSandbox)) {
      maxSandbox = cfgSandbox;
    } else {
      conflicts.push(
        `max_sandbox=${cfgSandbox} is narrower than launch sandbox=${launchSandbox}`,
      );
    }
  }

  // Approval: default = permissive_max(launch, "local"); explicit must be
  // >= launch.
  let maxApproval = permissiveMaxApproval(launchApproval, "local");
  const cfgApproval = config?.max_approval;
  if (cfgApproval !== undefined && approvalRank(cfgApproval) >= 0) {
    if (approvalRank(cfgApproval) >= approvalRank(launchApproval)) {
      maxApproval = cfgApproval;
    } else {
      conflicts.push(
        `max_approval=${cfgApproval} is narrower than launch approval=${launchApproval}`,
      );
    }
  }

  // network_access: default = launch; explicit must be >= launch (false < true).
  let maxNetwork = launchNetwork;
  const cfgNetwork = config?.max_network_access;
  if (cfgNetwork !== undefined) {
    if (cfgNetwork || !launchNetwork) {
      maxNetwork = cfgNetwork;
    } else {
      conflicts.push(
        "max_network_access=false is narrower than launch network_access=true",
      );
    }
  }

  return {
    ceiling: {
      max_sandbox: maxSandbox,
      max_approval: maxApproval,
      max_network_access: maxNetwork,
    },
    conflict: conflicts.length === 0 ? null : conflicts.join("; "),
  };
}
