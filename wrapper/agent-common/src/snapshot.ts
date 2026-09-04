// Resume drift computation shared by both wrapper hosts (ADR-0014 F1 追補,
// phase-15 D8). Compares the resume_snapshot the runner relayed against the
// values the wrapper is enforcing this run, and produces the drift entries
// stamped into ext.resume_drift.

import type {
  EngineKind,
  PermissionAxesExt,
  ResolvedSnapshotExt,
  ResumeDriftEntry,
  ResumeDriftExt,
} from "./types.js";

/** Engine-neutral status SoT shared by state_change.ext and whoami (#113).
 *
 * `resolved` deliberately reuses the resume snapshot shape: it is the set of
 * effective values the host is enforcing now. `permission` keeps approval as
 * the second engine-neutral axis (ResolvedSnapshotExt stores only the scalar
 * sandbox field needed by drift). Claude's legacy permission_mode / fast_mode
 * remain available during their compatibility window. */
export interface EffectiveStatusSnapshot {
  engine: EngineKind;
  resolved: ResolvedSnapshotExt;
  permission?: PermissionAxesExt;
  fast_mode?: string;
}

/** The engine-neutral fields exposed by the read-only whoami tool. */
export interface EffectiveWhoamiFields {
  engine: EngineKind;
  model?: string;
  model_source?: NonNullable<ResolvedSnapshotExt["model_source"]>;
  effort?: string;
  effort_source?: NonNullable<ResolvedSnapshotExt["effort_source"]>;
  permission_mode?: NonNullable<ResolvedSnapshotExt["permission_mode"]>;
  permission?: PermissionAxesExt;
  network_access?: boolean;
  fast_mode?: string;
}

/** Projects one effective snapshot onto state_change.ext. The top-level
 * model/source/effort fields are compatibility/display indexes; `effective`
 * remains the resolved snapshot used by resume drift. */
export function effectiveStatusEnvelopeFields(
  snapshot: EffectiveStatusSnapshot,
): Record<string, unknown> {
  const { resolved } = snapshot;
  return {
    engine: snapshot.engine,
    ...(resolved.model === undefined ? {} : { model: resolved.model }),
    ...(resolved.model_source === undefined
      ? {}
      : { model_source: resolved.model_source }),
    ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
    ...(resolved.effort_source === undefined
      ? {}
      : { effort_source: resolved.effort_source }),
    ...(resolved.permission_mode === undefined
      ? {}
      : { permission_mode: resolved.permission_mode }),
    ...(snapshot.permission === undefined
      ? {}
      : { permission: snapshot.permission }),
    ...(snapshot.fast_mode === undefined
      ? {}
      : { fast_mode: snapshot.fast_mode }),
    effective: { ...resolved },
  };
}

/** Projects the same SoT onto whoami. permission.sandbox is authoritative,
 * while network_access stays a separate axis because it is not part of the
 * permission pair. Unknown values are omitted rather than guessed. */
export function effectiveStatusWhoamiFields(
  snapshot: EffectiveStatusSnapshot,
): EffectiveWhoamiFields {
  const { resolved } = snapshot;
  return {
    engine: snapshot.engine,
    ...(resolved.model === undefined ? {} : { model: resolved.model }),
    ...(resolved.model_source === undefined
      ? {}
      : { model_source: resolved.model_source }),
    ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
    ...(resolved.effort_source === undefined
      ? {}
      : { effort_source: resolved.effort_source }),
    ...(resolved.permission_mode === undefined
      ? {}
      : { permission_mode: resolved.permission_mode }),
    ...(snapshot.permission === undefined
      ? {}
      : { permission: snapshot.permission }),
    ...(resolved.network_access === undefined
      ? {}
      : { network_access: resolved.network_access }),
    ...(snapshot.fast_mode === undefined
      ? {}
      : { fast_mode: snapshot.fast_mode }),
  };
}

const SNAPSHOT_FIELDS: (keyof ResolvedSnapshotExt)[] = [
  "model",
  "model_source",
  "effort",
  "effort_source",
  "permission_mode",
  "sandbox",
  "network_access",
  "approval",
];

/** Field-wise comparison of a resume snapshot and this run's effective
 *  values. Only fields whose stored values differ are returned; a field
 *  absent from BOTH sides is not drift. `undefined` vs a real value IS
 *  drift — an intentional switch would have written the value on the
 *  snapshot side too (mid-session set_* land there, per director
 *  clarification). Order follows SNAPSHOT_FIELDS for deterministic
 *  output. */
export function computeResumeDrift(
  snapshot: ResolvedSnapshotExt,
  effective: ResolvedSnapshotExt,
): ResumeDriftExt {
  const drift: ResumeDriftEntry[] = [];
  for (const field of SNAPSHOT_FIELDS) {
    const prev = snapshot[field];
    const now = effective[field];
    if (prev === undefined && now === undefined) continue;
    if (prev === now) continue;
    drift.push({ field, prev, now });
  }
  return drift;
}
