import type {
  PermissionControlExt,
  PermissionControlStatus,
  PermissionObservation,
  PermissionSelection,
  PermissionSubmission,
  PermissionSyncMessage,
} from "@kaoiro/protocol";
import { effectiveNetworkAccess } from "./network_access.js";

export type PermissionCurrent = {
  submission: PermissionSubmission;
  status: PermissionControlStatus;
  observation: PermissionObservation | null;
  reason?: string;
};

export type PermissionState = {
  syncSupported: boolean;
  /** Keeps a legacy host from regressing to launch values after it has
   * accepted permission-control state. */
  hasControl: boolean;
  latest: PermissionControlExt | null;
  next: PermissionSelection;
  current: PermissionCurrent | null;
  lastEffective: PermissionObservation | null;
  appliedRevisions: ReadonlySet<number>;
  blocked: { revision: number; reason: string } | null;
};

export type PermissionProjection = {
  control: PermissionControlExt | null;
  observation: PermissionObservation | null;
  intentional: { sandbox: boolean; networkAccess: boolean };
  usesLegacyFallback: boolean;
};

const CONSTRAINTS = { approval: "never", enforcement: "os" } as const;

function clonedRevisions(revisions: ReadonlySet<number>): Set<number> {
  return new Set(revisions);
}

function withLastEffective<T extends object>(
  value: T,
  lastEffective: PermissionObservation | null,
): T & { last_effective?: PermissionObservation } {
  return lastEffective === null
    ? value
    : { ...value, last_effective: lastEffective };
}

export function samePermissionSelection(
  left: PermissionSelection,
  right: PermissionSelection,
): boolean {
  return left.revision === right.revision &&
    left.requested.sandbox === right.requested.sandbox &&
    left.requested.network_access === right.requested.network_access;
}

function pendingControl(
  selection: PermissionSelection,
  lastEffective: PermissionObservation | null,
): PermissionControlExt {
  return withLastEffective({
    ...selection,
    constraints: CONSTRAINTS,
    status: "pending" as const,
  }, lastEffective);
}

export function createPermissionState(
  baseline: PermissionSelection,
  syncSupported: boolean,
): PermissionState {
  return {
    syncSupported,
    hasControl: syncSupported,
    latest: syncSupported ? pendingControl(baseline, null) : null,
    next: baseline,
    current: null,
    lastEffective: null,
    appliedRevisions: new Set(),
    blocked: null,
  };
}

export function permissionControlProgress(status: PermissionControlStatus): number {
  switch (status) {
    case "pending":
      return 0;
    case "applying":
      return 1;
    case "applied":
    case "failed":
    case "unknown":
      return 2;
  }
}

function acceptsControl(
  current: PermissionControlExt | null,
  incoming: PermissionControlExt,
): boolean {
  if (current === null) return true;
  if (incoming.revision !== current.revision) {
    return incoming.revision > current.revision;
  }
  const currentProgress = permissionControlProgress(current.status);
  const incomingProgress = permissionControlProgress(incoming.status);
  return incomingProgress > currentProgress;
}

/** The only permitted source of a lower next selection is the server's
 * explicit pre-application rollback record. */
export function isDefinitivePreApplicationRejection(
  control: PermissionControlExt,
  latestRevision: number,
): boolean {
  return control.status === "failed" &&
    control.rolled_back_to !== undefined &&
    control.revision >= latestRevision;
}

function historicalObservation(
  control: PermissionControlExt,
): PermissionObservation | null {
  if (control.status === "applied") return control.effective;
  return control.last_effective ?? null;
}

function retainHistory(
  state: PermissionState,
  control: PermissionControlExt,
): Pick<PermissionState, "lastEffective" | "appliedRevisions"> {
  const historical = historicalObservation(control);
  const revisions = clonedRevisions(state.appliedRevisions);
  if (historical !== null) {
    if (historical.revision > 0) revisions.add(historical.revision);
    return {
      lastEffective: state.current === null ? historical : state.lastEffective,
      appliedRevisions: revisions,
    };
  }
  return { lastEffective: state.lastEffective, appliedRevisions: revisions };
}

