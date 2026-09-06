#!/usr/bin/env node
// Server deploy CLI (issue #306, design per #303 comments 2026-09-06):
// one entry point for build / start / update / rollback / status, backed
// by the manifest+journal from commit (a). This commit adds the PREPARE
// half of `update` (lock, preflight, old-image save, build, maintenance
// gate) — the no-downtime steps, ending right before the stop window.
// The COMMIT half (stop/archive/up/health-poll/retention) and
// `rollback`/`status` land in later commits (commit split agreed with
// yuta 2026-09-06).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { computeBuildIdentity } from "../../scripts/build-identity.mjs";
import { BRANCH, BranchError, classify, requireRunningContainer } from "./kaoiro-deploy-branch.mjs";
import { loadConfig } from "./kaoiro-deploy-config.mjs";
import { dockerComposeContainerNames, dockerInspect, resolveDockerBin, runDocker } from "./kaoiro-deploy-docker.mjs";
import { advancePhase, readJournal, writeJournal } from "./kaoiro-deploy-journal.mjs";
import { readManifest, writeManifest } from "./kaoiro-deploy-manifest.mjs";
import { PHASE, TRANSITIONS, validateJournalAgainstStateMachine } from "./kaoiro-deploy-phase.mjs";
import { acquireLock, releaseLock } from "./kaoiro-deploy-lock.mjs";
import { findUnfinishedTransaction, newTransactionId } from "./kaoiro-deploy-transaction.mjs";

// The compose service name in server/docker-compose.yaml. Resolved through
// `docker compose ps`, never guessed as `<dir>-<service>-1`, so this is the
// only place the service name itself needs to be named.
const SERVICE = "kaoiro";
const SHA_RE = /^[0-9a-f]{40}$/;

// クロエ round 1 review N-5: pinned (not bare `alpine`, which floats) and
// pulled once, up front, during preflight — before the stop window opens,
// not implicitly by the first `docker run alpine ...` the archive step
// happens to make after the server is already down.
const ALPINE_IMAGE = "alpine:3";

export class DeployError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = 1) {
  throw new DeployError(message, exitCode);
}

function gitOutput(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch (err) {
    fail(`git ${args.join(" ")} failed in ${cwd}: ${err.message}`);
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Parses a docker inspect `{{.State.ExitCode}}`-shaped field. Returns
 *  `null` on anything that is not a plain integer string — "取得不能"
 *  (unreadable) is a real outcome (a crashed/unsupported docker, a
 *  fake binary in a test), and must stay indistinguishable from "not
 *  measured yet" rather than silently becoming 0. */
function parseDockerIntField(raw) {
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
}

/** Parses a docker inspect boolean-shaped field (`{{.State.OOMKilled}}`
 *  prints the literal strings "true"/"false"). Anything else is `null`,
 *  same reasoning as parseDockerIntField. */
function parseDockerBoolField(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

/** True only when both `a` and `b` are non-null and equal — the one
 *  place this CLI compares an EXPECTED value against an OBSERVED one
 *  (clean-stop exit code/OOM flag, stability's RestartCount). Plain
 *  `a === b` treats two unreadable values (both `null`, from
 *  parseDockerIntField/parseDockerBoolField's own "could not parse"
 *  outcome) as agreement, since `null === null` is true — exactly
 *  backwards: an unmeasured expectation must never coincide with an
 *  unreadable observation and read as "matches". クロエ round 3 review
 *  MF-3: the clean-stop check already avoided this class by checking
 *  each side for null explicitly; the stability check did not — one
 *  helper for both closes the class instead of leaving a second,
 *  independently-written version of the same guard to drift. */
function agrees(a, b) {
  return a !== null && b !== null && a === b;
}

/** Ensures ALPINE_IMAGE is present locally, pulling it if not — BEFORE
 *  the stop window opens (クロエ round 1 review N-5). `dockerInspect`
 *  throws on a missing image; that failure IS the signal to pull, not an
 *  error to propagate. A pull failure here fails the whole update before
 *  anything is stopped, rather than surfacing mid-archive with the
 *  server already down for no useful reason. */
function ensureAlpineImage(bin) {
  try {
    dockerInspect(bin, ALPINE_IMAGE, "{{.Id}}");
    return;
  } catch {
    // Falls through to the pull below.
  }
  runDocker(bin, ["pull", ALPINE_IMAGE], { stdio: "inherit" });
}

/** True blocking sleep in the main thread (no worker, no subprocess) —
 *  Node has no synchronous timer, but `Atomics.wait` on a throwaway
 *  SharedArrayBuffer blocks the calling thread for exactly `ms`, which is
 *  what a synchronous CLI polling loop needs (this whole module is
 *  execFileSync-based throughout; making runUpdate async to use a real
 *  timer would ripple through every existing call site and test). */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `curl` is a SEPARATE override seam from KAOIRO_DEPLOY_DOCKER_BIN's
 *  gated one — a health GET is read-only (no docker mutation the gate's
 *  own threat model cares about), so this needs no --config permission
 *  bit, just a way for tests to point it at a fake without touching the
 *  real network. */
function resolveCurlBin(env = process.env) {
  return env.KAOIRO_DEPLOY_CURL_BIN || "curl";
}

/** director ruling 2026-09-06, #306 (c3) review: config.health_url has
 *  no default (a hardcoded 127.0.0.1:4000 MISSES in production, where
 *  KAOIRO_PUBLISH_IP publishes on a different host) — derived instead
 *  from `docker compose port <service> 4000`, the exact fact the
 *  compose project itself holds about where it actually published the
 *  port, measured live (`docker compose port web 8080` against a real
 *  published container: prints `host:port`, e.g. `127.0.0.1:18080`).
 *  An explicit config override always wins and skips this call. */
export function resolveHealthUrl(bin, serverDir, config) {
  if (config.health_url !== null) return config.health_url;
  let hostPort;
  try {
    hostPort = runDocker(bin, ["compose", "port", SERVICE, "4000"], { cwd: serverDir });
  } catch (err) {
    fail(
      `could not resolve the published host:port for ${SERVICE} port 4000 via 'docker compose port' (set health_url explicitly via --config to skip this): ${err.message}`,
    );
  }
  if (hostPort === "") {
    fail(`'docker compose port ${SERVICE} 4000' returned no output — is the service published on that port?`);
  }
  return `http://${bracketIpv6HostPort(hostPort)}/api/health`;
}

/** クロエ round 3 review N-1: `docker compose port` reports an IPv6
 *  binding unbracketed (e.g. `:::4000` for the IPv6 wildcard address) —
 *  `http://:::4000/...` is not a valid URL (a bare host:port needs the
 *  host bracketed once it itself contains a colon). Splits on the LAST
 *  colon (an IPv6 host has more than one, so the first would cut the
 *  host in half) and brackets it unless the host is already bracketed —
 *  an IPv4 host or hostname has no colon and passes through unchanged. */
function bracketIpv6HostPort(hostPort) {
  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon === -1) {
    fail(`'docker compose port' returned a value with no host:port separator: ${hostPort}`);
  }
  const host = hostPort.slice(0, lastColon);
  const port = hostPort.slice(lastColon + 1);
  const needsBrackets = host.includes(":") && !host.startsWith("[");
  return needsBrackets ? `[${host}]:${port}` : hostPort;
}

/** `GET url`, parsed as JSON. Never throws: a curl failure (connection
 *  refused, timeout, non-2xx — `--fail` turns the latter into a non-zero
 *  exit instead of printing an error-page body that might otherwise
 *  parse as unrelated JSON) or a non-JSON body are both just "this
 *  attempt did not succeed" for pollHealth's retry loop, not a reason to
 *  abort the whole poll on the first flaky response. */
function fetchHealth(curlBin, url) {
  let raw;
  try {
    raw = execFileSync(curlBin, ["-sS", "--fail", "--max-time", "5", url], { encoding: "utf8" });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `GET ${url} did not return valid JSON: ${err.message}` };
  }
}

/** Polls `url` every `intervalMs` until it reports the target build
 *  cleanly — `build_revision === targetSha` AND `build_dirty === false`
 *  — or `timeoutMs` elapses. deployment.md 4.5's own provenance table
 *  lists BOTH as success criteria ("build_dirty is intentional ...
 *  false for a clean build at target SHA"); checking revision alone
 *  would call a dirty build at the right SHA healthy. `GET /api/health`
 *  is server/lib/kaoiro_server_web/controllers/health_controller.ex's
 *  own endpoint. Returns the matching health body; throws DeployError
 *  naming the LAST observed attempt otherwise, so a diagnosis does not
 *  have to re-run curl by hand first. */
function pollHealth(curlBin, url, targetSha, intervalMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const result = fetchHealth(curlBin, url);
    if (result.ok && result.body.build_revision === targetSha && result.body.build_dirty === false) {
      return result.body;
    }
    last = result;
    // クロエ round 3 review N-2: skip the sleep once the deadline has
    // already passed — the `while` condition rechecks it immediately
    // anyway, so sleeping here only delays reporting failure by another
    // whole intervalMs for no observation gained.
    if (Date.now() < deadline) {
      sleepMs(intervalMs);
    }
  }
  const detail =
    last === null
      ? "no attempt completed"
      : last.ok
        ? `last observed build_revision=${JSON.stringify(last.body.build_revision)}`
        : `last error: ${last.error}`;
  fail(
    `health check at ${url} did not report build_revision=${targetSha} within ${timeoutMs}ms (${detail})`,
  );
}

/** `docker inspect --format {{.RestartCount}}`, parsed the same
 *  never-silently-0 way as parseDockerIntField's other callers — an
 *  unreadable count must not read as "definitely zero restarts". */
function restartCount(bin, container) {
  return parseDockerIntField(dockerInspect(bin, container, "{{.RestartCount}}"));
}

// --- #220 absorption: persistence-path env consistency ------------------
// director ruling 2026-09-06 (turn 13, correcting the phase placement in
// an earlier ruling): checked once the target image exists (right after
// BUILD_PREPARED), not before — this is the earliest point its own
// `eval` interface can be queried at all.

/** #310 (a separate issue, not yet landed as of this commit) is expected
 *  to expose exactly this: `KaoiroServer.PersistencePaths.manifest/0`
 *  returning a list of maps with keys `:store`/`:env`/`:default_file`/
 *  `:default_path` (クロエ round 5 review A-MF-2 extends the contract with
 *  the last one — the ABSOLUTE path `runtime.exs`'s own fallback resolves
 *  to when `:env` is unset, as opposed to `:default_file`'s bare
 *  filename). Named here as the single fixed expression this file's own
 *  eval call uses (director ruling 2026-09-06, A-1) — an image built
 *  before #310 lands (or an old image a rollback targets) simply lacks
 *  this module; that is queryPersistencePaths' own "skipped" outcome, not
 *  a defect in this string. */
const PERSISTENCE_PATHS_EVAL_EXPR = "IO.puts(Jason.encode!(KaoiroServer.PersistencePaths.manifest()))";

// クロエ round 4 review A-SF-1: `entry.env` is about to be embedded into
// a RegExp (readEnvFileValue) to search `.env`'s own text — an
// unconstrained string lets a malformed (or malicious) eval response
// turn that into an arbitrary pattern (`.*` would match ANY line,
// leaking an unrelated secret line from `.env` into the recorded
// entry; `(` alone is an invalid RegExp and throws SyntaxError). Real
// env var names are POSIX-shell identifiers; restricting to that shape
// closes the class rather than escaping the string and hoping every
// future caller remembers to.
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isValidPersistencePathEntry(entry) {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.store === "string" &&
    entry.store !== "" &&
    typeof entry.env === "string" &&
    ENV_VAR_NAME_RE.test(entry.env) &&
    typeof entry.default_file === "string" &&
    entry.default_file !== "" &&
    // A-MF-2: the running container's own fallback when `entry.env` is
    // unset — required so checkEnvConsistency can tell "the container
    // never had this env set, but is still reading the same place
    // compose now declares" (no migration needed) apart from "compose
    // just moved this store to a genuinely different place" (5-b).
    typeof entry.default_path === "string" &&
    entry.default_path !== ""
  );
}

/** Queries `imageId`'s own canonical persistence-path list: `docker run
 *  --rm --entrypoint /app/bin/kaoiro_server <imageId> eval
 *  '<PERSISTENCE_PATHS_EVAL_EXPR>'`, addressed by Id (never a tag, which
 *  can move — director ruling 2026-09-06, A-1) so this always queries
 *  the EXACT image about to run. No env vars are passed; the list this
 *  queries is static, not env-dependent.
 *
 *  Two failure modes, deliberately handled differently:
 *  - the eval PROCESS itself exits non-zero: the querying module has not
 *    landed on this image (#310 — a pre-#310 image, or an old image a
 *    rollback targets). Returns `{skipped: true, reason}`, never
 *    throws — the caller proceeds without this check rather than
 *    blocking on a capability this image was never going to have.
 *  - the eval process exits 0 but stdout is not the expected JSON
 *    shape: something is actively wrong (a real bug in the module, or
 *    this expression drifting from #310's contract) — a 0 exit means
 *    the check RAN and produced garbage, materially different from "did
 *    not run", so this throws DeployError instead of skipping. */
