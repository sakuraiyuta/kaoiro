import { existsSync, lstatSync, opendirSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { hostname } from "node:os";
import { classifyReleaseState, releaseName, RELEASE_UUID, RELEASE_DIGEST, validateReleaseReason } from "./production-release-state.mjs";
import { readPrivateBytes, readPrivateJson, releaseBytesDigest, releaseEntryInventory,
  releaseJsonBytes, requirePrivateDirectory } from "./production-release-files.mjs";
import { validateEnrollmentInventory, validateReleasePlan, projectReleasePlan } from "./production-release-plan.mjs";
import { validateProductionReceipt } from "./production-release-record.mjs";

const terminalFiles = ["abandonment.json", "quarantine.json", "retirement.json"];
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const must = (value, message) => { if (!value) throw new Error(message); };

export function releaseRowDigest(records) {
  return releaseBytesDigest(releaseJsonBytes(Object.entries(records).map(([name, record]) => [name, record.sha256]).sort(([a], [b]) => a.localeCompare(b))));
}

function record(dir, name) {
  const raw = readPrivateBytes(join(dir, name), { legacyMode: true });
  let value;
  try { value = JSON.parse(raw); } catch { value = null; }
  return { value, sha256: releaseBytesDigest(raw) };
}

export function validateIncident(dir, value, kind, records) {
  if (value?.schema !== 1 || value.kind !== kind || value.attempt_uuid !== basename(dir) ||
      !RELEASE_DIGEST.test(value.evidence_sha256 ?? "") || !timestamp(value.created_at) ||
      typeof value.reason !== "string" || value.guards?.idle_at_transition !== true) return false;
  if (kind === "deployed_uncompleted" && value.guards.retired_all_legs !== true) return false;
  const evidenceDir = join(dir, "incident-evidence");
  if (!existsSync(evidenceDir)) return false;
  const inventory = releaseEntryInventory(evidenceDir, "incident");
  const raw = readPrivateBytes(join(evidenceDir, `${value.evidence_sha256}.manifest.json`));
  if (releaseBytesDigest(raw) !== value.evidence_sha256) return false;
  const manifest = JSON.parse(raw);
  if (manifest.schema !== 1 || manifest.attempt_uuid !== basename(dir) || !Array.isArray(manifest.records)) return false;
  const acknowledged = new Set();
  for (const entry of manifest.records) {
    releaseName("attempt", entry.name, "file");
    if (!RELEASE_DIGEST.test(entry.sha256 ?? "") || acknowledged.has(entry.name)) return false;
    const saved = readPrivateBytes(join(evidenceDir, `${entry.sha256}.raw`));
    if (releaseBytesDigest(saved) !== entry.sha256) return false;
    acknowledged.add(entry.name);
    const terminalName = kind === "invalid_quarantined" ? "quarantine.json" : "retirement.json";
    if (entry.name !== terminalName && records[entry.name]?.sha256 !== entry.sha256) return false;
  }
  const terminalName = kind === "invalid_quarantined" ? "quarantine.json" : "retirement.json";
  if (Object.keys(records).some(name => name !== terminalName && !acknowledged.has(name))) return false;
  return inventory.every(entry => {
    if (entry.name === "manifest.json") return false;
    const rule = releaseName("incident", entry.name, entry.type);
    if (rule.disposition === "diagnostic") return true;
    return releaseBytesDigest(readPrivateBytes(join(evidenceDir, entry.name))) === entry.name.slice(0, 64);
  });
}

export function activityFor(records, plan, { now = Date.now(), freshnessMs = 300_000, requireFresh = false } = {}) {
  if (!plan) return { state: "unknown", events: [] };
  const latest = [];
  let state = "idle";
  for (const alias of plan.host_ids) {
    const events = Object.entries(records).filter(([name]) => name.startsWith(`runner-activity-${alias}-`))
      .map(([, item]) => ({ ...item.value, sha256: item.sha256 })).sort((a, b) => a.sequence - b.sequence);
    if (events.length > 64) return { state: "unknown", events: latest };
    let previous = null;
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (event.schema !== 1 || event.attempt_uuid !== plan.attempt_uuid || event.alias !== alias ||
          event.sequence !== index + 1 || event.previous_sha256 !== previous || !timestamp(event.observed_at) ||
          !["intent", "queued", "running", "idle", "unknown"].includes(event.state) ||
          !RELEASE_UUID.test(event.event_uuid ?? "") || event.simulation !== false) return { state: "unknown", events: latest };
      if (plan.authority) {
        const expected = plan.authority.runners.find(owner => owner.alias === alias);
        if (!expected || event.root !== expected.root || event.authority_sha256 !== expected.sha256 ||
          event.plan_sha256 !== releaseBytesDigest(releaseJsonBytes(plan)) ||
          event.unit !== `kaoiro-release-${plan.attempt_uuid}-${alias}.service`) return { state: "unknown", events: latest };
      }
      previous = event.sha256;
    }
    const event = events.at(-1);
    if (!event) {
      if (requireFresh) state = "unknown";
      continue;
    }
    latest.push(event);
    if (event.state !== "idle" || (requireFresh && (now - Date.parse(event.observed_at) > freshnessMs || Date.parse(event.observed_at) > now))) {
      if (event.state === "unknown" || requireFresh && (now - Date.parse(event.observed_at) > freshnessMs || Date.parse(event.observed_at) > now)) state = "unknown";
      else if (state !== "unknown") state = "active";
    }
  }
  return { state, events: latest };
}