export function requestPermission(
  state: PermissionState,
  selection: PermissionSelection,
): PermissionState {
  const latestRevision = state.latest?.revision ?? 0;
  if (selection.revision <= latestRevision) return state;
  return {
    ...state,
    hasControl: true,
    latest: pendingControl(selection, state.lastEffective),
    next: selection,
    blocked: state.blocked !== null && selection.revision > state.blocked.revision
      ? null
      : state.blocked,
  };
}

export function setPermissionSyncSupport(
  state: PermissionState,
  syncSupported: boolean,
): PermissionState {
  if (state.syncSupported === syncSupported) return state;
  return {
    ...state,
    syncSupported,
    hasControl: state.hasControl || syncSupported,
    latest: syncSupported && state.latest === null
      ? pendingControl(state.next, state.lastEffective)
      : state.latest,
  };
}

export function applyPermissionSyncState(
  state: PermissionState,
  message: PermissionSyncMessage,
): PermissionState {
  if (!state.syncSupported) return state;
  if (message.control === null) {
    if (message.next === null) {
      return state.latest === null || state.latest.revision === 0
        ? {
            ...state,
            hasControl: true,
            latest: pendingControl(state.next, state.lastEffective),
          }
        : state;
    }
    return state;
  }

  const incoming = message.control;
  const previousLatestRevision = state.latest?.revision ?? 0;
  const acceptsIncoming = acceptsControl(state.latest, incoming);
  const latest = acceptsIncoming ? incoming : state.latest;
  const history = acceptsIncoming ? retainHistory(state, incoming) : {
    lastEffective: state.lastEffective,
    appliedRevisions: state.appliedRevisions,
  };
  const acceptsRollback = isDefinitivePreApplicationRejection(
    incoming,
    previousLatestRevision,
  );
  const next = acceptsRollback || message.next.revision >= state.next.revision
    ? message.next
    : state.next;
  const failedCurrent = acceptsIncoming &&
    (incoming.status === "failed" || incoming.status === "unknown") &&
    samePermissionSelection(incoming, next);
  const clearsBlocked = acceptsIncoming &&
    state.blocked !== null &&
    next.revision > state.blocked.revision;
  const blocked = clearsBlocked ? null : state.blocked;

  return {
    ...state,
    hasControl: true,
    latest,
    next,
    ...history,
    // A server-accepted later revision supersedes an earlier fail-closed
    // block even when the operator's relay arrived through a reconnect sync.
    blocked: blocked ?? (failedCurrent
      ? { revision: incoming.revision, reason: incoming.reason }
      : null),
  };
}

export function beginPermissionExecution(
  state: PermissionState,
  submission: PermissionSubmission,
): PermissionState {
  return {
    ...state,
    current: { submission, status: "applying", observation: null },
    lastEffective: state.current?.observation ?? state.lastEffective,
  };
}

export function permissionObservationApplied(
  state: PermissionState,
  observation: PermissionObservation,
): { state: PermissionState; emitAudit: boolean } {
  const revisions = clonedRevisions(state.appliedRevisions);
  const emitAudit = observation.revision > 0 && !revisions.has(observation.revision);
  if (observation.revision > 0) revisions.add(observation.revision);
  return {
    emitAudit,
    state: {
      ...state,
      current: {
        submission: observation,
        status: "applied",
        observation,
      },
      appliedRevisions: revisions,
    },
  };
}

export function permissionObservationFailed(
  state: PermissionState,
  submission: PermissionSubmission,
  reason: string,
  observation: PermissionObservation | null,
): PermissionState {
  const status = observation === null ? "unknown" : "failed";
  const isNext = samePermissionSelection(state.next, submission);
  return {
    ...state,
    current: { submission, status, observation, reason },
    blocked: isNext ? { revision: submission.revision, reason } : state.blocked,
  };
}

