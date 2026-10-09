#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { activityFor, readReleaseAttempt } from "./production-release-history.mjs";
import { attemptDirectory, createPrivateDirectory, readPrivateBytes, readPrivateJson, releaseBytesDigest,
  releaseJsonBytes, requirePrivateDirectory, syncDirectory, withAsyncReleaseLock, writePrivateRecord } from "./production-release-files.mjs";
import { RELEASE_SHA, parseReleaseOptions, validateReleaseReason } from "./production-release-state.mjs";
import { validateRuntimeHosts } from "./production-release-plan.mjs";
import { readPublishedProductionRelease } from "./production-release-tags.mjs";

const must = (value, message) => { if (!value) throw new Error(`release lifecycle refused: ${message}`); };
const TERMINALS = new Set(["published", "abandoned", "invalid_quarantined", "deployed_uncompleted"]);

export async function readLifecycleInspection(row, { healthUrl, inventory, now = Date.now() }) {
  const aliases = row.plan?.host_ids ?? validateRuntimeHosts(inventory).map(pair => pair.alias);
  const activity = activityFor(row.records, row.plan ?? { attempt_uuid: row.attempt_uuid, host_ids: aliases }, { now, requireFresh: true });
  must(activity.state === "idle" && activity.events.length === aliases.length, "queued/running/unknown activity; collect fresh native activity for all enrolled legs");
  must(typeof healthUrl === "string", "recording-server health URL required");
  const url = new URL(healthUrl);
  must(["http:", "https:"].includes(url.protocol), "health URL scheme");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  must(response.ok, "recording-server health unavailable");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    must(size <= 65_536, "health response bound");
    chunks.push(chunk);
  }
  const health = JSON.parse(Buffer.concat(chunks));
  must(RELEASE_SHA.test(health.build_revision ?? ""), "recording-server revision unknown");
  must(activity.events.every(event => RELEASE_SHA.test(event.current_revision ?? "")), "runner current revision unknown");
  return { observed_at: new Date(now).toISOString(), simulation: false, activity: "idle",
    server_revision: health.build_revision, runner_revisions: activity.events.map(event => ({ alias: event.alias, revision: event.current_revision })),
    activity_sha256: releaseBytesDigest(releaseJsonBytes(activity.events)),
    inventory_sha256: inventory ? releaseBytesDigest(releaseJsonBytes(validateRuntimeHosts(inventory))) : null };
}

function guardInspection(inspection, aliases, now) {
  const age = now - Date.parse(inspection?.observed_at);
  must(Number.isFinite(age) && age >= 0 && age <= 300_000 && inspection.simulation === false,
    "fresh native lifecycle inspection required");
  must(inspection.activity === "idle", "queued/running/unknown rollout cannot terminate");
  must(RELEASE_SHA.test(inspection.server_revision ?? "") && Array.isArray(inspection.runner_revisions) &&
    inspection.runner_revisions.length === aliases.length && new Set(inspection.runner_revisions.map(item => item.alias)).size === aliases.length &&
    inspection.runner_revisions.every(item => aliases.includes(item.alias) && RELEASE_SHA.test(item.revision ?? "")), "complete current inventory required");
}

function preserveIncident(row) {
  const evidence = createPrivateDirectory(join(row.dir, "incident-evidence"));
  const records = [];
  for (const [name, item] of Object.entries(row.records).sort(([a], [b]) => a.localeCompare(b))) {
    const raw = readPrivateBytes(join(row.dir, name), { legacyMode: true });
    must(releaseBytesDigest(raw) === item.sha256, "snapshot_changed");
    writePrivateRecord(evidence, `${item.sha256}.raw`, raw, { kind: "incident-bytes", scope: "incident" });
    records.push({ name, sha256: item.sha256 });
  }
  const manifest = { schema: 1, attempt_uuid: row.attempt_uuid, records };
  const digest = releaseBytesDigest(releaseJsonBytes(manifest));
  writePrivateRecord(evidence, `${digest}.manifest.json`, manifest, { kind: "incident-manifest", scope: "incident" });
  return digest;
}

