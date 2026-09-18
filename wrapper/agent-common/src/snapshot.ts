// Resume drift computation shared by both wrapper hosts (ADR-0014 F1 追補,
// phase-15 D8). Compares the resume_snapshot the runner relayed against the
// values the wrapper is enforcing this run, and produces the drift entries
// stamped into ext.resume_drift.

import type {
  DisplayedModelSource,
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
  /** Engine-reported model that diverges from `resolved.model` (issue #363):
   *  the engine switched on its own (Claude safeguard fallback) while the
   *  host keeps the explicit pick for relaunch. When set, ONLY the top-level
   *  display index and whoami show it, stamped `model_source: "fallback"`;
   *  `effective` (the resume snapshot) is projected from `resolved`
   *  untouched, so the pick survives a relaunch. Hosts that never diverge
   *  leave it undefined and their projection is byte-identical to before. */
  displayed_model?: string;
}

/** The engine-neutral fields exposed by the read-only whoami tool. */
export interface EffectiveWhoamiFields {
  engine: EngineKind;
  model?: string;
  model_source?: DisplayedModelSource;
  effort?: string;
  effort_source?: NonNullable<ResolvedSnapshotExt["effort_source"]>;
  permission_mode?: NonNullable<ResolvedSnapshotExt["permission_mode"]>;
  permission?: PermissionAxesExt;
  network_access?: boolean;
  fast_mode?: string;
}

/** The top-level model / model_source index shared by state_change.ext and
 *  whoami. A diverging engine-reported model replaces the value and stamps
 *  the display-only "fallback" source; otherwise the resolved pair is
 *  projected as-is. Never used for `effective`. */
function displayedModelFields(
  snapshot: EffectiveStatusSnapshot,
): Pick<EffectiveWhoamiFields, "model" | "model_source"> {
  const { resolved, displayed_model } = snapshot;
  if (displayed_model !== undefined) {
    return { model: displayed_model, model_source: "fallback" };
  }
  return {
    ...(resolved.model === undefined ? {} : { model: resolved.model }),
    ...(resolved.model_source === undefined
      ? {}
      : { model_source: resolved.model_source }),
  };
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
    ...displayedModelFields(snapshot),
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
    ...displayedModelFields(snapshot),
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