function projectCurrent(
  latest: PermissionControlExt,
  current: PermissionCurrent,
  lastEffective: PermissionObservation | null,
): PermissionControlExt {
  const base = permissionControlBase(latest, lastEffective);
  switch (current.status) {
    case "applying":
      return {
        ...base,
        status: "applying" as const,
        submitted: current.submission,
      };
    case "applied":
      if (current.observation === null) {
        throw new Error("applied permission state requires an observation");
      }
      return {
        ...base,
        status: "applied" as const,
        submitted: current.submission,
        effective: current.observation,
      };
    case "failed":
      return {
        ...base,
        status: "failed" as const,
        submitted: current.submission,
        ...(current.observation === null ? {} : { effective: current.observation }),
        reason: current.reason ?? "policy_mismatch",
      };
    case "unknown":
      return {
        ...base,
        status: "unknown" as const,
        submitted: current.submission,
        reason: current.reason ?? "observation_unavailable",
      };
    case "pending":
      return {
        ...base,
        status: "pending" as const,
        submitted: current.submission,
        ...(current.observation === null ? {} : { effective: current.observation }),
      };
  }
}

function projectHistorical(
  latest: PermissionControlExt,
  current: PermissionCurrent | null,
  lastEffective: PermissionObservation | null,
): PermissionControlExt {
  const base = permissionControlBase(latest, lastEffective);
  if (latest.status === "pending") {
    return {
      ...base,
      status: "pending",
      ...(current === null ? {} : { submitted: current.submission }),
      ...(current?.observation === null || current === null
        ? {}
        : { effective: current.observation }),
    };
  }
  if (latest.status === "failed") {
    return {
      ...base,
      status: "failed",
      ...(latest.submitted === undefined ? {} : { submitted: latest.submitted }),
      reason: latest.reason,
      ...(latest.rolled_back_to === undefined
        ? {}
        : { rolled_back_to: latest.rolled_back_to }),
    };
  }
  if (latest.status === "unknown") {
    return {
      ...base,
      status: "unknown",
      submitted: latest.submitted,
      reason: latest.reason,
    };
  }
  // A sync's applied/applying record belongs to a previous process. Reassert
  // its raw next selection instead of presenting its observation as current.
  return pendingControl(
    { revision: latest.revision, requested: latest.requested },
    lastEffective,
  );
}

function permissionControlBase(
  selection: PermissionSelection,
  lastEffective: PermissionObservation | null,
): {
  revision: number;
  requested: PermissionSelection["requested"];
  constraints: typeof CONSTRAINTS;
  last_effective?: PermissionObservation;
} {
  return withLastEffective({
    revision: selection.revision,
    requested: selection.requested,
    constraints: CONSTRAINTS,
  }, lastEffective);
}

export function projectPermissionState(state: PermissionState): PermissionProjection {
  const current = state.current;
  const observation = current?.observation ?? null;
  const currentOwnsLatest = current !== null && state.latest !== null &&
    samePermissionSelection(current.submission, state.latest);
  const control = state.latest === null
    ? null
    : currentOwnsLatest
      ? projectCurrent(state.latest, current!, state.lastEffective)
      : projectHistorical(state.latest, current, state.lastEffective);
  const submission = current?.submission;
  return {
    control,
    observation,
    intentional: {
      sandbox: observation !== null && submission !== undefined &&
        submission.revision > 0 &&
        observation.permission.sandbox === submission.requested.sandbox,
      networkAccess: observation !== null && submission !== undefined &&
        submission.revision > 0 &&
        observation.network_access === effectiveNetworkAccess(
          submission.requested.sandbox,
          submission.requested.network_access,
        ),
    },
    usesLegacyFallback: !state.hasControl && !state.syncSupported && observation === null,
  };
}
