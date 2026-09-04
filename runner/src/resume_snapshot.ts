// Resume snapshot validation + engine-aware apply (ADR-0014 F1 追補,
// resume-privilege-restoration + P1 pair-aware apply). Pure helpers so the
// supervisor and its tests can reason about the snapshot rules in isolation.
//
// Contract (藤 D1/D2 + phase-23 P1 拡張):
// - `validateResolvedSnapshot(raw)` sanitizes an inbound `resume_snapshot`
//   object to the known 8 ResolvedSnapshotExt fields whose values pass a
//   closed-enum / boolean / non-empty-string guard. Unknown or malformed
//   entries are dropped with a stderr warn (write-side defense already
//   fires in `SessionPointers.record_snapshot`; this is read-side
//   defense-in-depth). Non-object input returns null so the caller can
//   distinguish "absent / malformed whole" from "empty after sanitize".
// - `applyResumeSnapshot(parsed, snapshot, engine)` projects the engine-
//   relevant P0 privilege axes back onto the ParsedSpawn: Codex sandbox +
//   network_access, Claude permission_mode. `snapshot === null` is a
//   no-op (fresh spawn / crash-restart / rollback). `snapshot` present
//   but field absent/invalid falls to the SAFE engine default (never a
//   stale privileged value): Codex `workspace-write` / `false`, Claude
//   `default`. Explicit `false` is preserved (D2, truthy-drop禁止 pin).
//   P1 (phase-23): both engines additionally receive `model` /
//   `model_source` / `effort` / `effort_source` under the 5-case pair rule
//   documented in `computePair`.

import type {
  EngineKind,
  ModelSource,
  PermissionAxesExt,
  PermissionMode,
  ResolvedSnapshotExt,
} from "@kaoiro/protocol";
import type { ParsedSpawn } from "./supervisor.js";

/** Closed enums mirror `@kaoiro/protocol` value sets. Duplicated as
 *  runtime arrays because the protocol package is types-only (same
 *  pattern as `PERMISSION_MODE_VALUES` in supervisor.ts). */
const SANDBOX_VALUES: readonly string[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

const PERMISSION_MODE_VALUES: readonly string[] = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "auto",
  "bypassPermissions",
];

const MODEL_SOURCE_VALUES: readonly string[] = [
  "launch",
  "env",
  "config",
  "default",
];

/** Antigravity-only approval axis (ADR-0057 F4c). A subset of
 *  `PermissionAxesExt["approval"]` — `on-failure` is deliberately
 *  excluded: this engine rejects it at spawn (Stage A offers only these
 *  three values). */
const APPROVAL_VALUES: readonly string[] = [
  "untrusted",
  "on-request",
  "never",
];

