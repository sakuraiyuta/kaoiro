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
   *  the wire or included in the canonical `--version` label; read this file
   *  directly for build time. */
  built_at: string;
  /** CalVer project version from the monorepo VERSION file. Optional for
   *  pre-#288 artifacts; generated builds carry it with `channel`. */
  version?: string;
  /** Build channel derived from git state and the matching release tag. */
  channel?: "dev" | "release";
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
const BUILD_VERSION_RE = /^\d{4}\.(?:[1-9]|1[0-2])\.\d+$/;

/** Value domain for `built_at` (issue #228 round 4, ふじ 差し戻し): the
 *  exact `new Date().toISOString()` value generate-build-info.mjs
 *  produces, or the literal "unknown" (`UNKNOWN_BUILD_INFO`'s own value).
 *  round 3's shape-only regex (`/^\d{4}-\d{2}-\d{2}T.../`) matched
 *  syntactically ISO-looking but calendrically impossible strings like
 *  "2026-99-99T99:99:99.999Z" — a regex checks DIGIT POSITIONS, not
 *  whether the date is real. Round-tripping through `Date` (parse, check
 *  finiteness, re-serialize, compare) is what actually pins "this is
 *  the exact string `toISOString()` would produce", closing that gap
 *  without re-deriving ISO-8601's calendar rules by hand. */
function isValidBuiltAt(value: string): boolean {
  if (value === "unknown") return true;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isValidBuildVersion(value: unknown): value is string {
  return value === "unknown" || (typeof value === "string" && BUILD_VERSION_RE.test(value));
}

function isValidBuildChannel(value: unknown): value is "dev" | "release" {
  return value === "dev" || value === "release";
}

/** A release label is meaningful only when its provenance fields prove it. */
export function isBuildInfoConsistent(
  info: Pick<BuildInfo, "revision" | "dirty" | "version" | "channel">,
): boolean {
  if (info.channel === undefined || info.version === undefined) return true;
  return (
    info.channel !== "release" ||
    (!info.dirty && info.revision !== "unknown" && info.version !== "unknown")
  );
}

function isBuildInfoShape(value: unknown): value is BuildInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const hasVersion = Object.hasOwn(v, "version");
  const hasChannel = Object.hasOwn(v, "channel");
  return (
    typeof v.revision === "string" &&
    (v.revision === "unknown" || BUILD_REVISION_RE.test(v.revision)) &&
    typeof v.dirty === "boolean" &&
    typeof v.built_at === "string" &&
    isValidBuiltAt(v.built_at) &&
    hasVersion === hasChannel &&
    (!hasVersion ||
      (isValidBuildVersion(v.version) &&
        isValidBuildChannel(v.channel) &&
        isBuildInfoConsistent({
          revision: v.revision as string,
          dirty: v.dirty as boolean,
          version: v.version as string,
          channel: v.channel as "dev" | "release",
        })))
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

/** The human-facing string form of a revision — the startup log line uses
 *  this for backwards-compatible provenance output. The register payload
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

/** Canonical human-facing runner identity (issue #288). Keep the raw
 *  revision/dirty fields available separately for machine consumers; this
 *  label is for `--version` and operator-facing build information only. */
export function formatBuildIdentity(info: BuildInfo): string {
  const version = info.version ?? "unknown";
  const channel = info.channel ?? "dev";
  const shortHash =
    info.revision === "unknown" ? "unknown" : info.revision.slice(0, 7);
  return `kaoiro ${channel} runner v${version} / ${shortHash}`;
}