export function readReleaseAttempt(dir) {
  const uuid = basename(dir);
  must(RELEASE_UUID.test(uuid), "attempt identity is not a lowercase v4 UUID");
  const entries = releaseEntryInventory(dir, "attempt");
  const records = {};
  for (const entry of entries) {
    const rule = releaseName("attempt", entry.name, entry.type);
    if (rule.disposition === "diagnostic") {
      if (entry.type === "directory") releaseEntryInventory(join(dir, entry.name), "administrative");
      continue;
    }
    if (entry.type === "file") records[entry.name] = record(dir, entry.name);
    else if (entry.name === "incident-evidence") releaseEntryInventory(join(dir, entry.name), "incident");
  }
  const rawPlan = records["attempt.json"]?.value;
  let identityKnown = !rawPlan || rawPlan.attempt_uuid === undefined || rawPlan.attempt_uuid === uuid;
  let plan = null;
  let completion = null;
  let invalid = false;
  try { plan = validateReleasePlan(rawPlan, uuid); } catch { invalid = true; }
  if (records["completion.json"]) {
    try {
      must(plan, "completion without valid plan");
      completion = validateProductionReceipt(records["completion.json"].value, {
        repositoryId: plan.identity.landing.repository_id, allowedHosts: plan.host_ids,
      });
      must(completion.attempt_uuid === uuid && completion.revision === plan.identity.revision &&
        completion.version === plan.identity.version && completion.branch === plan.identity.branch &&
        JSON.stringify([...completion.host_ids].sort()) === JSON.stringify([...plan.host_ids].sort()) &&
        JSON.stringify([...completion.codex_host_ids].sort()) === JSON.stringify([...plan.codex_host_ids].sort()), "completion plan binding");
    } catch { invalid = true; completion = null; }
  }
  const abandoned = records["abandonment.json"]?.value;
  const planDigest = records["attempt.json"]?.sha256 ?? null;
  const abandonmentValid = abandoned?.schema === 1 && abandoned.kind === "abandoned" &&
    abandoned.attempt_uuid === uuid && abandoned.plan_sha256 === planDigest && timestamp(abandoned.created_at) &&
    abandoned.guards?.unused_at_transition === true && abandoned.guards?.idle_at_transition === true;
  let quarantineValid = false;
  let retirementValid = false;
  try { quarantineValid = validateIncident(dir, records["quarantine.json"]?.value, "invalid_quarantined", records); } catch { invalid = true; }
  try { retirementValid = validateIncident(dir, records["retirement.json"]?.value, "deployed_uncompleted", records); } catch { invalid = true; }
  if (records["abandonment.json"] && !abandonmentValid || records["quarantine.json"] && !quarantineValid ||
      records["retirement.json"] && !retirementValid) invalid = true;
  const conflict = terminalFiles.filter(name => records[name]).length > 1 || (!!completion && !!abandoned);
  let applied = Object.keys(records).some(name => name.startsWith("runner-after-"));
  const externalRecords = [];
  const serverAudit = records["server-audit.json"]?.value;
  if (serverAudit?.transaction_dir) {
    must(typeof serverAudit.transaction_dir === "string" && resolve(serverAudit.transaction_dir) === serverAudit.transaction_dir, "unsafe server audit transaction path");
    const path = join(serverAudit.transaction_dir, "journal.json");
    const raw = readPrivateBytes(path, { legacyMode: true, privateParent: false });
    externalRecords.push({ path, sha256: releaseBytesDigest(raw) });
    const journal = JSON.parse(raw);
    must(journal.release_context?.attempt_uuid === uuid || journal.history?.some(item => item.observation?.release_context?.attempt_uuid === uuid), "server journal belongs to another attempt");
    applied ||= journal.phase === "done";
  }
  const activity = activityFor(records, plan);
  const observation = { identityKnown, invalid, conflict, completionValid: !!completion, abandonmentValid,
    quarantineValid, retirementValid, applied, activity: activity.state };
  const state = classifyReleaseState(observation);
  return { attempt_uuid: uuid, dir, entries, records, plan, plan_sha256: planDigest,
    row_sha256: releaseRowDigest(records), completion, observation, state, activity, externalRecords };
}

