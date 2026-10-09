#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILD_REPOSITORY_ID,
  formatLandingVersion,
  parseLandingVersion,
  readLandingTag,
  validateLandingRecord,
} from "./build-identity.mjs";

const MAX_ATTEMPTS = 5;
const GIT_TIMEOUT_MS = 30_000;
const RESERVED_VERSION_PREFIX = /^v\d{4}\.\d{2}\.\d{2}\./;

function runGit(cwd, args, input) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function gitChecked(cwd, args, input) {
  const result = runGit(cwd, args, input);
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args[0]} failed${result.status === 0 ? " to start" : ` (exit ${result.status})`}`);
  }
  return result.stdout.trimEnd();
}

function parseInventory(snapshot, repositoryId) {
  const raw = gitChecked(snapshot, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/tags"]);
  const refs = raw.split("\n").filter(Boolean).map(line => {
    const separator = line.indexOf(" ");
    if (separator < 1) throw new Error("malformed remote tag inventory");
    return { object: line.slice(0, separator), ref: line.slice(separator + 1) };
  });
  const signature = refs.map(({ object, ref }) => `${ref}\t${object}`).sort().join("\n");
  const publicByRevision = new Map();
  const publicByName = new Map();
  const claims = new Map();
  const byDay = new Map();

  for (const { object, ref } of refs) {
    const tagName = ref.slice("refs/tags/".length);
    if (tagName === "identity/landing" || tagName.startsWith("identity/landing/")) {
      const match = /^identity\/landing\/([0-9a-f]{40})$/.exec(tagName);
      if (!match || claims.has(match[1])) throw new Error("malformed landing SHA claim ref");
      claims.set(match[1], object);
      continue;
    }
    if (!RESERVED_VERSION_PREFIX.test(tagName)) continue;

    const parsedName = parseLandingVersion(tagName.slice(1));
    if (!parsedName) throw new Error(`malformed reserved landing tag: ${tagName}`);
    const landing = readLandingTag(snapshot, tagName, repositoryId);
    if (landing.object !== object || landing.tag !== tagName || landing.record.version !== tagName.slice(1)) {
      throw new Error(`landing tag inventory disagrees: ${tagName}`);
    }
    if (publicByName.has(tagName) || publicByRevision.has(landing.record.revision)) {
      throw new Error(`duplicate landing identity: ${tagName}`);
    }
    const entry = { ...landing, day: parsedName.day, number: parsedName.number };
    publicByName.set(tagName, entry);
    publicByRevision.set(landing.record.revision, entry);
    const numbers = byDay.get(parsedName.day) ?? new Set();
    if (numbers.has(parsedName.number)) throw new Error(`duplicate landing sequence: ${parsedName.day}`);
    numbers.add(parsedName.number);
    byDay.set(parsedName.day, numbers);
  }

  for (const [revision, object] of claims) {
    const landing = publicByRevision.get(revision);
    if (!landing || landing.object !== object) throw new Error(`orphaned or mismatched landing claim: ${revision}`);
  }
  for (const [day, numbers] of byDay) {
    const sorted = [...numbers].sort((left, right) => left - right);
    if (sorted.some((number, index) => number !== index + 1)) {
      throw new Error(`landing sequence for ${day} is not contiguous`);
    }
  }
  return { refs, signature, publicByRevision, publicByName, byDay };
}

function readRemoteInventory(remote, repositoryId) {
  const snapshot = mkdtempSync(join(tmpdir(), "kaoiro-landing-inventory-"));
  try {
    gitChecked(snapshot, ["init", "--bare", "--quiet"]);
    gitChecked(snapshot, ["remote", "add", "landing-source", remote]);
    gitChecked(snapshot, ["fetch", "--no-tags", "--no-recurse-submodules", "landing-source", "+refs/tags/*:refs/tags/*"]);
    const inventory = parseInventory(snapshot, repositoryId);
    return { snapshot, inventory, dispose: () => rmSync(snapshot, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(snapshot, { recursive: true, force: true });
    throw error;
  }
}

function resolvePushRemote(cwd, remote) {
  const configured = runGit(cwd, ["remote", "get-url", "--push", "--all", remote]);
  if (!configured.error && configured.status === 0) {
    const urls = configured.stdout.split("\n").map(value => value.trim()).filter(Boolean);
    if (urls.length !== 1) throw new Error("landing remote must resolve to exactly one push URL");
    return urls[0];
  }
  return remote;
}

function makeLandingObject(cwd, record) {
  const validated = validateLandingRecord(record, record.repository_id);
  const tag = `v${validated.version}`;
  const taggerSeconds = Math.floor(Date.parse(validated.created_at) / 1000);
  const raw = [
    `object ${validated.revision}`,
    "type commit",
    `tag ${tag}`,
    `tagger Kaoiro Landing <release@kaoiro.invalid> ${taggerSeconds} +0000`,
    "",
    JSON.stringify(validated),
    "",
  ].join("\n");
  const object = gitChecked(cwd, ["mktag"], raw);
  if (!/^[0-9a-f]{40}$/.test(object)) throw new Error("git mktag returned an invalid object id");
  return { object, tag };
}

function resultFor(landing, created) {
  return { record: landing.record, tag: landing.tag, object: landing.object, created };
}

/**
 * Allocates the immutable version tag and same-object SHA claim for one
 * frozen develop push event. The remote is read through a fresh bare snapshot
 * for every bounded conflict retry; no remote ref is ever moved or deleted.
 */
export function allocateLanding({ cwd, remote, target, originalRunId, createdAt, repositoryId = BUILD_REPOSITORY_ID }) {
  if (typeof cwd !== "string" || cwd.length === 0 || typeof remote !== "string" || remote.length === 0 || remote.startsWith("-")) {
    throw new Error("landing allocation requires a checkout and a valid remote");
  }
  if (typeof target !== "string" || !/^[0-9a-f]{40}$/.test(target)) throw new Error("landing target must be a full lowercase SHA");
  const firstVersion = formatLandingVersion(typeof createdAt === "string" ? createdAt.slice(0, 10) : "", 1);
  validateLandingRecord({
    schema: 1,
    kind: "landing",
    repository_id: repositoryId,
    revision: target,
    branch: "develop",
    version: firstVersion,
    original_run_id: originalRunId,
    created_at: createdAt,
  }, repositoryId);
  gitChecked(cwd, ["cat-file", "-e", `${target}^{commit}`]);
  const inventoryRemote = resolvePushRemote(cwd, remote);

  const day = createdAt.slice(0, 10);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const before = readRemoteInventory(inventoryRemote, repositoryId);
    try {
      const existing = before.inventory.publicByRevision.get(target);
      if (existing) return resultFor(existing, false);

      const numbers = before.inventory.byDay.get(day) ?? new Set();
      const version = formatLandingVersion(day, numbers.size + 1);
      const record = validateLandingRecord({
        schema: 1,
        kind: "landing",
        repository_id: repositoryId,
        revision: target,
        branch: "develop",
        version,
        original_run_id: originalRunId,
        created_at: createdAt,
      }, repositoryId);
      const { object, tag } = makeLandingObject(cwd, record);
      const publicRefspec = `${object}:refs/tags/${tag}`;
      const claimRefspec = `${object}:refs/tags/identity/landing/${target}`;
      const pushed = runGit(cwd, ["push", "--atomic", "--no-follow-tags", remote, publicRefspec, claimRefspec]);

      let after;
      try {
        after = readRemoteInventory(inventoryRemote, repositoryId);
      } catch (error) {
        if (attempt === MAX_ATTEMPTS - 1) throw error;
        continue;
      }
      try {
        const winner = after.inventory.publicByRevision.get(target);
        if (winner) return resultFor(winner, winner.object === object);
        if (pushed.error || pushed.status !== 0) {
          if (after.inventory.signature === before.inventory.signature) {
            throw new Error(`git push --atomic failed (exit ${pushed.status})`);
          }
        }
      } finally {
        after.dispose();
      }
    } finally {
      before.dispose();
    }
  }
  throw new Error(`landing allocation did not converge after ${MAX_ATTEMPTS} attempts`);
}
