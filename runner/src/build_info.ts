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

/** Value domain for `revision` (issue #228 round 2, ふじ MF-3 差し戻し):
 *  either the literal "unknown" or a lowercase 40-hex-digit git SHA.
 *  Mirrors `KaoiroServer.BuildIdentity.valid_revision?/1` (server's own
 *  build-info.json read and its runner_channel.ex register parse) — kept
 *  as an independently-authored duplicate, not a shared import, since this
 *  file ships inside the tarball's dist/ and must not reach outside its
 *  pnpm-deploy-pruned package boundary at runtime (see the module doc
 *  comment above). */
const BUILD_REVISION_RE = /^[0-9a-f]{40}$/;

/** Value domain for `built_at` (issue #228 round 3, ふじ 差し戻し MF-4):
 *  the exact `new Date().toISOString()` shape generate-build-info.mjs
 *  produces, or the literal "unknown" (`UNKNOWN_BUILD_INFO`'s own value).
 *  Diagnostic-only does NOT mean "any string" — an arbitrary value like
 *  "tomorrow" or "" previously passed the bare `typeof === "string"`
 *  check. */
const BUILT_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isBuildInfoShape(value: unknown): value is BuildInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.revision === "string" &&
    (v.revision === "unknown" || BUILD_REVISION_RE.test(v.revision)) &&
    typeof v.dirty === "boolean" &&
    typeof v.built_at === "string" &&
    (v.built_at === "unknown" || BUILT_AT_RE.test(v.built_at))
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

/** The human-facing canonical string form of a revision — `--version`
 *  output and the startup log line both use this. The register payload
 *  does NOT (issue #228 round 2 advisory 1, ふじ 差し戻し: this doc
 *  previously claimed it did) — `buildRegister` (config.ts) sends
 *  `build_revision`/`build_dirty` as two SEPARATE wire fields (the raw
 *  revision, undecorated) so the dashboard can independently compare
 *  revision-equality and dirty-flag, rather than parsing a combined
 *  human-readable string back apart. Same `$rev-dirty` suffix convention
 *  and same full-SHA format as scripts/build-runner-tarball.sh's VERSION
 *  file, since both now read the same dist/build-info.json (issue #228). */
export function formatBuildRevision(info: BuildInfo): string {
  return info.dirty ? `${info.revision}-dirty` : info.revision;
}