export function readReleaseHistory(root, { recordingHostname = hostname() } = {}) {
  if (hostname() !== recordingHostname) throw new Error("release authority role mismatch");
  requirePrivateDirectory(root);
  const before = releaseEntryInventory(root, "root");
  const attempts = before.filter(entry => entry.name.match(RELEASE_UUID));
  if (attempts.length > 1000) throw new Error("release history active directory bound; run verified archive");
  if (before.length > 4096) throw new Error("release administrative listing bound; recover staging/locks");
  const rows = [];
  const diagnostics = [];
  for (const entry of before) {
    if (RELEASE_UUID.test(entry.name)) {
      const row = readReleaseAttempt(join(root, entry.name));
      if (row.state.disposition === "refuse") throw new Error(`unknown attempt identity: ${entry.name}; repair-history required`);
      rows.push(row);
    } else {
      releaseEntryInventory(join(root, entry.name), "administrative");
      diagnostics.push({ name: entry.name, status: "administrative", command: releaseName("root", entry.name, entry.type).exit });
    }
  }
  for (const row of rows) {
    if (JSON.stringify(releaseEntryInventory(row.dir, "attempt")) !== JSON.stringify(row.entries)) throw new Error("snapshot_changed");
    for (const [name, item] of Object.entries(row.records)) {
      if (releaseBytesDigest(readPrivateBytes(join(row.dir, name), { legacyMode: true })) !== item.sha256) throw new Error("snapshot_changed");
    }
    for (const record of row.externalRecords) {
      if (releaseBytesDigest(readPrivateBytes(record.path, { legacyMode: true, privateParent: false })) !== record.sha256) throw new Error("snapshot_changed");
    }
  }
  if (JSON.stringify(releaseEntryInventory(root, "root")) !== JSON.stringify(before)) throw new Error("snapshot_changed");
  return {
    schema: 1, recording_hostname: recordingHostname, root: resolve(root),
    rows, diagnostics, archived_incidents: readArchivedReleaseIncidents(root), warning: attempts.length >= 900 ? "archive before 1000 active attempts" : null,
  };
}

export function readArchivedReleaseIncidents(root) {
  const archive = `${resolve(root)}-archive`;
  if (!existsSync(archive)) return [];
  requirePrivateDirectory(archive);
  const incidents = [], names = new Set(), started = performance.now();
  const iterator = opendirSync(archive);
  try {
    for (;;) {
      const entry = iterator.readSync();
      if (!entry) break;
      must(performance.now() - started < 15_000 && names.size < 100_000, "archive audit bound; restore/maintain verified history");
      must(RELEASE_UUID.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink() && !names.has(entry.name), "unknown archived entry; repair-history required");
      names.add(entry.name);
      const row = readReleaseAttempt(join(archive, entry.name));
      must(row.completion || ["abandoned", "invalid_quarantined", "deployed_uncompleted"].includes(row.state.id), "archive contains unresolved or damaged history");
      if (row.state.disposition === "terminal-incident") {
        const terminal = row.records[row.state.id === "invalid_quarantined" ? "quarantine.json" : "retirement.json"].value;
        validateReleaseReason(terminal.reason);
        incidents.push({ attempt_uuid: entry.name, status: row.state.id, reason: terminal.reason, evidence_sha256: terminal.evidence_sha256 });
        must(Buffer.byteLength(JSON.stringify(incidents)) <= 8 * 1024 * 1024, "archive incident response bound");
      }
    }
  } finally { iterator.closeSync(); }
  return incidents.sort((a, b) => a.attempt_uuid.localeCompare(b.attempt_uuid));
}

export function projectReleaseHistory(history) {
  const inventoryPath = `${history.root}-inventory.json`;
  const inventory = existsSync(inventoryPath) ? validateEnrollmentInventory(readPrivateJson(inventoryPath, { privateParent: false })) : null;
  return {
    schema: history.schema, recording_hostname: history.recording_hostname, root: history.root,
    diagnostics: history.diagnostics, warning: history.warning, inventory, archived_incidents: history.archived_incidents,
    rows: history.rows.map(row => ({
      attempt_uuid: row.attempt_uuid, plan_sha256: row.plan_sha256, row_sha256: row.row_sha256,
      plan: row.plan ? projectReleasePlan(row.plan) : null,
      status: row.state.id, disposition: row.state.disposition,
      completion: row.completion,
      activity_heads: row.activity.events.map(({ alias, sequence, sha256, state }) => ({ alias, sequence, sha256, state })),
    })),
  };
}
