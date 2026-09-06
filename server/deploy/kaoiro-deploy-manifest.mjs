#!/usr/bin/env node
// Deploy manifest: the durable record binding one deploy transaction's
// artifacts together (issue #306, design per #303 comments 2026-09-06:
// "a deploy manifest ... compose artifact path+SHA, env consistency
// values, image ID, source/target SHA, volume ID, archive path+SHA,
// required-entry set/ownership"). Read/write/validate only — callers
// decide when a transaction writes one.
//
// Phase lives in the journal (kaoiro-deploy-journal.mjs), not here: the
// manifest records FACTS about artifacts a transaction produced, the
// journal records WHERE the transaction currently is. Splitting them
// means a phase transition never has to rewrite (and re-validate) the
// artifact facts that did not change.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileDurably } from "./kaoiro-deploy-atomic-write.mjs";

// Exported (not just module-local) so kaoiro-deploy-phase.mjs's
// per-phase observation schemas (S1 item i, yuta ruling 2026-09-06) can
// validate a journal entry's `old_sha`/`target_sha`/`image_id`/
// `compose_artifact` against the SAME domains this file enforces on the
// manifest — one definition of "what a SHA/image id looks like", not
// two independently drifting ones.
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const SHA_RE = /^[0-9a-f]{40}$/;
export const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
// クロエ round 1 review MF-2 / director ruling 2026-09-06: shared with
// kaoiro-deploy-phase.mjs's OLD_IMAGE_SAVED schema (imported back from
// here, not redefined) — one definition of what a rollback tag looks
// like. Recorded on the manifest too (director ruling: retention's
// docker-tag cleanup must read the tag to remove from the manifest,
// never rediscover it by globbing docker's own image list).
export const ROLLBACK_TAG_RE = /^kaoiro-server:rollback-[0-9a-f]{40}$/;
const OWNER_RE = /^[0-9]+:[0-9]+$/;
// クロエ round 1 review SF-7: `stat -c %a` omits the special-bits digit
// when it is zero (a plain 644 file prints "644", but a setgid dir
// prints "2755" — 4 digits, not 3) and prints a bare "0" for mode 000,
// not "000". A fixed `0[0-7]{3}` shape can never represent either —
// exactly 4 octal digits, no fixed leading zero, is what `%04a` (used at
// the call site) actually produces.
const MODE_RE = /^[0-7]{4}$/;

export class ManifestError extends Error {}

function fail(message) {
  throw new ManifestError(message);
}

export function isPathSha(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.path === "string" &&
    value.path !== "" &&
    typeof value.sha256 === "string" &&
    SHA256_RE.test(value.sha256)
  );
}

/** One env-var's three-way comparison (ふじ design review M1): the
 *  actual KEY SET being compared (`.env` explicit values vs. compose vs.
 *  container effective env, #220 absorption) is not decided yet — that
 *  is a later commit's preflight work. What this fixes NOW is the
 *  per-key VALUE SHAPE, so a manifest can no longer claim
 *  `env_consistency: []` or `{checked: true}` and pass: each recorded
 *  key must actually carry the three observed values and the computed
 *  match result. `null` means "not present in that source", which is a
 *  legitimate observation, not a missing measurement. */
function isEnvConsistencyEntry(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value.env_file === null || typeof value.env_file === "string") &&
    (value.compose === null || typeof value.compose === "string") &&
    (value.container === null || typeof value.container === "string") &&
    typeof value.match === "boolean"
  );
}

/** env_consistency is a discriminated union (issue #220 absorption,
 *  director ruling 2026-09-06) — exported so
 *  kaoiro-deploy-phase.mjs's ENV_CONSISTENCY_CHECKED observation schema
 *  validates the SAME shape this file enforces on the manifest, one
 *  definition rather than two independently drifting ones (the same
 *  pattern as ROLLBACK_TAG_RE above).
 *
 *  `{skipped: true, reason}`: the target image's persistence-path `eval`
 *  itself exited non-zero — the querying module has not landed on that
 *  image (a pre-#310 image, or an old image a rollback targets). Recorded
 *  rather than silently treated as "no keys to check", so an operator
 *  reading the manifest later can tell "checked, found nothing to flag"
 *  apart from "never actually checked".
 *
 *  `{skipped: false, entries: {<env var name>: {env_file, compose,
 *  container, match}}}`: the eval succeeded — one three-way comparison
 *  per canonical persistence-path key it reported. A bare per-key map
 *  (the shape before this discriminator existed) is no longer valid on
 *  its own; every writer already produces the new shape, and silently
 *  accepting the old one would make a writer bug indistinguishable from
 *  an intentional skip. */