export async function terminateReleaseAttempt({ root, uuid, command, reason, healthUrl, inventory,
  now, inspectionProvider = row => readLifecycleInspection(row, { healthUrl, inventory, now }) }) {
  validateReleaseReason(reason);
  const dir = attemptDirectory(root, uuid);
  return withAsyncReleaseLock(dir, "record", async () => {
    const row = readReleaseAttempt(dir);
    must(row.state.id !== "unknown_identity", "unknown identity cannot terminate; repair-history required");
    must(!TERMINALS.has(row.state.id), "valid terminal record is immutable");
    const aliases = row.plan?.host_ids ?? validateRuntimeHosts(inventory).map(pair => pair.alias);
    if (row.plan) must(row.activity.state === "idle", "canonical queued/running/unknown activity must be closed first");
    const inspection = await inspectionProvider(row);
    const checkedAt = now ?? Date.now();
    guardInspection(inspection, aliases, checkedAt);
    const target = row.plan?.identity.revision;
    if (command === "abandon") {
      must(row.plan && !row.records["completion.json"] && !row.observation.invalid && !row.observation.conflict, "abandon requires a valid unfinished plan without completion");
      must(!row.observation.applied, "applied attempt must complete/repair or explicitly retire-deployed");
      must(inspection.server_revision !== target, "healthy server is still at attempt target");
      must(inspection.runner_revisions.every(item => item.revision !== target), "runner is still at attempt target");
      const record = { schema: 1, kind: "abandoned", attempt_uuid: uuid, plan_sha256: row.plan_sha256,
        created_at: new Date(checkedAt).toISOString(), reason,
        guards: { unused_at_transition: true, idle_at_transition: true }, inspection };
      writePrivateRecord(dir, "abandonment.json", record);
      return record;
    }
    const kind = command === "quarantine" ? "invalid_quarantined" : "deployed_uncompleted";
    if (command === "quarantine") {
      must(row.state.id === "invalid_completion", "quarantine requires a known invalid record, not a valid in-progress/published attempt");
    } else {
      must(command === "retire-deployed" && row.plan && !row.records["completion.json"] &&
        !row.observation.invalid && row.observation.applied, "retire-deployed requires a valid applied unfinished attempt");
      must(inspection.server_revision !== target && inspection.runner_revisions.every(item => item.revision !== target), "all plan legs must leave the target before retirement");
    }
    const record = { schema: 1, kind, attempt_uuid: uuid, plan_sha256: row.plan_sha256,
      created_at: new Date(checkedAt).toISOString(), reason, evidence_sha256: preserveIncident(row),
      guards: { idle_at_transition: true, ...(kind === "deployed_uncompleted" ? { retired_all_legs: true } : {}) }, inspection };
    const filename = kind === "invalid_quarantined" ? "quarantine.json" : "retirement.json";
    writePrivateRecord(dir, filename, record, { replaceInvalid: existsSync(join(dir, filename)) });
    return record;
  });
}

export async function archiveReleaseAttempt({ root, uuid, cwd, remote = "origin", local = false, unitsHandled = false }) {
  const dir = attemptDirectory(root, uuid);
  return withAsyncReleaseLock(root, "history", async () => {
    return withAsyncReleaseLock(dir, "record", async lock => {
      const row = readReleaseAttempt(dir);
      if (row.completion && !["invalid_quarantined", "deployed_uncompleted"].includes(row.state.id)) {
        readPublishedProductionRelease({ cwd, remote, receipt: row.completion,
          repositoryId: row.completion.repository_id, allowedHosts: row.plan.host_ids });
      } else must(["abandoned", "invalid_quarantined", "deployed_uncompleted"].includes(row.state.id), "cannot archive unresolved/skipped attempt");
      if (local) must(unitsHandled === true, "working-copy archive requires separately verified exact unit handling");
      const archive = createPrivateDirectory(`${resolve(root)}-archive`);
      const destination = join(archive, uuid);
      must(!existsSync(destination), "archive destination already exists");
      must(lstatSync(dir).dev === lstatSync(archive).dev, "cross-device archive refused");
      renameSync(dir, destination);
      lock.path = join(destination, ".lock.record");
      syncDirectory(root);
      syncDirectory(archive);
      return { archived: true, destination, status: row.completion && !["invalid_quarantined", "deployed_uncompleted"].includes(row.state.id) ? "published" : row.state.id };
    });
  }, "root");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const flags = parseReleaseOptions(args, ["root", "uuid", "reason", "repo", "health-url", "inventory"]);
  if (command === "archive") return archiveReleaseAttempt({ root: flags.root, uuid: flags.uuid, cwd: flags.repo });
  if (!["abandon", "quarantine", "retire-deployed"].includes(command)) throw new Error("unknown lifecycle command");
  const inventory = flags.inventory ? readPrivateJson(flags.inventory, { privateParent: false }) : undefined;
  return terminateReleaseAttempt({ root: flags.root, uuid: flags.uuid, command, reason: flags.reason, healthUrl: flags["health-url"], inventory });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await main())); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 78; }
}
