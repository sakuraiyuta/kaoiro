// Resume drift computation shared by both wrapper hosts (ADR-0014 F1 追補,
// phase-15 D8). Compares the resume_snapshot the runner relayed against the
// values the wrapper is enforcing this run, and produces the drift entries
// stamped into ext.resume_drift.

import type {
  ResolvedSnapshotExt,
  ResumeDriftEntry,
  ResumeDriftExt,
} from "./types.js";

const SNAPSHOT_FIELDS: (keyof ResolvedSnapshotExt)[] = [
  "model",
  "model_source",
  "effort",
  "effort_source",
  "permission_mode",
  "sandbox",
  "network_access",
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