function queryPersistencePaths(bin, imageId) {
  let raw;
  try {
    raw = runDocker(bin, [
      "run",
      "--rm",
      "--entrypoint",
      "/app/bin/kaoiro_server",
      imageId,
      "eval",
      PERSISTENCE_PATHS_EVAL_EXPR,
    ]);
  } catch (err) {
    return { skipped: true, reason: `persistence-path eval failed for image ${imageId}: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(
      `persistence-path eval for image ${imageId} exited 0 but did not print a JSON array (${err.message}): ${raw}`,
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isValidPersistencePathEntry)) {
    fail(
      `persistence-path eval for image ${imageId} exited 0 but printed an unexpected shape: ${JSON.stringify(parsed)}`,
    );
  }
  return { skipped: false, paths: parsed };
}

/** Reads `.env`'s explicit value for exactly `envName` — never the rest
 *  of the file, which may hold secrets (SECRET_KEY_BASE,
 *  KAOIRO_CLIENT_TOKENS, ...) this check has no business reading or
 *  recording (director ruling 2026-09-06, A-2). `null` when the key is
 *  absent — a legitimate "not set" observation, not a read failure.
 *  Safe to embed `envName` in a RegExp unescaped: every caller filters
 *  through `isValidPersistencePathEntry`'s ENV_VAR_NAME_RE first (クロエ
 *  round 4 review A-SF-1) — this function does not re-validate, so it
 *  must never be called on an unvalidated name. */
function readEnvFileValue(envPath, envName) {
  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return null;
  }
  const match = new RegExp(`^${envName}=(.*)$`, "m").exec(raw);
  return match === null ? null : match[1];
}

/** The compose project's own RESOLVED declaration for `SERVICE` (`.env`
 *  interpolation already applied — the same fact `docker compose up`
 *  itself would use), keyed by env var name. `docker compose config
 *  --format json` reports `services.<name>.environment` as a plain
 *  object map — measured live against the installed Docker Compose
 *  (v5.3.1, 2026-09-06), not assumed from the CLI's own docs (which do
 *  not commit to a shape, and the shape has differed across versions).
 *  Compose has also emitted the array `"KEY=VALUE"` shape across
 *  versions (the same shape `containerEffectiveEnv` already parses from
 *  `docker inspect`); both are accepted here.
 *
 *  クロエ round 5 review SF-7: the original version collapsed EVERY
 *  unexpected shape (array, a renamed/missing service, a missing
 *  `environment` key entirely) to `{}` silently. With `checkEnvConsistency`'s
 *  two-way comparison (A-MF-1), a silent `{}` either fails every entry
 *  closed (compose: null vs a real container value) or, worse, PASSES
 *  without ever actually comparing anything (both sides null) — the same
 *  "0 exit but garbage shape" class `queryPersistencePaths` already
 *  treats as a hard failure, not a skip. Same treatment here: a shape
 *  this function does not recognize is a `DeployError`, never a quiet
 *  `{}`. */
function composeDeclaredEnv(bin, serverDir) {
  let raw;
  try {
    raw = runDocker(bin, ["compose", "config", "--format", "json"], { cwd: serverDir });
  } catch (err) {
    fail(`'docker compose config' failed: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`'docker compose config' did not return valid JSON: ${err.message}`);
  }
  const service = parsed?.services?.[SERVICE];
  if (typeof service !== "object" || service === null) {
    fail(`'docker compose config' has no service named ${SERVICE}`);
  }
  if (!Object.hasOwn(service, "environment")) {
    fail(`'docker compose config' service ${SERVICE} has no environment key`);
  }
  const env = service.environment;
  if (Array.isArray(env)) {
    const result = {};
    for (const entry of env) {
      if (typeof entry !== "string") continue;
      const idx = entry.indexOf("=");
      if (idx === -1) continue;
      result[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return result;
  }
  if (env !== null && typeof env === "object") {
    return env;
  }
  fail(
    `'docker compose config' service ${SERVICE}'s environment is neither an object nor an array: ${JSON.stringify(env)}`,
  );
}

/** The container's own actual effective env, keyed by name — parses
 *  `docker inspect --format {{json .Config.Env}}`'s `"KEY=VALUE"` array
 *  shape (Docker's own long-stable Config.Env format). */
function containerEffectiveEnv(bin, container) {
  const raw = dockerInspect(bin, container, "{{json .Config.Env}}");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`could not parse '{{json .Config.Env}}' for ${container}: ${err.message}`);
  }
  const env = {};
  for (const line of parsed) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    env[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return env;
}

/** Consistency for exactly the env var names `paths` names (director
 *  ruling 2026-09-06, A-MF-1, correcting the original 3-way design;
 *  クロエ round 5 review A-MF-2, correcting A-MF-1 in turn): compose's
 *  resolved declaration vs. the CURRENTLY RUNNING (old) container's
 *  EFFECTIVE path for that store — the container's own env value if set,
 *  else the image's `default_path` for it (what the app itself falls
 *  back to). `match` is `compose === container_effective`.
 *
 *  WHY EFFECTIVE, NOT THE RAW ENV (A-MF-1's own bug): on the first
 *  application that adds a NEW persistence-path var to compose, the OLD
 *  container was never recreated with it, so its raw env can NEVER equal
 *  compose's new value — comparing raw env would fail-close EVERY
 *  legitimate first application, forever, since the raw env cannot change
 *  before the container the check reads FROM is itself recreated by the
 *  very deploy the check is gating. Comparing against the image's OWN
 *  documented fallback instead asks the right question: "is the store
 *  already effectively where compose is about to declare it" — true when
 *  compose merely started EXPLICITLY declaring what was already the
 *  default (no migration needed), false when compose names a genuinely
 *  DIFFERENT location (a real 5-b migration is needed, and the failure
 *  message below says so).
 *
 *  `compose === null` (compose does not declare this var AT ALL, for a
 *  store the image DOES require) is its own failure mode — the exact
 *  #217 class (a required persistence var silently missing from compose
 *  escapes backup). No separate `compose !== null` guard is needed to
 *  fail it: `container_effective` is never null (`default_path` is a
 *  required, non-empty field — isValidPersistencePathEntry), so `null`
 *  can never equal it and `match` already reads false on its own
 *  (measured: adding the guard back and then removing it again left
 *  every test in this file's own suite green either way).
 *
 *  `.env`'s own line is recorded as `declared` but NEVER folded into
 *  `match`: the bundled docker-compose.yaml sets every canonical
 *  persistence-path var as a LITERAL `environment:` entry (not `${VAR}`
 *  interpolation), while `.env.example`/`mix kaoiro.env` emit the same
 *  vars as commented-out hints. `declared` stays in the record purely
 *  for an operator's own reference — a value never compared, never gates
 *  the outcome. */
function checkEnvConsistency(paths, envPath, composeEnv, containerEnv) {
  const entries = {};
  for (const { env: envName, default_path: defaultPath } of paths) {
    const declared = readEnvFileValue(envPath, envName);
    const compose = Object.hasOwn(composeEnv, envName) ? composeEnv[envName] : null;
    const containerRaw = Object.hasOwn(containerEnv, envName) ? containerEnv[envName] : null;
    const containerEffective = containerRaw !== null ? containerRaw : defaultPath;
    const containerSource = containerRaw !== null ? "env" : "default";
    entries[envName] = {
      declared,
      compose,
      container_effective: containerEffective,
      container_source: containerSource,
      match: compose === containerEffective,
    };
  }
  return entries;
}

// newTransactionId()'s own format: YYYYMMDDTHHMMSSZ (its ISO timestamp
// with `-`/`:` stripped and sub-second precision dropped).
const TRANSACTION_ID_TIMESTAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

function transactionIdToDate(transactionId) {
  const m = TRANSACTION_ID_TIMESTAMP_RE.exec(transactionId);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Directory entries directly under `backupRoot` that could be a
 *  transaction directory — dotfiles (`.lock.update`) excluded, the same
 *  distrust every other reader of this directory already applies.
 *  Shared here so hasPriorTransactions/listDoneTransactionIds/
 *  pruneOldTransactions's own directory scan cannot independently drift
 *  on what counts (クロエ round 4 review SF-5: hasPriorTransactions
 *  alone had NOT excluded dotfiles, so a leftover `.lock.update` from a
 *  crashed run made a fresh host look like it already had transaction
 *  state). Returns `[]` when `backupRoot` does not exist yet. */
function listTransactionDirNames(backupRoot) {
  try {
    return readdirSync(backupRoot).filter((name) => !name.startsWith("."));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/** Transaction ids under `backupRoot` whose OWN journal is readable,
 *  self-consistent (directory name === journal.transaction_id), phase
 *  DONE, and whose id parses as a timestamp — the same distrust
 *  findUnfinishedTransaction applies, shared by pruneOldTransactions and
 *  `status`'s own listing so "what counts as a real, finished
 *  transaction" is answered in exactly one place. Sorted newest-first:
 *  transaction_id is a sortable UTC timestamp string (newTransactionId's
 *  own format), so lexicographic order IS chronological order. */
function listDoneTransactionIds(backupRoot) {
  const names = listTransactionDirNames(backupRoot);
  const doneIds = [];
  for (const name of names) {
    let journal;
    try {
      journal = readJournal(join(backupRoot, name));
    } catch {
      continue;
    }
    if (journal.transaction_id !== name || journal.phase !== PHASE.DONE) continue;
    if (transactionIdToDate(name) === null) continue;
    doneIds.push(name);
  }
  doneIds.sort();
  doneIds.reverse();
  return doneIds;
}

/** Deletes DONE transaction directories beyond `config.keep_generations`
 *  most-recent ones, but ONLY those also older than `config.retention_days`
 *  — issue #306 (c3). Requiring BOTH bounds (not either alone) is a
 *  deliberate conservative choice for a directory whose only job is to
 *  make rollback possible: a count-based prune alone could discard a
 *  same-day backup during a burst of deploys, and a pure age-based prune
 *  alone could discard the only remaining backup during a long quiet
 *  spell. Never touches a transaction that is not phase DONE (unfinished
 *  or failed transactions are a manual-investigation matter, never
 *  auto-deleted), and never touches a directory whose name does not match
 *  its own journal.transaction_id (the same distrust
 *  findUnfinishedTransaction already applies) or whose id does not parse
 *  as a timestamp.
 *
 *  `protectedTransactionId` (director ruling 2026-09-06, #306 (c3)
 *  review) is excluded from deletion by IDENTITY, never by the
 *  keep_generations/retention_days arithmetic alone — the CURRENT
 *  rollback pair (this run's own rollback_tag + archive, the ONE a
 *  rollback right after this update would actually use) must survive
 *  even a keep_generations/retention_days combination that would
 *  otherwise prune it (keep_generations already enforces a minimum of 1
 *  via the config validator, which structurally protects the newest by
 *  count alone — this is the explicit, count-independent guarantee on
 *  top of that coincidence).
 *
 *  クロエ round 3 review MF-1: a rollback_tag is
 *  `kaoiro-server:rollback-<source_sha>` (schema-enforced), so TWO DONE
 *  transactions recorded against the same source_sha (a re-deploy of the
 *  same sha — `--target` has no `!== oldSha` guard, and `merge --ff-only`
 *  onto an unchanged sha is a legal no-op) share ONE tag. Protecting only
 *  `protectedTransactionId`'s own DIRECTORY was not enough — pruning an
 *  OLDER same-sha transaction still `rmi`'d the tag the newer, retained
 *  one needed. Tags are now protected by VALUE: before any `rmi`, this
 *  scans EVERY directory under `backupRoot` (not just doneIds — an
 *  unfinished or failed transaction, unreadable journal, mismatched
 *  transaction_id, or unparsable name all still occupy a directory this
 *  run will not touch, and an unfinished one may need its tag more than
 *  any DONE one does) that is not itself about to be pruned this run, and
 *  collects the rollback_tag from every manifest.json among them that can
 *  be read. Only a tag NOT in that surviving set is ever `rmi`'d.
 *
 *  Each actually-pruned transaction's own `docker tag` (read from its
 *  manifest, never rediscovered by globbing docker's image list — a glob
 *  risks matching an unrelated same-named image) is removed via `bin`
 *  before its directory goes, best-effort: an already-gone or
 *  still-referenced tag must not block reclaiming the directory itself.
 *
 *  クロエ round 3 review SF-2: only the `rmi` itself is best-effort. A
 *  transaction whose own manifest.json cannot be read is left ENTIRELY
 *  alone (no rmi attempt — its tag is unknown — and no directory
 *  deletion) rather than deleting an orphan; `status`'s own transaction
 *  listing already surfaces an undeleted, manifest-less directory (null
 *  facts) for investigation, so this returns it under `skipped` rather
 *  than reporting nothing.
 *
 *  Returns `{ removed, skipped }`: `removed` is the transaction ids
 *  whose directory was actually deleted; `skipped` is prune-eligible ids
 *  left in place because their own manifest could not be read, each with
 *  the read failure's message. */
export function pruneOldTransactions(backupRoot, config, protectedTransactionId, bin) {
  const doneIds = listDoneTransactionIds(backupRoot);
  const retentionMs = config.retention_days * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const pruneCandidates = [];
  for (const name of doneIds.slice(config.keep_generations)) {
    if (name === protectedTransactionId) continue;
    const age = now - transactionIdToDate(name).getTime();
    if (age < retentionMs) continue;
    pruneCandidates.push(name);
  }
  const pruneSet = new Set(pruneCandidates);
  const allNames = listTransactionDirNames(backupRoot);
  const remainingTags = new Set();
  for (const name of allNames) {
    if (pruneSet.has(name)) continue;
    try {
      remainingTags.add(readManifest(join(backupRoot, name)).rollback_tag);
    } catch {
      // No manifest (or unreadable) means no tag claim from this
      // directory — a bare directory identity is not a tag record.
    }
  }

  const removed = [];
  const skipped = [];
  for (const name of pruneCandidates) {
    const dir = join(backupRoot, name);
    let rollbackTag;
    try {
      rollbackTag = readManifest(dir).rollback_tag;
    } catch (err) {
      skipped.push({ id: name, reason: err.message });
      continue;
    }
    if (!remainingTags.has(rollbackTag)) {
      // director ruling 2026-09-06: the tag to remove is READ from this
      // transaction's own manifest, never derived by globbing docker's
      // image list — a glob risks matching (and deleting) an unrelated
      // image an operator happens to have named similarly. Best-effort:
      // an already-removed tag, or one still referenced by something
      // else, must not block reclaiming the DIRECTORY (the actual
      // disk-space win this function exists for).
      try {
        runDocker(bin, ["rmi", rollbackTag]);
      } catch {
        // Intentionally ignored — see comment above.
      }
    }
    rmSync(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return { removed, skipped };
}

const VALUE_FLAGS = new Set(["--config", "--repo", "--target", "--transaction"]);
const BOOL_FLAGS = new Map([
  ["--dry-run", "dryRun"],
  ["--maintenance-approved", "maintenanceApproved"],
  ["--confirm-restore", "confirmRestore"],
  ["--initialize", "initialize"],
]);

/** Parses `<command> [flags...]`. A value flag whose value itself starts
 *  with `-` is rejected — the same reasoning as
 *  kaoiro-runner-common.sh's kaoiro_reject_option_like: a missing value
 *  must never silently consume the next flag as its own argument. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) fail("usage: kaoiro-server-deploy <command> [flags...]", 64);
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith("-")) {
        fail(`${arg} needs a value`, 64);
      }
      flags[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      continue;
    }
    if (BOOL_FLAGS.has(arg)) {
      flags[BOOL_FLAGS.get(arg)] = true;
      continue;
    }
    fail(`unknown argument: ${arg}`, 64);
  }
  return { command, flags };
}

/** `docker version` needs the daemon; formatting `.Server.Version`
 *  specifically fails (non-zero exit) when it cannot be reached —
 *  measured live against a deliberately-broken DOCKER_HOST, 2026-09-06
 *  — giving a clean, version-independent "is docker reachable at all"
 *  probe distinct from "the specific thing I asked for does not exist"
 *  (a missing volume/image both fail differently and depend on parsing
 *  docker's own error text, which is not something to rely on here). */
function isDockerReachable(bin) {
  try {
    runDocker(bin, ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the ACTUAL docker volume name compose would attach `SERVICE`
 *  to at `/var/lib/kaoiro` — never a guessed `<dir>-<service>-1`-style
 *  name. `docker compose config --format json` already reports the
 *  fully-resolved name directly at `volumes.<declared-name>.name`
 *  (measured live, Docker Compose v5.3.1, 2026-09-06: a compose file
 *  declaring `kaoiro-state` under a project named `ao306-compose-probe2`
 *  reports `volumes: { "kaoiro-state": { "name":
 *  "ao306-compose-probe2_kaoiro-state" } }`) — no need to hand-compute
 *  `<project>_<volume>` and risk drifting from compose's own naming
 *  rules. Matches on the service's OWN mount destination
 *  (`/var/lib/kaoiro`), the same target this file's other mount
 *  resolutions already key on. Returns `{ok: false, reason}` on
 *  anything unexpected — a caller must never treat that as "no volume
 *  configured". */
function resolveNamedVolumeFromCompose(bin, serverDir) {
  let raw;
  try {
    raw = runDocker(bin, ["compose", "config", "--format", "json"], { cwd: serverDir });
  } catch (err) {
    return { ok: false, reason: `'docker compose config' failed: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `'docker compose config' did not return valid JSON: ${err.message}` };
  }
  const serviceVolumes = parsed?.services?.[SERVICE]?.volumes;
  const mount = Array.isArray(serviceVolumes)
    ? serviceVolumes.find((v) => v.target === "/var/lib/kaoiro")
    : undefined;
  if (mount === undefined || mount.type !== "volume") {
    return { ok: false, reason: `compose config has no named-volume mount at /var/lib/kaoiro for service ${SERVICE}` };
  }
  const resolvedName = parsed?.volumes?.[mount.source]?.name;
  if (typeof resolvedName !== "string" || resolvedName === "") {
    return { ok: false, reason: `compose config's volumes entry for ${mount.source} has no resolved name` };
  }
  return { ok: true, name: resolvedName };
}

/** `docker volume inspect <name>` — existence only (measured live: exits
 *  0 for an existing volume, 1 with "no such volume" for a missing one).
 *  Never inspects CONTENTS, never pulls an image, never starts anything
 *  — `status`, a read-only diagnostic, is one of this function's two
 *  callers. */
function namedVolumeExists(bin, volumeName) {
  try {
    runDocker(bin, ["volume", "inspect", volumeName]);
    return true;
  } catch {
    return false;
  }
}

/** Whether prior deployment state exists for this compose project —
 *  CLI-managed transaction state under `backupRoot` (dotfiles excluded),
 *  OR the named volume `SERVICE` mounts at `/var/lib/kaoiro` (existence
 *  only). クロエ round 4 review N-3 (revised after a live measurement):
 *  the ORIGINAL version of this function looked at `backupRoot` alone,
 *  which classify()'s own contract ("manifest OR non-empty volume")
 *  never actually satisfied — a host that ran `start --initialize`
 *  once, never ran `update` since (so `backupRoot` stays empty), and
 *  whose container later disappeared would misreport as BRANCH C FRESH,
 *  and following FRESH's own guidance (`start --initialize` again) would
 *  re-initialize over the live state still sitting in that volume — the
 *  dangerous direction.
 *
 *  Returns `null` (never `false`) when docker is unreachable or
 *  `docker compose config` itself fails — an unknown answer must never
 *  resolve to FRESH, and `classify()`'s own tri-state contract already
 *  expects exactly this. */
export function hasPriorTransactions(bin, serverDir, backupRoot) {
  if (listTransactionDirNames(backupRoot).length > 0) return true;
  if (!isDockerReachable(bin)) return null;
  const volume = resolveNamedVolumeFromCompose(bin, serverDir);
  if (!volume.ok) return null;
  return namedVolumeExists(bin, volume.name);
}

function resolveBackupRoot(config) {
  if (config.backup_root !== null) {
    // Defense in depth alongside kaoiro-deploy-config.mjs's own VALIDATORS
    // check (クロエ round 1 review SF-6): a config object built
    // programmatically (not through loadConfig) never passes through that
    // validator at all, so this must not be the only place that rejects a
    // relative path before anything mutates.
    if (!isAbsolute(config.backup_root)) {
      fail(`backup_root must be an absolute path, got: ${config.backup_root}`);
    }
    return config.backup_root;
  }
  if (!process.env.HOME) fail("HOME is unset; pass backup_root explicitly via --config");
  return join(process.env.HOME, "kaoiro-deploy");
}

/** `build`: prepares a versioned server image with no downtime — the
 *  no-downtime half of deployment.md 4.3 (1)/(2). Advances the repo
 *  checkout at `--repo` to `--target` (fast-forward only), computes
 *  build identity from the result, and passes the four KAOIRO_BUILD_*
 *  values into `docker compose build`'s child environment directly
 *  (no shell `set -a && eval` — issue #306's own requirement, and the
 *  exact footgun deployment.md 4.3 (2) documents under "Do not forget
 *  set -a"). Returns the plan/result object; does not touch the running
 *  container or write any manifest — the transaction record is the
 *  update command's job (later commit), since `build` alone has no
 *  transaction to record one against. */
export function runBuild(flags, config) {
  const repo = flags.repo ?? process.cwd();
  if (!flags.target || !SHA_RE.test(flags.target)) {
    fail("--target <full 40-hex SHA> is required for build", 64);
  }
  const target = flags.target;
  const dryRun = flags.dryRun === true;
  const { bin, overridden } = resolveDockerBin(config);
  const serverDir = join(repo, "server");

  const status = gitOutput(["status", "--porcelain"], repo);
  if (status !== "") {
    fail(`repo at ${repo} is dirty; refuse to build a moving target from a dirty tree`);
  }

  if (dryRun) {
    return {
      command: "build",
      dryRun: true,
      docker: overridden ? "fake" : "docker",
      repo,
      target,
      wouldRun: [`git fetch origin`, `git merge --ff-only ${target}`, `docker compose build`],
    };
  }

  gitOutput(["fetch", "origin"], repo);
  gitOutput(["merge", "--ff-only", target], repo);

  const identity = computeBuildIdentity(repo);
  if (identity.revision !== target) {
    fail(
      `build identity revision ${identity.revision} does not match target ${target} after merge --ff-only`,
    );
  }
  if (identity.dirty) {
    fail(`repo at ${repo} is dirty at ${identity.revision} after merge --ff-only; refusing to build`);
  }

  runDocker(bin, ["compose", "build"], {
    cwd: serverDir,
    env: {
      ...process.env,
      KAOIRO_BUILD_REVISION: identity.revision,
      KAOIRO_BUILD_DIRTY: String(identity.dirty),
      KAOIRO_BUILD_VERSION: identity.version,
      KAOIRO_BUILD_CHANNEL: identity.channel,
    },
    stdio: "inherit",
  });

  const versionedTag = `kaoiro-server:${target}`;
  runDocker(bin, ["tag", "kaoiro-server:latest", versionedTag], { cwd: serverDir });
  const imageId = dockerInspect(bin, versionedTag, "{{.Id}}");

  return {
    command: "build",
    dryRun: false,
    docker: overridden ? "fake" : "docker",
    repo,
    target,
    identity,
    imageId,
    imageTag: versionedTag,
  };
}

/** `start`: the ONLY way to bring the compose service up when it is not
 *  already running, classified through the #303/#306 branch table before
 *  touching anything.
 *
 *  Branch A (one stopped container): starts it directly — a plain
 *  `docker start`, not `compose up`, because `up` can pick up a `latest`
 *  tag that has moved since this container was created (the exact trap
 *  deployment.md's troubleshooting section warns about).
 *  Branch B (no container, but this CLI has prior transaction state):
 *  refuses — recovering from existing state is `update`/`rollback`'s
 *  job, not a fresh bootstrap.
 *  Branch C (nothing at all): only proceeds with the explicit
 *  `--initialize` flag, matching issue #306's "bootstrap only via
 *  explicit start --initialize".
 *  Branch D (anything else — multiple containers, wrong status):
 *  refuses and reports the reason; a human decides. */
export function runStart(flags, config) {
  const repo = flags.repo ?? process.cwd();
  const serverDir = join(repo, "server");
  const { bin, overridden } = resolveDockerBin(config);
  const dryRun = flags.dryRun === true;
  const backupRoot = resolveBackupRoot(config);
  const hasState = hasPriorTransactions(bin, serverDir, backupRoot);

  const result = classify(bin, serverDir, SERVICE, hasState);

  if (result.branch === BRANCH.STOPPED_CONTAINER) {
    if (dryRun) {
      return { command: "start", dryRun: true, docker: overridden ? "fake" : "docker", ...result };
    }
    runDocker(bin, ["start", result.container], { stdio: "inherit" });
    return { command: "start", dryRun: false, docker: overridden ? "fake" : "docker", ...result };
  }

  if (result.branch === BRANCH.STATE_WITHOUT_CONTAINER) {
    fail(
      `${result.reason}; use update/rollback to recover from existing state, not start`,
    );
  }

  if (result.branch === BRANCH.DIAGNOSE) {
    fail(`start refuses: ${result.reason}`);
  }

  // BRANCH.FRESH from here on.
  if (flags.initialize !== true) {
    fail("start --initialize is required to bootstrap a fresh deployment (no prior state found)", 64);
  }

  if (dryRun) {
    return {
      command: "start",
      dryRun: true,
      docker: overridden ? "fake" : "docker",
      ...result,
      wouldRun: ["docker compose up -d --build"],
    };
  }

  const identity = computeBuildIdentity(repo);
  runDocker(bin, ["compose", "up", "-d", "--build"], {
    cwd: serverDir,
    env: {
      ...process.env,
      KAOIRO_BUILD_REVISION: identity.revision,
      KAOIRO_BUILD_DIRTY: String(identity.dirty),
      KAOIRO_BUILD_VERSION: identity.version,
      KAOIRO_BUILD_CHANNEL: identity.channel,
    },
    stdio: "inherit",
  });

  return { command: "start", dryRun: false, docker: overridden ? "fake" : "docker", ...result, identity };
}

/** Every phase reachable from `from` (inclusive) by following
 *  `transitions` forward — a plain graph walk over the SAME table
 *  `validateJournalAgainstStateMachine` itself uses to check history.
 *  Exported (クロエ round 5 review SF-6) so a test can measure the
 *  ROLLBACK_ELIGIBLE_PHASES/UNRESUMABLE_PHASES DERIVATION against the
 *  real TRANSITIONS graph directly, rather than hand-listing the phases
 *  it currently produces — a hand-list pins today's membership, not the
 *  auto-exclusion property B-2/MF-2 actually care about. */
export function reachablePhases(from, transitions) {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const next of transitions[current] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

// クロエ round 1 review MF-3 / round 3 review MF-2: `--transaction`
// resume re-verifies the container is RUNNING (requireRunningContainer)
// before doing anything else, then unconditionally re-advances to
// MAINTENANCE_GATE_PASSED — a transaction that reached STOPPING or later
// can never satisfy the running-container check, and even UP/HEALTHY
// (where a container IS running again) would hit that same re-advance,
// which is not a listed transition from any of these phases and raises a
// raw PhaseError instead of a diagnosable DeployError. None of the
// commit half has resume support yet ((c3) does not add any); telling
// the operator to "resume it with --transaction" for one of these phases
// sends them into a guaranteed second failure instead of the manual
// runbook that actually recovers.
//
// Round 3 review: hand-enumerating this set let STARTING go missing when
// (c3) added it between ARCHIVED and UP — the exact "a new phase can be
// forgotten" failure mode. Derived instead from TRANSITIONS' own graph
// (every phase reachable from STOPPING, the first phase this file's own
// docs mark as "the commit half begins here"): a future phase inserted
// anywhere after STOPPING is unresumable by construction, not by
// remembering to add it here too. DONE is reachable from STOPPING and so
// included automatically — already filtered out by
// findUnfinishedTransaction's own TERMINAL_PHASES check before this is
// ever consulted, but correct on its own regardless.
export const UNRESUMABLE_PHASES = reachablePhases(PHASE.STOPPING, TRANSITIONS);

// --- #303 capacity preflight ----------------------------------------------
// クロエ manual round-1 review M1: `capacity_multiplier` has existed in the
// operator config since #306 landed, with no consumer — the #303 operator
// decision (5) ("refuse update when free space < capacity_multiplier x
// volume size") was never actually implemented. Checked at PREFLIGHT,
// before ANY mutation (even OLD_IMAGE_SAVED's own retag), and in
// `--dry-run` too (both measurements below are pure reads).

/** The docker volume name (if any) mounted at /var/lib/kaoiro for
 *  `container` — the SAME go-template the post-stop MOUNT_RESOLVED phase
 *  re-resolves with, factored out once two call sites need it (this
 *  commit adds the first: the capacity preflight, run while `container`
 *  is still the one live, pre-stop container). Empty string when no such
 *  mount exists; callers decide what that means for their own phase. */
function resolveKaoiroLibMount(bin, container) {
  return dockerInspect(
    bin,
    container,
    '{{range .Mounts}}{{if eq .Destination "/var/lib/kaoiro"}}{{.Name}}{{end}}{{end}}',
  );
}

/** Bytes available to a non-root user on the nearest EXISTING ancestor of
 *  `path` — `backup_root` itself may not exist yet on a brand-new host's
 *  very first `update` (nothing has created it yet, and `statfsSync` on a
 *  missing path throws even though the directory is about to be created
 *  on the same filesystem an existing ancestor already sits on). A pure
 *  in-process syscall, not a subprocess — director ruling 2026-09-07:
 *  what this protects is `backup_root`'s OWN filesystem (deliberately
 *  configurable because it can be a DIFFERENT filesystem than wherever
 *  docker stores the volume itself), and keeping `--dry-run` genuinely
 *  read-only (MF-1/N-5) means never even shelling out to `df`, let alone
 *  starting a container. Throws DeployError on any failure — an
 *  unmeasurable free-space figure is UNKNOWN, never "assume there is
 *  room" (#303 capacity-preflight ruling, 2026-09-06: "測定不能 → 拒否"). */
function readAvailableBytes(path) {
  let probe = path;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break; // reached the filesystem root
    probe = parent;
  }
  let stat;
  try {
    stat = statfsSync(probe);
  } catch (err) {
    fail(`could not measure free space at ${probe} (statfsSync failed): ${err.message}`);
  }
  return stat.bavail * stat.bsize;
}

/** Docker's own `units.HumanSize` formatting (measured live, docker
 *  29.6.1, 2026-09-07: `docker system df -v`'s Size column reports
 *  "213.6kB" for ~213 KB, "1.302MB", "0B" with no decimal) — SI, base
 *  1000, not 1024. Base 1024 here would UNDERESTIMATE the real size
 *  (the dangerous direction: a genuine shortage would then read as
 *  "enough room"). Accepts exactly the five units this formatter emits
 *  (`B`/`kB`/`MB`/`GB`/`TB` — lowercase `k`, everything else uppercase),
 *  with or without a decimal mantissa. Any other spelling (`KB`, `KiB`,
 *  a different docker version's format, ...) returns `null` — an
 *  unmeasurable figure, never a guess; report a new spelling rather than
 *  widening this silently. */
const SI_VOLUME_SIZE_RE = /^([0-9]+(?:\.[0-9]+)?)(B|kB|MB|GB|TB)$/;
const SI_VOLUME_SIZE_MULTIPLIER = { B: 1, kB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4 };
function parseSiVolumeSize(text) {
  const m = SI_VOLUME_SIZE_RE.exec(text);
  if (m === null) return null;
  return Math.round(Number(m[1]) * SI_VOLUME_SIZE_MULTIPLIER[m[2]]);
}

/** Bytes `docker system df -v` reports for the volume named `volumeName`
 *  — its own per-volume disk-usage accounting, not a fresh traversal
 *  (unlike the archive step's `du`). A pure docker-daemon QUERY: no
 *  container is started, so this stays safe to run in `--dry-run` too
 *  (MF-1/N-5) and needs no alpine pull (ensureAlpineImage's own call
 *  site, right before the stop window, is unchanged by this). Fails —
 *  never guesses — when the command itself fails, its output is not the
 *  expected JSON shape, the volume is absent from its own listing, or
 *  its Size string does not parse (parseSiVolumeSize's own contract). */
function volumeUsedBytes(bin, volumeName) {
  let raw;
  try {
    raw = runDocker(bin, ["system", "df", "-v", "--format", "{{json .Volumes}}"]);
  } catch (err) {
    fail(`could not measure volume usage ('docker system df -v' failed): ${err.message}`);
  }
  let volumes;
  try {
    volumes = JSON.parse(raw);
  } catch (err) {
    fail(`'docker system df -v' did not return valid JSON: ${err.message}`);
  }
  if (!Array.isArray(volumes)) {
    fail(`'docker system df -v' printed an unexpected shape (not an array): ${raw}`);
  }
  const entry = volumes.find((v) => v && typeof v === "object" && v.Name === volumeName);
  if (entry === undefined) {
    fail(`'docker system df -v' has no entry for volume ${volumeName}`);
  }
  const bytes = parseSiVolumeSize(entry.Size);
  if (bytes === null) {
    fail(
      `could not parse volume ${volumeName}'s size from 'docker system df -v': ${JSON.stringify(entry.Size)}`,
    );
  }
  return bytes;
}

/** Refuses to proceed when `backupRoot`'s filesystem does not have at
 *  least `config.capacity_multiplier` times the /var/lib/kaoiro volume's
 *  CURRENT size free — #303 operator decision (5), unimplemented until
 *  this commit. `backupRoot` and the volume's own storage root can be
 *  DIFFERENT filesystems (the reason `backup_root` is itself
 *  configurable) — this measures backupRoot's, since that is what the
 *  archive write actually depends on; rollback's own wipe/restore is a
 *  separate concern this does not gate. Every failure mode here is
 *  fail-closed: a measurement that cannot be taken or parsed, or an
 *  insufficient result, are all treated the same as a genuine shortage.
 *  An unresolvable mount (`resolveKaoiroLibMount` returning `""`) needs
 *  no dedicated guard here — an empty name never matches a real volume's
 *  in `docker system df -v`'s own listing, so volumeUsedBytes' own
 *  "absent from its own listing" failure already covers it (measured: a
 *  separate early check for `volumeName === ""` left every test in this
 *  file's own suite green either way, so it was never load-bearing).
 *  Returns the three measured/derived numbers so the caller can
 *  checkpoint them durably (S1's own "checkpoint every fact" contract)
 *  instead of only holding them in memory. */
function checkCapacity(bin, container, backupRoot, config) {
  const volumeName = resolveKaoiroLibMount(bin, container);
  const freeBytes = readAvailableBytes(backupRoot);
  const volumeBytes = volumeUsedBytes(bin, volumeName);
  const thresholdBytes = config.capacity_multiplier * volumeBytes;
  if (freeBytes < thresholdBytes) {
    fail(
      `capacity preflight refused: ${backupRoot}'s filesystem has ${freeBytes} bytes free, below the required ${thresholdBytes} bytes (capacity_multiplier ${config.capacity_multiplier} x current volume size ${volumeBytes} bytes) — free up space, or lower capacity_multiplier via --config, before retrying`,
    );
  }
  return { free_bytes: freeBytes, volume_bytes: volumeBytes, threshold_bytes: thresholdBytes };
}

/** `update`: lock, preflight, save the old image, build the versioned
 *  target, the human maintenance gate, then the stop/archive/up/
 *  health-poll/retention commit itself, ending at DONE. Everything up
 *  to the gate touches nothing but the checkout and a versioned image
 *  tag — the running container is never stopped — matching
 *  deployment.md 4.3's "separate prepare (no downtime) from commit (the
 *  stop window)". `rollback`/`status` are a later commit.
 *
 *  `--dry-run` (クロエ round 1 review MF-1) performs only reads — the
 *  same `compose ps`/`inspect` requireRunningContainer already needs,
 *  plus `git fetch origin` to report whether the target is even
 *  reachable — and returns a plan. It never acquires the deploy lock,
 *  creates a transaction directory, or resumes one via `--transaction`
 *  (an unrelated feature this commit does not attempt to give a
 *  meaningful non-mutating definition to).
 *
 *  `--transaction <id>` resumes a transaction that reached the
 *  maintenance gate but has not been approved yet: it re-verifies the
 *  container is still running, refuses if `--target` no longer matches
 *  what was already built, and re-checks the gate — it does NOT redo
 *  the old-image-save or build steps, both of which already happened
 *  and are read back from the journal's history instead.
 *
 *  CHECKPOINT-BEFORE-MUTATION (S1 item ii, yuta ruling 2026-09-06):
 *  every fact this function learns is written durably via advancePhase()
 *  — which itself calls writeJournal()'s writeFileDurably() (M3) —
 *  BEFORE the next step runs, so the COMMIT half's real Docker mutations
 *  always find every fact they need already checkpointed, never an
 *  in-memory variable that skipped the journal. */
export function runUpdate(flags, config) {
  const repo = flags.repo ?? process.cwd();
  if (!flags.target || !SHA_RE.test(flags.target)) {
    fail("--target <full 40-hex SHA> is required for update", 64);
  }
  const target = flags.target;
  const serverDir = join(repo, "server");
  const { bin, overridden } = resolveDockerBin(config);
  const backupRoot = resolveBackupRoot(config);
  const dryRun = flags.dryRun === true;

  if (dryRun) {
    if (flags.transaction !== undefined) {
      fail("--dry-run does not support --transaction", 64);
    }
    const container = requireRunningContainer(bin, serverDir, SERVICE);
    const unfinished = findUnfinishedTransaction(backupRoot);
    gitOutput(["fetch", "origin"], repo);
    // #303 operator decision (5): the capacity preflight is a pure read
    // (statfsSync + 'docker system df -v', no container started) and
    // fail-closed, so a dry-run reports the SAME pass/fail answer a real
    // run would give, not merely a plan that omits it.
    const capacity = checkCapacity(bin, container, backupRoot, config);
    return {
      command: "update",
      dryRun: true,
      docker: overridden ? "fake" : "docker",
      container,
      target,
      unfinishedTransactionId: unfinished === null ? null : unfinished.id,
      capacity,
      wouldRun:
        unfinished !== null
          ? [`resume transaction ${unfinished.id} (phase: ${unfinished.journal.phase})`]
          : [
              `git merge --ff-only ${target}`,
              "docker compose build",
              "docker tag <old_image_id> kaoiro-server:rollback-<old-sha>",
              "wait for --maintenance-approved",
              "docker compose stop -t 30",
              "archive /var/lib/kaoiro",
              "docker compose up -d --no-build",
              `poll ${config.health_url ?? "<published host:port>/api/health"} for build_revision=${target}, build_dirty=false`,
              `wait ${config.stability_window_ms}ms for a stable container`,
              "prune old backups (keep_generations/retention_days)",
            ],
    };
  }

  const lockPath = acquireLock(backupRoot);
  try {
    const unfinished = findUnfinishedTransaction(backupRoot);
    let transactionId;
    let dir;
    let journal;
    let oldImageId;
    let oldSha;
    let rollbackTag;
    let buildResult;
    let container;
    let composeArtifact;

    if (flags.transaction !== undefined) {
      if (unfinished === null || unfinished.id !== flags.transaction) {
        fail(
          `--transaction ${flags.transaction} is not an in-progress transaction; run 'status' to see what exists`,
        );
      }
      ({ id: transactionId, dir, journal } = unfinished);
      const oldEntry = journal.history.find((e) => e.phase === PHASE.OLD_IMAGE_SAVED);
      const buildEntry = journal.history.find((e) => e.phase === PHASE.BUILD_PREPARED);
      if (oldEntry === undefined || buildEntry === undefined) {
        fail(
          `transaction ${transactionId} has not completed prepare (phase: ${journal.phase}); rerun update with --transaction ${transactionId} and no --maintenance-approved to retry prepare`,
        );
      }
      if (buildEntry.observation.target_sha !== target) {
        fail(
          `--target ${target} does not match transaction ${transactionId}'s prepared target ${buildEntry.observation.target_sha}`,
        );
      }
      oldImageId = oldEntry.observation.old_image_id;
      oldSha = oldEntry.observation.old_sha;
      rollbackTag = oldEntry.observation.rollback_tag;
      composeArtifact = oldEntry.observation.compose_artifact;
      buildResult = {
        imageId: buildEntry.observation.image_id,
        imageTag: buildEntry.observation.image_tag,
        target,
      };
      // Re-verify: prepare ran against a running container, and resume
      // may happen an arbitrary time later — nothing here should trust
      // that it still is.
      container = requireRunningContainer(bin, serverDir, SERVICE);
    } else {
      if (unfinished !== null) {
        fail(
          UNRESUMABLE_PHASES.has(unfinished.journal.phase)
            ? `transaction ${unfinished.id} is unfinished (phase: ${unfinished.journal.phase}); the commit half has no resume support yet ((c3)) — follow docs/specs/deployment.md 4.4 to recover manually, or investigate ${unfinished.dir}`
            : `transaction ${unfinished.id} is unfinished (phase: ${unfinished.journal.phase}); resume it with --transaction ${unfinished.id}, or investigate ${unfinished.dir} before starting a new one`,
        );
      }

      container = requireRunningContainer(bin, serverDir, SERVICE);

      // #303 operator decision (5), クロエ manual round-1 review M1:
      // measured and gated BEFORE any mutation — even before this
      // transaction's own directory exists — so an insufficient host
      // leaves nothing behind to clean up.
      const capacity = checkCapacity(bin, container, backupRoot, config);

      transactionId = newTransactionId();
      dir = join(backupRoot, transactionId);
      // クロエ round 1 review N-2: backupRoot itself may not exist yet on
      // a first-ever transaction (recursive create is fine — there is
      // nothing under it to collide with), but the transaction's OWN
      // leaf directory must fail loudly on a same-second collision
      // rather than silently reusing whatever is already there.
      mkdirSync(backupRoot, { recursive: true });
      mkdirSync(dir, { recursive: false });
      journal = {
        schema_version: 1,
        transaction_id: transactionId,
        phase: PHASE.PREFLIGHT,
        history: [
          {
            phase: PHASE.PREFLIGHT,
            at: new Date().toISOString(),
            observation: { container, ...capacity },
          },
        ],
      };
      writeJournal(dir, journal, validateJournalAgainstStateMachine);

      oldImageId = dockerInspect(bin, container, "{{.Image}}");
      oldSha = gitOutput(["rev-parse", "HEAD"], repo);
      const composeArtifactPath = join(serverDir, "docker-compose.yaml");
      composeArtifact = { path: composeArtifactPath, sha256: sha256File(composeArtifactPath) };

      // クロエ round 1 review MF-2: retagged from the RUNNING container's
      // own image id, never from `latest` — `compose build` below is
      // about to repoint `latest` at the new image, so retagging from
      // `latest` after that point would make the rollback tag point at
      // the very image it is supposed to be an escape hatch FROM
      // (deployment.md 4.3 (1)). Verified via a real `docker inspect`
      // read-back, not merely assumed from the `docker tag` exit code.
      rollbackTag = `kaoiro-server:rollback-${oldSha}`;
      runDocker(bin, ["tag", oldImageId, rollbackTag]);
      const rollbackTagId = dockerInspect(bin, rollbackTag, "{{.Id}}");
      if (rollbackTagId !== oldImageId) {
        fail(
          `rollback tag ${rollbackTag} points at ${rollbackTagId}, not the old image ${oldImageId} — refusing to proceed with an unverifiable rollback target`,
        );
      }

      journal = advancePhase(
        dir,
        journal,
        PHASE.OLD_IMAGE_SAVED,
        { old_image_id: oldImageId, old_sha: oldSha, compose_artifact: composeArtifact, rollback_tag: rollbackTag },
        validateJournalAgainstStateMachine,
      );

      buildResult = runBuild({ repo, target }, config);
      journal = advancePhase(
        dir,
        journal,
        PHASE.BUILD_PREPARED,
        {
          image_id: buildResult.imageId,
          image_tag: buildResult.imageTag,
          target_sha: target,
        },
        validateJournalAgainstStateMachine,
      );
    }

    // issue #220 absorption (director ruling 2026-09-06, turn 13): right
    // after the target image exists (BUILD_PREPARED), before the
    // maintenance gate — still no-downtime. Gated on journal.phase being
    // EXACTLY BUILD_PREPARED (not merely "not yet past it") so a
    // transaction resumed after already reaching ENV_CONSISTENCY_CHECKED
    // does not re-run this and does not attempt an illegal
    // BUILD_PREPARED -> ENV_CONSISTENCY_CHECKED jump from a journal
    // already one phase further along.
    if (journal.phase === PHASE.BUILD_PREPARED) {
      const persistencePaths = queryPersistencePaths(bin, buildResult.imageId);
      let envConsistency;
      if (persistencePaths.skipped) {
        envConsistency = { skipped: true, reason: persistencePaths.reason };
      } else {
        const entries = checkEnvConsistency(
          persistencePaths.paths,
          join(serverDir, ".env"),
          composeDeclaredEnv(bin, serverDir),
          containerEffectiveEnv(bin, container),
        );
        envConsistency = { skipped: false, entries };
        if (!Object.values(entries).every((e) => e.match)) {
          // director ruling 2026-09-06: abort cleanup before the stop
          // window — `compose build` (inside runBuild, above) already
          // repointed `latest` at the new image; leaving it there would
          // let the next `compose up` (an operator retry, or another
          // tool) switch an unreviewed deployment into production.
          // Restored to the SAME image the already-verified rollback
          // tag names, verified again here by read-back.
          runDocker(bin, ["tag", oldImageId, "kaoiro-server:latest"]);
          const revertedId = dockerInspect(bin, "kaoiro-server:latest", "{{.Id}}");
          if (revertedId !== oldImageId) {
            fail(
              `env_consistency check failed AND could not restore kaoiro-server:latest to the old image ${oldImageId} (now ${revertedId}) — investigate before retrying`,
            );
          }
          // クロエ round 5 review A-MF-2: distinguishes the two DIFFERENT
          // remediations a mismatching entry can need — an operator
          // reading either sentence knows what to actually go do,
          // instead of a single generic "mismatch" naming three fields.
          const problems = Object.entries(entries)
            .filter(([, e]) => !e.match)
            .map(([envName, e]) =>
              e.compose === null
                ? `${envName}: compose does not declare this persistence-path var at all (the #217 class — a required var missing from compose can silently escape backup)`
                : `${envName}: compose declares "${e.compose}" but the running container's effective path is "${e.container_effective}" (${e.container_source}) — this looks like a first-application migration; follow docs/specs/deployment.md 4.3 (5-b) before retrying`,
            );
          fail(
            `env_consistency check found a problem for one or more persistence-path env vars (.env's own line is recorded as "declared" for reference only — it is never compared; restored kaoiro-server:latest to the old image): ${problems.join("; ")} — full detail: ${JSON.stringify(entries)}`,
          );
        }
      }
      journal = advancePhase(
        dir,
        journal,
        PHASE.ENV_CONSISTENCY_CHECKED,
        envConsistency,
        validateJournalAgainstStateMachine,
      );
    }

    if (flags.maintenanceApproved !== true) {
      fail(
        `update requires --maintenance-approved before the stop window opens (no-downtime steps are complete); resume with --transaction ${transactionId} --target ${target} --maintenance-approved once the operator has approved the maintenance window`,
        64,
      );
    }
    journal = advancePhase(dir, journal, PHASE.MAINTENANCE_GATE_PASSED, {}, validateJournalAgainstStateMachine);

    // クロエ round 1 review N-5: pulled here, before the stop window
    // opens — not implicitly by the first `docker run alpine ...` the
    // archive step happens to make after the server is already down,
    // which would both extend the outage by however long the pull takes
    // and risk a SECOND pull mid-archive if the first `docker run`
    // somehow did not warm the local cache.
    ensureAlpineImage(bin);

    // クロエ round 1 review SF-2: a checkpoint written immediately
    // before `compose stop` runs, so a crash between this line and the
    // STOPPED checkpoint below leaves the journal AT this phase —
    // distinguishable from "the gate passed but stop was never
    // attempted" (a crash before this line would still show
    // MAINTENANCE_GATE_PASSED).
    journal = advancePhase(dir, journal, PHASE.STOPPING, {}, validateJournalAgainstStateMachine);

    // --- commit: from here on the service is stopped. Everything above
    // this line is documented as no-downtime in runUpdate's own doc
    // comment; nothing below it may run before the checkpoint above it
    // completed (S1 item ii).
    runDocker(bin, ["compose", "stop", "-t", "30"], { cwd: serverDir, stdio: "inherit" });

    const stopExitCode = parseDockerIntField(dockerInspect(bin, container, "{{.State.ExitCode}}"));
    const stopOomKilled = parseDockerBoolField(dockerInspect(bin, container, "{{.State.OOMKilled}}"));
    journal = advancePhase(
      dir,
      journal,
      PHASE.STOPPED,
      { stop_exit_code: stopExitCode, stop_oom_killed: stopOomKilled },
      validateJournalAgainstStateMachine,
    );

    // "measured, not assumed" (deployment.md 4.3 step 5) — an unset
    // expectation, a mismatch, or an unparsed docker field are ALL
    // abnormal. `null` from either side never matches `null` on the
    // other by design: an unmeasured expectation must never coincide
    // with an unreadable observation and be treated as agreement (via
    // agrees(), shared with the stability check below — クロエ round 3
    // review MF-3).
    const cleanStop =
      agrees(stopExitCode, config.expected_clean_stop_exit_code) &&
      agrees(stopOomKilled, config.expected_clean_stop_oom_killed);
    if (!cleanStop) {
      // クロエ round 1 review N-1: names the exact runbook essentials
      // (deployment.md 4.3 step 5) an operator investigating an abnormal
      // stop needs immediately — recover the container with `docker
      // start`, never `docker compose up`, while `latest` still points
      // at the new (not-yet-live) image built earlier in this run.
      fail(
        `stop was not clean (exit=${stopExitCode}, oom=${stopOomKilled}; expected exit=${config.expected_clean_stop_exit_code}, expected oom=${config.expected_clean_stop_oom_killed}) — the server is stopped but archiving/restarting requires manual recovery (deployment.md 4.3 step 5): use 'docker start ${container}' to recover the OLD container, never 'docker compose up' while latest points at the new image; investigate before retrying`,
      );
    }

    // Re-resolve the mount from the NOW-STOPPED container — the same
    // container prepare already verified was running, not a fresh
    // lookup that could pick up a different one.
    const volumeId = resolveKaoiroLibMount(bin, container);
    // Measured redundant with the MOUNT_RESOLVED observation schema
    // below (advancePhase() now runs validateJournalAgainstStateMachine
    // too) — removing this check still stops the run, via a PhaseError
    // instead of this DeployError. Kept anyway for the diagnostic: "the
    // mount layout changed" names the actual docker-side cause, where
    // the schema error only says an observation looked wrong.
    if (volumeId === "") {
      fail(
        `could not resolve the /var/lib/kaoiro mount for container ${container} — empty output means the mount layout changed; archiving the wrong (or no) volume would be worse than stopping here`,
      );
    }
    journal = advancePhase(
      dir,
      journal,
      PHASE.MOUNT_RESOLVED,
      { volume_id: volumeId },
      validateJournalAgainstStateMachine,
    );

    // --- archive: full traversal + checksum + required entries +
    // ownership, all from the SAME resolved volume, before this
    // transaction may call itself rollback-capable. listVolumeEntries is
    // a PRE-archive guard only (fail before spending time archiving
    // nothing) — the required_entries actually RECORDED come from the
    // archive's own verification listing below (SF-5), so nothing can
    // claim a required entry the archive does not actually contain.
    if (listVolumeEntries(bin, volumeId).length === 0) {
      fail(
        `resolved volume ${volumeId} contains no files — archiving an empty volume would not be a usable backup`,
      );
    }

    const archivePath = join(dir, "archive.tar.gz");
    runDocker(bin, [
      "run",
      "--rm",
      "-v",
      `${volumeId}:/data:ro`,
      "-v",
      `${dir}:/backup`,
      ALPINE_IMAGE,
      "tar",
      "czf",
      "/backup/archive.tar.gz",
      "-C",
      "/data",
      ".",
    ]);
    // クロエ round 1 review SF-5: `tar tvzf` (verbose), not `tar tzf`
    // (names only) — the full traversal this already needed (not `| head`,
    // whose exit status would come from the tail command and mask a
    // corrupt archive — deployment.md 4.3 step 5-c) now ALSO produces
    // the required_entries this transaction records, so the recorded set
    // is provably what the archive contains, not a separately-scanned
    // guess that could disagree with it.
    //
    // クロエ round 2 review N-7: running tar and parsing its output are
    // kept as two separate steps so their failures stay distinguishable
    // — a non-zero tar exit here means the ARCHIVE itself is suspect
    // (corrupt/truncated), while a parseTarEntries failure below means
    // the archive is fine but its listing had a shape this CLI does not
    // understand; conflating both into one "archive verification
    // failed" message would send an operator investigating the wrong
    // thing.
    let tarOutput;
    try {
      tarOutput = execFileSync("tar", ["tvzf", archivePath, "--numeric-owner"], { encoding: "utf8" });
    } catch (err) {
      fail(`archive verification failed (tar tvzf ${archivePath}): ${err.message}`);
    }
    const requiredEntries = parseTarEntries(tarOutput);
    if (requiredEntries.length === 0) {
      fail(
        `archive at ${archivePath} contains no entries — archiving an empty volume would not be a usable backup`,
      );
    }
    const archive = { path: archivePath, sha256: sha256File(archivePath) };

    journal = advancePhase(
      dir,
      journal,
      PHASE.ARCHIVED,
      { archive, required_entries: requiredEntries },
      validateJournalAgainstStateMachine,
    );

    // Written exactly once, here — the first point every fact it needs
    // (S1's contract) is fully determined. Earlier phases hold the same
    // facts in the journal's history in the meantime (S1 item i).
    //
    // env_consistency is read BACK from the journal's own
    // ENV_CONSISTENCY_CHECKED entry, not a local variable — a resumed
    // transaction that already passed that phase in an EARLIER process
    // invocation never re-runs the check in this one, so the only
    // durable record of what it found is the journal history itself.
    writeManifest(dir, {
      schema_version: 1,
      transaction_id: transactionId,
      compose_artifact: composeArtifact,
      env_consistency: journal.history.find((e) => e.phase === PHASE.ENV_CONSISTENCY_CHECKED).observation,
      image_id: buildResult.imageId,
      source_sha: oldSha,
      target_sha: target,
      volume_id: volumeId,
      archive,
      required_entries: requiredEntries,
      // director ruling 2026-09-06: recorded on the manifest (not just
      // the journal) so retention's docker-tag cleanup reads it from
      // the one durable "facts about this transaction" record instead
      // of rediscovering it by globbing docker's own image list.
      rollback_tag: rollbackTag,
    });

    // (c3): bring the prepared image up, verify it is actually the target
    // (not merely "a container exists"), and confirm it survives long
    // enough to call this update done — deployment.md 4.3 step 6 / 4.5's
    // own "operational success" + "provenance" checks.
    //
    // クロエ design review F1: STARTING is checkpointed BEFORE `compose
    // up` runs (mirrors STOPPING) — a crash between this line and UP
    // would otherwise leave the journal at ARCHIVED, indistinguishable
    // from "up was never attempted" even though runbook 4.4 (3)'s
    // recovery branches on exactly that distinction.
    journal = advancePhase(dir, journal, PHASE.STARTING, {}, validateJournalAgainstStateMachine);
    runDocker(bin, ["compose", "up", "-d", "--no-build"], { cwd: serverDir, stdio: "inherit" });
    // クロエ design review F2: `compose up -d` on a changed image
    // recreates the container (not the same one `container` above named
    // — a new id), and runbook 4.4 (3)'s recovery starts by stopping
    // THAT container, which is otherwise nowhere in the journal.
    const newContainer = requireRunningContainer(bin, serverDir, SERVICE);
    const newContainerId = dockerInspect(bin, newContainer, "{{.Id}}");
    const startedAt = dockerInspect(bin, newContainer, "{{.State.StartedAt}}");
    journal = advancePhase(
      dir,
      journal,
      PHASE.UP,
      { container_id: newContainerId, started_at: startedAt },
      validateJournalAgainstStateMachine,
    );

    const curlBin = resolveCurlBin();
    const healthUrl = resolveHealthUrl(bin, serverDir, config);
    const health = pollHealth(
      curlBin,
      healthUrl,
      target,
      config.health_poll_interval_ms,
      config.health_poll_timeout_ms,
    );
    journal = advancePhase(
      dir,
      journal,
      PHASE.HEALTHY,
      { health_revision: health.build_revision, health_dirty: health.build_dirty },
      validateJournalAgainstStateMachine,
    );

    // "Container is stable" (deployment.md 4.5): no crash-restart over the
    // stability window, still `running` at the end of it. RestartCount is
    // docker's own counter for restart_policy-triggered restarts (server/
    // docker-compose.yaml: `restart: unless-stopped`) — a container stuck
    // crash-looping could transiently read "running" at the exact instant
    // checked, so the restart count (not just the final status) is what
    // actually rules that out.
    //
    // クロエ round 3 review SF-1: inspects `newContainerId` (UP's own
    // recorded identity), not `container` (the PREFLIGHT-resolved
    // service name from BEFORE `compose up` recreated it) — the same
    // reasoning as F2's own comment above UP itself: a name can be
    // reused by a DIFFERENT object, and inspecting by the exact id this
    // update actually started fails loudly on a swap instead of quietly
    // reading a fresh RestartCount of 0 for whatever now holds that name.
    const restartsAtHealthy = restartCount(bin, newContainerId);
    sleepMs(config.stability_window_ms);
    const statusAfterWindow = dockerInspect(bin, newContainerId, "{{.State.Status}}");
    const restartsAfterWindow = restartCount(bin, newContainerId);
    // クロエ round 3 review MF-3: `agrees()` (not `!==`) — two unreadable
    // RestartCounts must not read as "no restart happened" the way
    // `null !== null` (false) would silently produce. The stop check
    // three phases above already avoided this class explicitly; this is
    // the second instance of it, closed with the same helper.
    if (statusAfterWindow !== "running" || !agrees(restartsAfterWindow, restartsAtHealthy)) {
      fail(
        `container ${newContainerId} was not stable for ${config.stability_window_ms}ms after becoming healthy (status=${statusAfterWindow}, restarts ${restartsAtHealthy} -> ${restartsAfterWindow}) — the update reached HEALTHY but did not survive to be called done; investigate before retrying`,
      );
    }
    journal = advancePhase(dir, journal, PHASE.DONE, {}, validateJournalAgainstStateMachine);

    // Retention (issue #306 (c3), config.keep_generations/retention_days):
    // best-effort, never fails an otherwise-successful update — a stale
    // backup nobody could delete is a cleanup problem to report, not a
    // reason to call a deploy that just reached DONE a failure.
    let prunedTransactions = [];
    let pruneSkipped = [];
    let pruneError = null;
    try {
      ({ removed: prunedTransactions, skipped: pruneSkipped } = pruneOldTransactions(
        backupRoot,
        config,
        transactionId,
        bin,
      ));
    } catch (err) {
      pruneError = err.message;
    }

    return {
      command: "update",
      phase: "done",
      transactionId,
      docker: overridden ? "fake" : "docker",
      oldImageId,
      oldSha,
      rollbackTag,
      build: buildResult,
      container,
      stopExitCode,
      stopOomKilled,
      volumeId,
      archive,
      requiredEntries,
      health,
      prunedTransactions,
      pruneSkipped,
      pruneError,
    };
  } finally {
    releaseLock(lockPath);
  }
}

// Every phase `rollback` may act on (director ruling 2026-09-06, B-1;
// fully derived per round 4 review B-2, closing the SAME class MF-2 did
// — the original version derived the base set but then DELETED the
// rollback chain's own phases by a hand-written 4-element literal,
// which a phase inserted into that chain later could silently miss).
// Reachable forward from OLD_IMAGE_SAVED (everything but PREFLIGHT,
// where nothing was even recorded yet) MINUS everything reachable
// forward from ROLLBACK_STOPPED (the rollback chain's own phases,
// including the terminal ROLLED_BACK — a transaction already mid-
// rollback or fully rolled back needs manual investigation, not a
// second `rollback` invocation, the same limit `update`'s own
// UNRESUMABLE_PHASES documents for its half). Inserting a new phase
// anywhere in the rollback chain is excluded automatically, by
// construction, not by remembering to add it to a list here too.
export const ROLLBACK_ELIGIBLE_PHASES = new Set(
  [...reachablePhases(PHASE.OLD_IMAGE_SAVED, TRANSITIONS)].filter(
    (phase) => !reachablePhases(PHASE.ROLLBACK_STOPPED, TRANSITIONS).has(phase),
  ),
);

/** `rollback`: restores the OLD image + its corresponding pre-deploy
 *  DETS pair for `--transaction <id>` (director ruling 2026-09-06,
 *  B-1..B-5). Never mutates without `--confirm-restore` (or previews
 *  with `--dry-run`, which never touches anything either).
 *
 *  The destructive/non-destructive split is derived from the SAME
 *  TRANSITIONS graph `update` and its own UNRESUMABLE_PHASES read
 *  (`TRANSITIONS[phase]` includes ROLLBACK_STOPPED exactly for
 *  STARTING/UP/HEALTHY/DONE) rather than a second hand-written list —
 *  the same "derive it, do not re-enumerate it" fix as MF-2.
 *
 *  Non-destructive (OLD_IMAGE_SAVED..ARCHIVED): the old container was
 *  never recreated — nothing on the volume has changed since PREFLIGHT.
 *  Retag `latest` back to the old image (undoing `compose build`'s side
 *  effect, verified by read-back) and `docker start` the PREFLIGHT-
 *  recorded container (a harmless no-op if it was never actually
 *  stopped — measured live: `docker start` on an already-running
 *  container exits 0). No manifest needed (B-1) since ARCHIVED and
 *  earlier phases may not have one yet, and even ARCHIVED's own archive
 *  is untouched, so there is nothing to restore FROM.
 *
 *  Destructive (STARTING/UP/HEALTHY/DONE): the new image may already
 *  have opened (STARTING's own ambiguity), so old code is not assumed
 *  able to read whatever it wrote. Requires a manifest (only reachable
 *  transactions have one, since it is written at ARCHIVED): stop
 *  whatever is currently running for the service, forensically archive
 *  the CURRENT volume state (before touching it), re-verify the
 *  pre-deploy archive's sha256 right before the destructive wipe
 *  (mutation-pinned — a changed archive refuses to restore), wipe and
 *  restore, re-tar the restored volume and confirm it matches the
 *  manifest's own required_entries exactly, retag `latest` back
 *  (verified), `compose up -d --no-build --force-recreate`, and poll
 *  health for the OLD sha. */
export function runRollback(flags, config) {
  const repo = flags.repo ?? process.cwd();
  const serverDir = join(repo, "server");
  const { bin, overridden } = resolveDockerBin(config);
  const backupRoot = resolveBackupRoot(config);

  if (!flags.transaction) {
    fail("rollback requires --transaction <id>", 64);
  }
  const dir = join(backupRoot, flags.transaction);
  let journal;
  try {
    journal = readJournal(dir);
  } catch (err) {
    fail(`--transaction ${flags.transaction} has no readable journal at ${dir}: ${err.message}`);
  }
  if (journal.transaction_id !== flags.transaction) {
    fail(
      `transaction directory ${dir} contains a journal claiming transaction_id ${journal.transaction_id} — refusing to guess which is authoritative`,
    );
  }
  try {
    validateJournalAgainstStateMachine(journal);
  } catch (err) {
    fail(`transaction ${flags.transaction}'s journal is internally inconsistent: ${err.message}`);
  }
  if (!ROLLBACK_ELIGIBLE_PHASES.has(journal.phase)) {
    fail(
      `transaction ${flags.transaction} is at phase ${journal.phase}, not eligible for rollback (must have reached at least old_image_saved, and must not already be rolled back or mid-rollback) — investigate ${dir} manually`,
    );
  }

  const oldEntry = journal.history.find((e) => e.phase === PHASE.OLD_IMAGE_SAVED);
  const { old_image_id: oldImageId, old_sha: oldSha } = oldEntry.observation;
  const preflightContainer = journal.history.find((e) => e.phase === PHASE.PREFLIGHT).observation.container;
  const destructive = TRANSITIONS[journal.phase]?.includes(PHASE.ROLLBACK_STOPPED) ?? false;

  if (flags.dryRun === true) {
    return {
      command: "rollback",
      dryRun: true,
      docker: overridden ? "fake" : "docker",
      transactionId: flags.transaction,
      phase: journal.phase,
      destructive,
      oldImageId,
      oldSha,
      wouldRun: destructive
        ? [
            "stop whatever is currently running for the service (if anything)",
            "forensic-archive the current volume state",
            "re-verify the pre-deploy archive's sha256",
            "wipe the volume and restore from the pre-deploy archive",
            "verify the restored volume against the recorded required_entries",
            `docker tag ${oldImageId} kaoiro-server:latest`,
            "docker compose up -d --no-build --force-recreate",
            `poll health for build_revision=${oldSha}`,
          ]
        : [`docker tag ${oldImageId} kaoiro-server:latest`, `docker start ${preflightContainer}`],
    };
  }
  if (flags.confirmRestore !== true) {
    fail(
      `rollback requires --confirm-restore to actually restore transaction ${flags.transaction} (phase: ${journal.phase}, ${destructive ? "destructive" : "non-destructive"} path); rerun with --dry-run to preview without confirming`,
      64,
    );
  }

  const lockPath = acquireLock(backupRoot);
  try {
    if (!destructive) {
      runDocker(bin, ["tag", oldImageId, "kaoiro-server:latest"]);
      const revertedId = dockerInspect(bin, "kaoiro-server:latest", "{{.Id}}");
      if (revertedId !== oldImageId) {
        fail(
          `rollback could not restore kaoiro-server:latest to the old image ${oldImageId} (now ${revertedId}) — investigate before retrying`,
        );
      }
      // Harmless no-op if this container was never actually stopped
      // (measured live: `docker start` on an already-running container
      // exits 0 and changes nothing) — the non-destructive phases span
      // both "never stopped" (OLD_IMAGE_SAVED..MAINTENANCE_GATE_PASSED)
      // and "genuinely stopped" (STOPPING..ARCHIVED), and this call is
      // correct either way without needing to distinguish them.
      runDocker(bin, ["start", preflightContainer]);
      journal = advancePhase(dir, journal, PHASE.ROLLED_BACK, {}, validateJournalAgainstStateMachine);
      return {
        command: "rollback",
        phase: "rolled_back",
        transactionId: flags.transaction,
        destructive: false,
        restoredImageId: oldImageId,
        container: preflightContainer,
      };
    }

    // --- destructive path ---
    const manifest = readManifest(dir);
    const volumeId = manifest.volume_id;

    let stoppedContainer = null;
    const currentNames = dockerComposeContainerNames(bin, serverDir, SERVICE);
    if (currentNames.length > 1) {
      fail(
        `${currentNames.length} containers match service ${SERVICE}; expected 0 or 1 — investigate before rollback can proceed`,
      );
    }
    if (currentNames.length === 1) {
      [stoppedContainer] = currentNames;
      runDocker(bin, ["compose", "stop", "-t", "30"], { cwd: serverDir, stdio: "inherit" });
    }
    journal = advancePhase(
      dir,
      journal,
      PHASE.ROLLBACK_STOPPED,
      { stopped_container: stoppedContainer },
      validateJournalAgainstStateMachine,
    );

    const forensicPath = join(dir, "rollback-forensic.tar.gz");
    runDocker(bin, [
      "run",
      "--rm",
      "-v",
      `${volumeId}:/data:ro`,
      "-v",
      `${dir}:/backup`,
      ALPINE_IMAGE,
      "tar",
      "czf",
      "/backup/rollback-forensic.tar.gz",
      "-C",
      "/data",
      ".",
    ]);
    try {
      execFileSync("tar", ["tzf", forensicPath]);
    } catch (err) {
      fail(`forensic archive of the current (pre-restore) volume state failed verification: ${err.message}`);
    }
    journal = advancePhase(
      dir,
      journal,
      PHASE.ROLLBACK_FORENSIC_ARCHIVED,
      { archive: { path: forensicPath, sha256: sha256File(forensicPath) } },
      validateJournalAgainstStateMachine,
    );

    // Re-verify the PRE-DEPLOY archive right before the destructive
    // wipe — a changed or corrupted archive must refuse to restore
    // rather than wipe the volume onto nothing recoverable.
    const preDeployArchiveSha = sha256File(manifest.archive.path);
    if (preDeployArchiveSha !== manifest.archive.sha256) {
      fail(
        `pre-deploy archive at ${manifest.archive.path} does not match its recorded sha256 (expected ${manifest.archive.sha256}, got ${preDeployArchiveSha}) — refusing to restore from a changed archive`,
      );
    }
    try {
      execFileSync("tar", ["tzf", manifest.archive.path]);
    } catch (err) {
      fail(`pre-deploy archive at ${manifest.archive.path} failed full-traversal verification: ${err.message}`);
    }

    // クロエ round 5 review SF-9: checkpointed immediately before the
    // destructive wipe — a crash between this line and ROLLBACK_RESTORED
    // otherwise leaves the journal at ROLLBACK_FORENSIC_ARCHIVED,
    // indistinguishable from "the wipe was never attempted" even though
    // the volume may now be anywhere from untouched to fully restored.
    journal = advancePhase(
      dir,
      journal,
      PHASE.ROLLBACK_RESTORING,
      {
        forensic_archive: { path: forensicPath, sha256: sha256File(forensicPath) },
        restore_from: { path: manifest.archive.path, sha256: preDeployArchiveSha },
      },
      validateJournalAgainstStateMachine,
    );

    runDocker(bin, [
      "run",
      "--rm",
      "-v",
      `${volumeId}:/data`,
      "-v",
      `${dirname(manifest.archive.path)}:/backup:ro`,
      ALPINE_IMAGE,
      "sh",
      "-c",
      `find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar xzf /backup/${basename(manifest.archive.path)} -C /data`,
    ]);

    // Re-tar the JUST-RESTORED volume and confirm it matches the
    // manifest's own required_entries EXACTLY — proves the restore did
    // not silently drop or alter anything, not merely that `tar xzf`
    // exited 0.
    const restoreVerifyPath = join(dir, "rollback-restore-verify.tar.gz");
    runDocker(bin, [
      "run",
      "--rm",
      "-v",
      `${volumeId}:/data:ro`,
      "-v",
      `${dir}:/backup`,
      ALPINE_IMAGE,
      "tar",
      "czf",
      "/backup/rollback-restore-verify.tar.gz",
      "-C",
      "/data",
      ".",
    ]);
    let restoreVerifyOutput;
    try {
      restoreVerifyOutput = execFileSync("tar", ["tvzf", restoreVerifyPath, "--numeric-owner"], { encoding: "utf8" });
    } catch (err) {
      fail(`could not verify the restored volume's contents: ${err.message}`);
    }
    const restoredEntries = parseTarEntries(restoreVerifyOutput);
    if (!requiredEntriesMatch(restoredEntries, manifest.required_entries)) {
      fail(
        `restored volume's contents do not match the recorded required_entries — investigate before starting the old image (expected ${JSON.stringify(manifest.required_entries)}, got ${JSON.stringify(restoredEntries)})`,
      );
    }
    journal = advancePhase(
      dir,
      journal,
      PHASE.ROLLBACK_RESTORED,
      { required_entries: restoredEntries },
      validateJournalAgainstStateMachine,
    );

    runDocker(bin, ["tag", oldImageId, "kaoiro-server:latest"]);
    const revertedId = dockerInspect(bin, "kaoiro-server:latest", "{{.Id}}");
    if (revertedId !== oldImageId) {
      fail(
        `rollback could not restore kaoiro-server:latest to the old image ${oldImageId} (now ${revertedId}) — investigate before retrying`,
      );
    }
    runDocker(bin, ["compose", "up", "-d", "--no-build", "--force-recreate"], { cwd: serverDir, stdio: "inherit" });

    const curlBin = resolveCurlBin();
    const healthUrl = resolveHealthUrl(bin, serverDir, config);
    const health = pollHealth(
      curlBin,
      healthUrl,
      oldSha,
      config.health_poll_interval_ms,
      config.health_poll_timeout_ms,
    );

    journal = advancePhase(dir, journal, PHASE.ROLLED_BACK, {}, validateJournalAgainstStateMachine);

    return {
      command: "rollback",
      phase: "rolled_back",
      transactionId: flags.transaction,
      destructive: true,
      restoredImageId: oldImageId,
      stoppedContainer,
      health,
    };
  } finally {
    releaseLock(lockPath);
  }
}

/** Manifest + journal facts for one DONE transaction, for `status`'s own
 *  listing — a rollback target picker needs source/target SHA and
 *  completion time, none of which pruneOldTransactions' own id-only list
 *  carries. manifest.json and journal.json are read INDEPENDENTLY (not
 *  one gating the other): status is a diagnostic read, and a damaged
 *  file on one side must not blank the facts still readable from the
 *  other — each missing fact reports as `null`, never a thrown
 *  exception that would blank the whole list over one bad transaction. */
function listDoneTransactionSummaries(backupRoot) {
  return listDoneTransactionIds(backupRoot).map((id) => {
    const dir = join(backupRoot, id);
    let sourceSha = null;
    let targetSha = null;
    let envConsistency = null;
    try {
      const manifest = readManifest(dir);
      sourceSha = manifest.source_sha;
      targetSha = manifest.target_sha;
      // issue #220 absorption (turn 8 follow-up): surfaces the recorded
      // {skipped:true, reason} or {skipped:false, entries} directly —
      // an operator picking a rollback target needs to know whether
      // env_consistency was ever actually checked for it.
      envConsistency = manifest.env_consistency;
    } catch {
      // manifest.json is written exactly once, right after ARCHIVED
      // (runUpdate's own writeManifest call) — unreadable here means the
      // directory was damaged AFTER the fact, not that this transaction
      // never finished (listDoneTransactionIds already required DONE).
    }
    let doneAt = null;
    try {
      doneAt = readJournal(dir).history.find((e) => e.phase === PHASE.DONE)?.at ?? null;
    } catch {
      // Same reasoning as above, independently — a damaged journal.json
      // must not also blank the manifest facts read above.
    }
    return { id, sourceSha, targetSha, envConsistency, doneAt };
  });
}

/** `status`: read-only diagnostic over the current container state, any
 *  in-progress transaction, and past DONE transactions — never mutates
 *  anything, never acquires the deploy lock. Every leg below is
 *  INDEPENDENT (クロエ round 4 review MF-4): a problem reading one part
 *  of the on-disk state must still let every other, healthy leg report.
 *
 *  Container state is checked via `requireRunningContainer` FIRST (the
 *  "everything is fine" case) and only falls back to `classify()` on a
 *  `BranchError` specifically (クロエ round 4 review SF-3) —
 *  `classify()` is documented as answering the "no running container"
 *  branch table (A/B/C/D) alone, so calling it unconditionally would
 *  misreport a normally-running container as branch D, AND calling it
 *  after some OTHER failure (docker itself unreachable) would just hit
 *  docker a second time and let a raw, undiagnosed error escape instead
 *  of a reported `container.error`.
 *
 *  `scopeNote` (director ruling 2026-09-06, point (f); reworded per
 *  クロエ round 4 review SF-4, which found the original overclaimed):
 *  states exactly what this command reads and does not. */
export function runStatus(flags, config) {
  const repo = flags.repo ?? process.cwd();
  const serverDir = join(repo, "server");
  const { bin, overridden } = resolveDockerBin(config);
  const backupRoot = resolveBackupRoot(config);
  const hasState = hasPriorTransactions(bin, serverDir, backupRoot);

  let containerState;
  try {
    const container = requireRunningContainer(bin, serverDir, SERVICE);
    containerState = { running: true, container };
  } catch (err) {
    if (err instanceof BranchError) {
      const result = classify(bin, serverDir, SERVICE, hasState);
      containerState = {
        running: false,
        branch: result.branch,
        reason: result.reason,
        container: result.container ?? null,
      };
    } else {
      // docker itself is unreachable (or some other non-branch failure)
      // — classify() would only hit docker again and fail the same way,
      // so this is reported as-is rather than escaping as a raw error.
      containerState = { running: false, error: err.message };
    }
  }

  let health = null;
  if (containerState.running) {
    try {
      const url = resolveHealthUrl(bin, serverDir, config);
      const result = fetchHealth(resolveCurlBin(), url);
      health = result.ok ? { url, ...result.body } : { url, error: result.error };
    } catch (err) {
      health = { error: err.message };
    }
  }

  // クロエ round 4 review MF-4: findUnfinishedTransaction throws BY
  // DESIGN on internally-inconsistent state (right for `update`, which
  // must not silently proceed past it) — but status is a diagnostic
  // read, not a mutation, so the same finding must not blank every
  // OTHER leg this function can still answer.
  let unfinished = null;
  let unfinishedError = null;
  try {
    unfinished = findUnfinishedTransaction(backupRoot);
  } catch (err) {
    unfinishedError = { error: err.message, directory: err.directory ?? null };
  }
  // issue #220 absorption (turn 8 follow-up): surfaced only once the
  // transaction has actually reached that phase — earlier phases have
  // no ENV_CONSISTENCY_CHECKED entry yet, and that absence (not a false
  // "skipped") is itself the correct fact to report.
  const unfinishedEnvConsistency =
    unfinished === null
      ? null
      : (unfinished.journal.history.find((e) => e.phase === PHASE.ENV_CONSISTENCY_CHECKED)?.observation ?? null);

  return {
    command: "status",
    docker: overridden ? "fake" : "docker",
    container: containerState,
    health,
    unfinishedTransaction:
      unfinishedError !== null
        ? unfinishedError
        : unfinished === null
          ? null
          : { id: unfinished.id, phase: unfinished.journal.phase, envConsistency: unfinishedEnvConsistency },
    doneTransactions: listDoneTransactionSummaries(backupRoot),
    scopeNote:
      "status returns: container state (running, or the diagnosed A/B/D branch), health provenance " +
      "from the target's own endpoint, any unfinished transaction's phase, and the DONE transaction " +
      "history. It does not read runner-side signals (systemctl status, EX_CONFIG, the runner's own " +
      "journal), does not perform the first-application user-ledger migration judgment (5-b), and " +
      "does not diagnose the reason behind a runner-side build failure.",
  };
}

/** PRE-archive guard only (see the call site's comment): whether a
 *  volume has anything in it at all, via a throwaway alpine container.
 *  What gets RECORDED as required_entries comes from parseTarEntries
 *  instead (SF-5) — this function only answers "would archiving this be
 *  pointless".
 *
 *  クロエ round 1 review MF-4: `find -mindepth 1 -maxdepth 1`, not a bare
 *  `/data/*` glob. An empty directory leaves an unquoted glob unexpanded
 *  (`sh` passes the literal string `/data/*` through), so `[ -e "$f" ]`
 *  is false and — being the LAST command the loop ever runs — the whole
 *  script's own exit status is 1, not 0: `execFileSync` throws before
 *  `.length === 0` is ever reached, making the empty-volume guard
 *  unreachable in production regardless of what it checks. Measured live
 *  (`sh -c` against a real empty dir: exit 1, automated as
 *  VOLUME_LISTING_SCRIPT's own test) and, separately (a manual
 *  one-time check against a real `docker run alpine`, not an automated
 *  test — busybox's `find`/`stat` are not guaranteed identical to GNU
 *  coreutils' and this is the one place that distinction matters): `find`
 *  and `stat -c %04a` both present via alpine's busybox, exit 0 empty
 *  output on an empty dir. */
// Exported so the mutation-check test can run the EXACT same script text
// through a real `sh -c` against a real directory (MF-4 pin (a)) instead
// of a hand-copied duplicate that could silently drift from what
// production actually runs.
export const VOLUME_LISTING_SCRIPT =
  "find /data -mindepth 1 -maxdepth 1 -exec stat -c '%n %u:%g %04a' {} \\;";

function listVolumeEntries(bin, volumeId) {
  const output = runDocker(bin, [
    "run",
    "--rm",
    "-v",
    `${volumeId}:/data:ro`,
    ALPINE_IMAGE,
    "sh",
    "-c",
    VOLUME_LISTING_SCRIPT,
  ]);
  if (output === "") return [];
  return output.split("\n").map((line) => {
    const [rawPath, owner, mode] = line.split(" ");
    return { path: rawPath.replace(/^\/data\//, ""), owner, mode };
  });
}

/** Converts a `tar tv*` permission string (`drwxr-sr-x`, `-rw-------`,
 *  `-rwSr--r--`, …) to the 4-digit octal mode manifest entries use.
 *  Special bits overlay the execute position (lower-case with execute
 *  ALSO set, upper-case without) — measured against real GNU tar output
 *  for setuid/setgid/sticky combined with and without execute, not
 *  assumed from the format's name alone. */
function modeFromTarPermString(perm) {
  const bits = perm.slice(1);
  const [ur, uw, ux] = bits.slice(0, 3);
  const [gr, gw, gx] = bits.slice(3, 6);
  const [pr, pw, px] = bits.slice(6, 9);
  const owner = (ur === "r" ? 4 : 0) + (uw === "w" ? 2 : 0) + (ux === "x" || ux === "s" ? 1 : 0);
  const group = (gr === "r" ? 4 : 0) + (gw === "w" ? 2 : 0) + (gx === "x" || gx === "s" ? 1 : 0);
  const other = (pr === "r" ? 4 : 0) + (pw === "w" ? 2 : 0) + (px === "x" || px === "t" ? 1 : 0);
  const special =
    (ux === "s" || ux === "S" ? 4 : 0) +
    (gx === "s" || gx === "S" ? 2 : 0) +
    (px === "t" || px === "T" ? 1 : 0);
  return `${special}${owner}${group}${other}`;
}

// One line of `tar tv*f ... --numeric-owner`: permission string, then
// numeric uid/gid (guaranteed numeric only by --numeric-owner — without
// it, a uid tar's own metadata happens to recognise, uid 0 above all,
// prints as a name like "root" instead), size, date, time, and the rest
// of the line verbatim as the entry name (names may contain spaces —
// only ONE separating space is consumed before it, measured against a
// real archive containing a space-bearing filename).
const TAR_TVZF_LINE_RE = /^(\S+)\s+(\d+)\/(\d+)\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s(.*)$/;

/** クロエ round 2 review SF-8: a symlink or hardlink line's NAME field
 *  carries a target suffix (` -> target` for a symlink, ` link to
 *  target` for a hardlink — measured against a real archive containing
 *  both) that TAR_TVZF_LINE_RE's own generic "rest of the line" capture
 *  cannot distinguish from a space-bearing plain name — the same class
 *  of problem as that regex's own space handling, a second instance of
 *  it. Branches on the entry-type character (the permission string's
 *  own first column) to strip exactly that suffix for the two types that
 *  carry one; any other type this archive is not expected to ever
 *  contain (block/char device, fifo, socket) fails loudly rather than
 *  silently keeping a suffix that does not belong in a path. */
function splitTarEntryName(typeChar, rawName) {
  if (typeChar === "l") {
    const idx = rawName.indexOf(" -> ");
    if (idx === -1) {
      fail(`symlink entry is missing its own " -> " target marker: ${rawName}`);
    }
    return rawName.slice(0, idx);
  }
  if (typeChar === "h") {
    const idx = rawName.indexOf(" link to ");
    if (idx === -1) {
      fail(`hardlink entry is missing its own " link to " target marker: ${rawName}`);
    }
    return rawName.slice(0, idx);
  }
  if (typeChar === "d" || typeChar === "-") {
    return rawName;
  }
  fail(
    `archive contains an unsupported entry type '${typeChar}' for ${rawName} — only regular files, directories, symlinks, and hardlinks are expected in this volume`,
  );
}

/** Parses `tar tv*f --numeric-owner`'s own output text into
 *  manifest-shaped required-entry records (クロエ round 1 review SF-5) —
 *  a pure function over already-captured text, kept separate from
 *  actually RUNNING tar (see the call site) so a parse failure and an
 *  archive-integrity failure surface as two distinguishable errors
 *  (クロエ round 2 review N-7), not one message conflating both. Recurses
 *  into the whole archive (unlike the old top-level-only volume scan),
 *  which also closes that scan's dotfile gap for free — `tar -C /data .`
 *  always included them; the pre-archive scan just never reported them.
 *  The archive root entry itself (`./`) is not a required entry. */
export function parseTarEntries(output) {
  const trimmed = output.trim();
  if (trimmed === "") return [];
  const entries = [];
  for (const line of trimmed.split("\n")) {
    const match = TAR_TVZF_LINE_RE.exec(line);
    if (match === null) {
      fail(`could not parse tar tvzf output line: ${line}`);
    }
    const [, perm, uid, gid, rawName] = match;
    const name = splitTarEntryName(perm.charAt(0), rawName)
      .replace(/^\.\//, "")
      .replace(/\/$/, "");
    if (name === "") continue;
    entries.push({ path: name, owner: `${uid}:${gid}`, mode: modeFromTarPermString(perm) });
  }
  return entries;
}

/** Whether `actual` (a restored volume's own parsed tar listing) EXACTLY
 *  matches `expected` (the manifest's recorded required_entries) —
 *  order-independent (both sides sorted by path first), but otherwise
 *  exact: an extra, a missing, or a differing owner/mode entry on either
 *  side is a mismatch. Exported and unit-tested directly (director
 *  ruling 2026-09-06: rollback's own destructive-path restore-
 *  verification guard is the highest-risk point in this whole CLI to
 *  leave unpinned — FAKE_DOCKER's shared `run` scenario handling has no
 *  way to make a SECOND `tar czf` call inside one test differ from the
 *  first, so this is pinned as a pure function instead of through a
 *  fixture). */
export function requiredEntriesMatch(actual, expected) {
  const byPath = (a, b) => a.path.localeCompare(b.path);
  return JSON.stringify([...actual].sort(byPath)) === JSON.stringify([...expected].sort(byPath));
}

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  const config = loadConfig(flags.config);
  switch (command) {
    case "build":
      return runBuild(flags, config);
    case "start":
      return runStart(flags, config);
    case "update":
      return runUpdate(flags, config);
    case "status":
      return runStatus(flags, config);
    case "rollback":
      return runRollback(flags, config);
    default:
      fail(`unknown command: ${command} (build/start/update/status/rollback implemented)`, 64);
  }
}

function isEntryPoint() {
  return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`kaoiro-server-deploy: ${err.message}\n`);
      process.exit(err instanceof DeployError ? err.exitCode : 1);
    });
}
