// Resume snapshot validation + engine-aware apply (ADR-0014 F1 追補,
// resume-privilege-restoration). Pure helpers so the supervisor and its
// tests can reason about the snapshot rules in isolation.
//
// Contract (藤 D1/D2):
// - `validateResolvedSnapshot(raw)` sanitizes an inbound `resume_snapshot`
//   object to the known 7 ResolvedSnapshotExt fields whose values pass a
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
//   model / effort / *_source are NOT applied here (P1 scope) — they
//   ride through the sanitized snapshot into `config.resume_snapshot`
//   for the wrapper's drift stamp only.

import type {
  EngineKind,
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

const KNOWN_FIELDS: readonly (keyof ResolvedSnapshotExt)[] = [
  "model",
  "model_source",
  "effort",
  "effort_source",
  "permission_mode",
  "sandbox",
  "network_access",
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

/** Engine-relevant P0 privilege axes. Codex uses the OS sandbox pair;
 *  Claude uses the permission mode. Kept in one place so any P0 scope
 *  change (adding an axis, folding Claude sandbox in) has a single edit
 *  site. Claude sandbox is intentionally NOT included: it is a
 *  permission_mode display mapping (ADR-0033 F2), not an independent
 *  wire input for the wrapper. */
type ClaudeApplyField = "permissionMode";
type CodexApplyField = "sandbox" | "networkAccess";
type ApplyField = ClaudeApplyField | CodexApplyField;

const APPLY_FIELDS_BY_ENGINE: Record<EngineKind, readonly ApplyField[]> = {
  "claude-code": ["permissionMode"],
  codex: ["sandbox", "networkAccess"],
};

/** Applies a sanitized resume snapshot onto a ParsedSpawn. Snapshot
 *  null/undefined is a no-op (fresh spawn / crash-restart / rollback).
 *  For resume operations (initial restore, live switch, reset) the
 *  snapshot is the SSOT: engine-relevant fields on ParsedSpawn are
 *  overwritten. Absent / invalid snapshot values fall to the SAFE
 *  engine default (never a stale privileged value from a prior
 *  entry.parsed — this is D2's "旧 danger 値保持禁止"). */
export function applyResumeSnapshot(
  parsed: ParsedSpawn,
  snapshot: ResolvedSnapshotExt | null | undefined,
  engine: EngineKind,
): ParsedSpawn {
  if (snapshot === null || snapshot === undefined) return parsed;
  const fields = APPLY_FIELDS_BY_ENGINE[engine];
  const next: ParsedSpawn = { ...parsed };
  for (const field of fields) {
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
    }
  }
  return next;
}