export function isValidEnvConsistency(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (value.skipped === true) {
    return typeof value.reason === "string" && value.reason !== "";
  }
  if (value.skipped === false) {
    if (typeof value.entries !== "object" || value.entries === null || Array.isArray(value.entries)) {
      return false;
    }
    return Object.values(value.entries).every(isEnvConsistencyEntry);
  }
  return false;
}

/** Validates the shape the operator decisions on #303 fixed. STRICT, like
 *  verify-release.mjs's isBuildInfoShape: a manifest with any invalid
 *  field is not trustworthy over the whole, so this returns false rather
 *  than accepting the fields that happen to look fine. */
export function isValidManifestShape(value) {
  if (typeof value !== "object" || value === null) return false;
  if (value.schema_version !== 1) return false;
  if (typeof value.transaction_id !== "string" || value.transaction_id === "") {
    return false;
  }
  if (!isPathSha(value.compose_artifact)) return false;
  if (!isValidEnvConsistency(value.env_consistency)) return false;
  if (typeof value.image_id !== "string" || !IMAGE_ID_RE.test(value.image_id)) {
    return false;
  }
  if (typeof value.source_sha !== "string" || !SHA_RE.test(value.source_sha)) {
    return false;
  }
  if (typeof value.target_sha !== "string" || !SHA_RE.test(value.target_sha)) {
    return false;
  }
  if (typeof value.volume_id !== "string" || value.volume_id === "") return false;
  if (!isPathSha(value.archive)) return false;
  if (!isValidRequiredEntries(value.required_entries)) return false;
  if (typeof value.rollback_tag !== "string" || !ROLLBACK_TAG_RE.test(value.rollback_tag)) {
    return false;
  }
  if (value.rollback_tag !== `kaoiro-server:rollback-${value.source_sha}`) return false;
  return true;
}

/** Exported separately from isValidManifestShape (used directly by
 *  kaoiro-deploy-phase.mjs's ARCHIVED observation schema) so the archive
 *  phase's own required-entries check and the manifest's stay the SAME
 *  domain rather than two independently drifting ones. */
export function isValidRequiredEntries(value) {
  if (!Array.isArray(value)) return false;
  // Path uniqueness (ふじ design review M1) — a duplicate path is not a
  // malformed entry on its own, but two entries claiming the same
  // persistent-path record two different owner/mode expectations for
  // one file, which cannot both hold.
  const seenPaths = new Set();
  for (const entry of value) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.path !== "string" ||
      entry.path === "" ||
      seenPaths.has(entry.path) ||
      typeof entry.owner !== "string" ||
      !OWNER_RE.test(entry.owner) ||
      typeof entry.mode !== "string" ||
      !MODE_RE.test(entry.mode)
    ) {
      return false;
    }
    seenPaths.add(entry.path);
  }
  return true;
}

/** Writes manifest.json durably via writeFileDurably() (ふじ design
 *  review M3: fsync the file before rename, fsync the directory after —
 *  a reader never observes a partial write, and the write survives a
 *  crash, not just a normal read). Refuses to write a manifest that
 *  fails its own shape check: a manifest this file cannot read back is
 *  worse than none. */
export function writeManifest(dir, manifest) {
  if (!isValidManifestShape(manifest)) {
    fail("refusing to write a manifest that does not match the expected shape");
  }
  const target = join(dir, "manifest.json");
  writeFileDurably(target, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Reads and STRICTLY validates manifest.json. Never degrades a missing
 *  or malformed file to a default — unlike build_info.ts's loadBuildInfo,
 *  which exists to let a runner still start. A manifest this file cannot
 *  trust must stop the caller: silently treating it as absent would let
 *  an update proceed with no record of what it is about to replace. */
export function readManifest(dir) {
  const target = join(dir, "manifest.json");
  let raw;
  try {
    raw = readFileSync(target, "utf8");
  } catch (err) {
    fail(`manifest.json is unreadable at ${target}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`manifest.json is not valid JSON at ${target}: ${err.message}`);
  }
  if (!isValidManifestShape(parsed)) {
    fail(`manifest.json at ${target} does not match the expected shape`);
  }
  return parsed;
}
