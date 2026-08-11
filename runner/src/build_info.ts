// Build identity (issue #228). Reads the build-time-generated
// dist/build-info.json (scripts/generate-build-info.mjs) instead of ever
// calling `git` at runtime — a live `git rev-parse HEAD` would report
// whatever the current checkout happens to be, NOT what the running
// dist/ was actually built from (a repo-direct dist/ can predate HEAD by
// days; a tarball deploy has no .git at all). Director's explicit steer,
// issue #228 query round 1: this would silently repeat the exact failure
// mode issue #227's runbook documents for file mtimes ("いつ書かれたか"
// answered, "どの commit 由来か" not) — just for git state instead of a
// timestamp.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  /** Full 40-char git SHA the running dist/ was built from, or "unknown"
   *  when generate-build-info.mjs could not determine one (git absent, or
   *  the build ran outside any checkout). Identity — see ADR note in
   *  docs/adr for why this is distinct from ADR-0015's protocol version. */
  revision: string;
  /** Whether the working tree had uncommitted changes (tracked OR
   *  untracked — issue #228, decided round 1) at build time. Diagnostic,
   *  not identity: two dirty builds of the SAME uncommitted diff are not
   *  claimed to be "the same" artifact by this flag alone. */
  dirty: boolean;
  /** ISO-8601 build timestamp. Diagnostic ONLY (issue #228, decided round
   *  1) — never compared for equality, never part of identity. Answers
   *  "how stale is this artifact", not "what commit is it". Not sent over
   *  the wire (register / --version) since those are identity surfaces;
   *  read this file directly for build time. */
  built_at: string;
}

const UNKNOWN_BUILD_INFO: BuildInfo = {
  revision: "unknown",
  dirty: false,
  built_at: "unknown",
};

function isBuildInfoShape(value: unknown): value is BuildInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.revision === "string" &&
    typeof v.dirty === "boolean" &&
    typeof v.built_at === "string"
  );
}

/** Reads build-info.json from `dir` (defaults to this compiled module's own
 *  directory, i.e. dist/ — build-info.json is a sibling written by
 *  generate-build-info.mjs during `pnpm build`). Missing file, unparsable
 *  JSON, or a malformed shape all degrade to `UNKNOWN_BUILD_INFO` rather
 *  than throwing — a runner must still start (and register/log "unknown")
 *  when the artifact wasn't built through the normal `pnpm build` path
 *  (e.g. running `tsx src/cli.ts` directly in dev). `dir` is exposed for
 *  tests to point at a fixture directory instead of the real dist/. */
export function loadBuildInfo(
  dir: string = dirname(fileURLToPath(import.meta.url)),
): BuildInfo {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "build-info.json"), "utf8");
  } catch {
    return UNKNOWN_BUILD_INFO;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNKNOWN_BUILD_INFO;
  }
  return isBuildInfoShape(parsed) ? parsed : UNKNOWN_BUILD_INFO;
}

/** The single canonical string form of a revision — `--version` output,
 *  startup log line, and the register payload's `build_revision` all use
 *  this, so the three surfaces can never drift into three different
 *  formats. Same `$rev-dirty` suffix convention and same full-SHA format
 *  as scripts/build-runner-tarball.sh's VERSION file, since both now read
 *  the same dist/build-info.json (issue #228). */
export function formatBuildRevision(info: BuildInfo): string {
  return info.dirty ? `${info.revision}-dirty` : info.revision;
}