const KNOWN_FIELDS: readonly (keyof ResolvedSnapshotExt)[] = [
  "model",
  "model_source",
  "effort",
  "effort_source",
  "permission_mode",
  "sandbox",
  "network_access",
  "approval",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnownField(key: string): key is keyof ResolvedSnapshotExt {
  return (KNOWN_FIELDS as readonly string[]).includes(key);
}

function isValidFieldValue(
  field: keyof ResolvedSnapshotExt,
  value: unknown,
): boolean {
  switch (field) {
    case "sandbox":
      return typeof value === "string" && SANDBOX_VALUES.includes(value);
    case "permission_mode":
      return (
        typeof value === "string" && PERMISSION_MODE_VALUES.includes(value)
      );
    case "model_source":
    case "effort_source":
      return typeof value === "string" && MODEL_SOURCE_VALUES.includes(value);
    case "network_access":
      return typeof value === "boolean";
    case "approval":
      return typeof value === "string" && APPROVAL_VALUES.includes(value);
    case "model":
    case "effort":
      return typeof value === "string" && value !== "";
  }
}

/** Sanitizes a raw `resume_snapshot` object from the wire. Returns null
 *  when the input is not a map (defense-in-depth against a compromised
 *  or buggy sender; the write-side gate in `SessionPointers.record_snapshot`
 *  covers the persistence path). Returns a sanitized copy otherwise —
 *  possibly empty when every field was dropped. Unknown keys and
 *  malformed values are dropped one-by-one with a stderr warn so an
 *  operator investigating drift can see which entries the runner
 *  refused. */
export function validateResolvedSnapshot(
  raw: unknown,
): ResolvedSnapshotExt | null {
  if (!isObject(raw)) return null;
  const out: ResolvedSnapshotExt = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isKnownField(key)) {
      process.stderr.write(
        `runner: resume_snapshot: dropped unknown field ${JSON.stringify(key)}\n`,
      );
      continue;
    }
    if (!isValidFieldValue(key, value)) {
      process.stderr.write(
        `runner: resume_snapshot: dropped invalid field ${JSON.stringify(
          key,
        )}=${JSON.stringify(value)}\n`,
      );
      continue;
    }
    // TS cannot narrow `out[key] = value` even after the guard; assign
    // via a widened record view.
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Engine-relevant P0 privilege axes (phase-22, ADR-0057 F4c). Codex uses
 *  the sandbox+networkAccess pair; Antigravity uses the same pair plus its
 *  own approval axis; Claude uses the permission mode. Kept in one place
 *  so any P0 scope change has a single edit site. Claude sandbox is
 *  intentionally NOT included: it is a permission_mode display mapping
 *  (ADR-0033 F2), not an independent wire input for the wrapper. */
type ClaudeApplyField = "permissionMode";
type CodexApplyField = "sandbox" | "networkAccess";
/** Antigravity additionally carries its own approval axis (ADR-0057 F4c);
 *  sandbox and networkAccess are the same fields Codex already applies. */
type AntigravityApplyField = "approval";
type P0ApplyField = ClaudeApplyField | CodexApplyField | AntigravityApplyField;

const P0_FIELDS_BY_ENGINE: Record<EngineKind, readonly P0ApplyField[]> = {
  "claude-code": ["permissionMode"],
  codex: ["sandbox", "networkAccess"],
  antigravity: ["sandbox", "approval", "networkAccess"],
};

/** P1 (phase-23): 5-case source-aware pair rule for `model` / `effort`.
 *  Returns the (value, source) pair to apply, or `null` when the pair
 *  should be cleared. The pair rule prevents `source` from ever lying —
 *  a value pinned as `source="default"` (SDK-chosen) must NOT be
 *  relaunched as an explicit config value, and a bare value with no
 *  source (legacy snapshot before source-stamping) gets a transport-
 *  provenance label of `"config"`.
 *
 *  5 cases:
 *   1. Both absent           → null. Fresh session inherits engine default.
 *   2. value + source=default → null. Prior session ran whatever SDK default
 *                               resolved to; we do NOT pin it back.
 *   3. value + explicit source (launch/config/env) → preserve verbatim.
 *   4. value only (source absent, legacy) → value + source="config" as
 *                               transport provenance.
 *   5. source only (value absent) → null + stderr warn. Semantically
 *                               impossible under the write-side gate but
 *                               caught here defensively.
 *
 *  For Claude effort, a further catalog validation runs on the wrapper
 *  side (`wrapper/claude-code/src/cli.ts`) — a value outside
 *  `CLAUDE_EFFORT_LEVELS` drops the pair before the SDK sees it. The
 *  runner cannot do this here because it does not know the engine's
 *  effort catalog; keeping the check where the catalog lives avoids
 *  duplication and cross-package coupling. */
function computePair(
  value: string | undefined,
  source: ModelSource | undefined,
  label: "model" | "effort",
): { value: string; source: ModelSource } | null {
  if (value === undefined && source === undefined) return null; // Case 1
  if (value === undefined) {
    // Case 5: source stamped but no value. Post write-side gate this
    // should not happen; the warn keeps a mis-stamping wrapper bug
    // visible instead of silently defaulting.
    process.stderr.write(
      `runner: resume_snapshot: dropped source-only pair ` +
        `${label}_source=${JSON.stringify(source)} (no matching value)\n`,
    );
    return null;
  }
  if (source === "default") return null; // Case 2
  // Case 3 (explicit source preserved) / Case 4 (legacy → "config").
  return { value, source: source ?? "config" };
}

/** Applies a sanitized resume snapshot onto a ParsedSpawn. Snapshot
 *  null/undefined is a no-op (fresh spawn / crash-restart / rollback).
 *  For resume operations (initial restore, live switch, reset) the
 *  snapshot is the SSOT: engine-relevant fields on ParsedSpawn are
 *  overwritten. Absent / invalid snapshot values fall to the SAFE
 *  engine default (never a stale privileged value from a prior
 *  entry.parsed — this is D2's "旧 danger 値保持禁止"). P1 (phase-23)
 *  adds source-aware model / effort pair apply to both engines; the
 *  Codex catalog compatibility check and the Claude effort-level filter
 *  run on the wrapper side, not here (see `computePair`). */
export function applyResumeSnapshot(
  parsed: ParsedSpawn,
  snapshot: ResolvedSnapshotExt | null | undefined,
  engine: EngineKind,
): ParsedSpawn {
  if (snapshot === null || snapshot === undefined) return parsed;
  const next: ParsedSpawn = { ...parsed };
  for (const field of P0_FIELDS_BY_ENGINE[engine]) {
    switch (field) {
      case "sandbox": {
        next.sandbox = isValidFieldValue("sandbox", snapshot.sandbox)
          ? snapshot.sandbox
          : "workspace-write";
        break;
      }
      case "networkAccess": {
        // `?? false` would also drop invalid non-boolean values silently
        // via the sanitizer; the explicit check keeps the intent visible
        // here so `network_access: false` from the snapshot is preserved
        // (truthy-drop 禁止 pin, 藤 D2).
        next.networkAccess =
          typeof snapshot.network_access === "boolean"
            ? snapshot.network_access
            : false;
        break;
      }
      case "permissionMode": {
        next.permissionMode = isValidFieldValue(
          "permission_mode",
          snapshot.permission_mode,
        )
          ? (snapshot.permission_mode as PermissionMode)
          : "default";
        break;
      }
      case "approval": {
        next.approval = isValidFieldValue("approval", snapshot.approval)
          ? (snapshot.approval as PermissionAxesExt["approval"])
          : "on-request";
        break;
      }
    }
  }
  // P1 pair-aware apply (phase-23): both engines. See `computePair` for
  // the 5-case rule.
  const modelPair = computePair(snapshot.model, snapshot.model_source, "model");
  if (modelPair !== null) {
    next.model = modelPair.value;
    next.modelSource = modelPair.source;
  } else {
    delete next.model;
    delete next.modelSource;
  }
  const effortPair = computePair(
    snapshot.effort,
    snapshot.effort_source,
    "effort",
  );
  if (effortPair !== null) {
    next.effort = effortPair.value;
    next.effortSource = effortPair.source;
  } else {
    delete next.effort;
    delete next.effortSource;
  }
  return next;
}
