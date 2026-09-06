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
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export class ManifestError extends Error {}

function fail(message) {
  throw new ManifestError(message);
}

function isPathSha(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.path === "string" &&
    value.path !== "" &&
    typeof value.sha256 === "string" &&
    SHA256_RE.test(value.sha256)
  );
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
  if (typeof value.env_consistency !== "object" || value.env_consistency === null) {
    return false;
  }
  if (typeof value.image_id !== "string" || value.image_id === "") return false;
  if (typeof value.source_sha !== "string" || !SHA_RE.test(value.source_sha)) {
    return false;
  }
  if (typeof value.target_sha !== "string" || !SHA_RE.test(value.target_sha)) {
    return false;
  }
  if (typeof value.volume_id !== "string" || value.volume_id === "") return false;
  if (!isPathSha(value.archive)) return false;
  if (!Array.isArray(value.required_entries)) return false;
  for (const entry of value.required_entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.path !== "string" ||
      entry.path === "" ||
      typeof entry.owner !== "string" ||
      entry.owner === "" ||
      typeof entry.mode !== "string" ||
      entry.mode === ""
    ) {
      return false;
    }
  }
  return true;
}

/** Writes manifest.json atomically: write a temp file in the SAME
 *  directory, then rename — a reader (including a concurrent `status`)
 *  never observes a partial write. Same rationale as
 *  kaoiro-runner-common.sh's kaoiro_symlink_swap. Refuses to write a
 *  manifest that fails its own shape check: a manifest this file cannot
 *  read back is worse than none. */
export function writeManifest(dir, manifest) {
  if (!isValidManifestShape(manifest)) {
    fail("refusing to write a manifest that does not match the expected shape");
  }
  const target = join(dir, "manifest.json");
  const tmp = `${target}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, target);
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
