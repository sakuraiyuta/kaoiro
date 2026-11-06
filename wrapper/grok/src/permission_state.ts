import type {
  PermissionControlExt, PermissionControlStatus, PermissionGateExt,
  PermissionObservation, PermissionSelection, PermissionSubmission,
  PermissionSyncMessage,
} from "@kaoiro/protocol";

export type PermissionCurrent = {
  submission: PermissionSubmission;
  status: PermissionControlStatus;
  observation: PermissionObservation | null;
};
export type PermissionState = {
  syncSupported: boolean;
  latest: PermissionControlExt | null;
  next: PermissionSelection | null;
  baseline: PermissionSelection;
  current: PermissionCurrent | null;
  lastEffective: PermissionObservation | null;
  appliedRevisions: ReadonlySet<number>;
  gate: PermissionGateExt | null;
};
const CONSTRAINTS = { approval: "on-request", enforcement: "os" } as const;
const rank = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
export function withinCeiling(value: PermissionSelection, ceiling: PermissionSelection): boolean {
  return rank[value.requested.sandbox] <= rank[ceiling.requested.sandbox] &&
    (!value.requested.network_access || ceiling.requested.network_access);
}
export function effectiveNetworkAccess(pair: PermissionSelection["requested"]): boolean {
  return pair.sandbox === "danger-full-access" ||
    (pair.sandbox === "workspace-write" && pair.network_access);
}
export function sameSelection(a: PermissionSelection | null, b: PermissionSelection): boolean {
  return a !== null && a.revision === b.revision &&
    a.requested.sandbox === b.requested.sandbox &&
    a.requested.network_access === b.requested.network_access;
}
function base(selection: PermissionSelection, history: PermissionObservation | null) {
  return { revision: selection.revision, requested: { ...selection.requested },
    constraints: CONSTRAINTS, ...(history ? { last_effective: history } : {}) };
}
function progress(status: PermissionControlStatus): number {
  return status === "pending" ? 0 : status === "applying" ? 1 : 2;
}
export function createPermissionState(baseline: PermissionSelection, supported: boolean): PermissionState {
  return { baseline, syncSupported: supported,
    latest: supported ? { ...base(baseline, null), status: "pending" } : null,
    next: baseline, current: null, lastEffective: null, appliedRevisions: new Set(), gate: null };
}
export function setPermissionSyncSupport(state: PermissionState, supported: boolean): PermissionState {
  return { ...state, syncSupported: supported,
    latest: supported && !state.latest
      ? { ...base(state.next ?? state.baseline, state.lastEffective), status: "pending" }
      : state.latest };
}
export function requestPermission(state: PermissionState, selection: PermissionSelection,
  refusal?: string): PermissionState {
  if (selection.revision <= (state.latest?.revision ?? 0)) return state;
  if (refusal) return { ...state,
    latest: { ...base(selection, state.lastEffective), status: "failed", reason: refusal } };
  return { ...state,
    latest: { ...base(selection, state.lastEffective), status: "pending" }, next: selection,
    gate: state.gate && selection.revision <= state.gate.revision ? state.gate : null };
}
export function applyPermissionSyncState(state: PermissionState, message: PermissionSyncMessage,
  ceiling: PermissionSelection, now: string): PermissionState {
  if (!state.syncSupported) return state;
  if (!message.control) return setPermissionSyncSupport(state, true);
  const incoming = message.control;
  const latestRevision = state.latest?.revision ?? 0;
  const accepts = !state.latest || incoming.revision > latestRevision ||
    (incoming.revision === latestRevision && progress(incoming.status) > progress(state.latest.status));
  const rollback = incoming.status === "failed" && incoming.rolled_back_to !== undefined &&
    incoming.revision >= latestRevision;
  const adoptNext = state.next === null || rollback || message.next.revision >= state.next.revision;
  const candidate = adoptNext ? message.next : state.next!;
  let gate = state.gate;
  if (!withinCeiling(candidate, ceiling)) {
    gate = { status: "blocked", reason: "awaiting_server_next", revision: candidate.revision,
      step: "next_over_ceiling", since: now };
  } else if (gate?.reason === "awaiting_server_next" || (gate && candidate.revision > gate.revision)) {
    gate = null;
  }
  if (!gate && accepts && (incoming.status === "unknown" || incoming.status === "failed") &&
    sameSelection(candidate, incoming)) {
    gate = { status: "blocked", reason: "observation_unavailable", revision: incoming.revision, since: now };
  }
  const historical = incoming.status === "applied" ? incoming.effective : incoming.last_effective;
  const applied = new Set(state.appliedRevisions);
  if (accepts && historical && historical.revision > 0) applied.add(historical.revision);
  // Not an observation: appliedRevisions stays unchanged, so the first real
  // exec of this revision can still emit an audit.
  const sameRevision = state.latest !== null && incoming.revision === state.latest.revision;
  const newerHistory = historical !== undefined && (state.lastEffective === null ||
    historical.revision > state.lastEffective.revision);
  const backfill = !accepts && state.current === null && sameRevision && newerHistory;
  const copied = backfill && historical ? historical : undefined;
  return { ...state,
    latest: accepts ? { ...incoming, constraints: CONSTRAINTS }
      : copied !== undefined && state.latest ? { ...state.latest, last_effective: copied } : state.latest,
    next: withinCeiling(candidate, ceiling) ? candidate : null, gate,
    lastEffective: accepts && historical && !state.current ? historical
      : copied !== undefined ? copied : state.lastEffective,
    appliedRevisions: applied };
}
export function capturePermission(state: PermissionState, executionId: string): PermissionSubmission | null {
  return state.gate || !state.next ? null : { ...state.next,
    requested: { ...state.next.requested }, execution_id: executionId };
}
export function beginPermissionExecution(state: PermissionState, submission: PermissionSubmission): PermissionState {
  const history = state.current?.observation ?? state.lastEffective;
  return { ...state, current: { submission, status: "applying", observation: null }, lastEffective: history,
    latest: sameSelection(state.latest, submission)
      ? { ...base(submission, history), status: "applying", submitted: submission } : state.latest };
}
export function permissionLaneFailed(state: PermissionState, submission: PermissionSubmission,
  step: PermissionGateExt["step"], now: string, reason = "restart_failed"): PermissionState {
  const isNext = sameSelection(state.next, submission);
  return { ...state,
    latest: sameSelection(state.latest, submission)
      ? { ...base(submission, state.lastEffective), status: "failed", reason } : state.latest,
    next: isNext ? null : state.next,
    gate: isNext ? { status: "blocked", reason: "awaiting_server_next",
      revision: submission.revision, ...(step ? { step } : {}), since: now } : state.gate };
}
export function permissionObservationApplied(state: PermissionState, observation: PermissionObservation):
  { state: PermissionState; emitAudit: boolean } {
  const revisions = new Set(state.appliedRevisions);
  const emitAudit = observation.revision > 0 && !revisions.has(observation.revision);
  if (observation.revision > 0) revisions.add(observation.revision);
  return { emitAudit, state: { ...state,
    current: { submission: observation, status: "applied", observation },
    lastEffective: observation, appliedRevisions: revisions,
    latest: sameSelection(state.latest, observation)
      ? { ...base(observation, state.lastEffective), status: "applied", submitted: observation, effective: observation }
      : state.latest } };
}
export function permissionObservationFailed(state: PermissionState, submission: PermissionSubmission,
  now: string): PermissionState {
  return { ...state, current: { submission, status: "unknown", observation: null },
    latest: sameSelection(state.latest, submission)
      ? { ...base(submission, state.lastEffective), status: "unknown", submitted: submission,
        reason: "observation_unavailable" } : state.latest,
    gate: sameSelection(state.next, submission)
      ? { status: "blocked", reason: "observation_unavailable", revision: submission.revision, since: now }
      : state.gate };
}
