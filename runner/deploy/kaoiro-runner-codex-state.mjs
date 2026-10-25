#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execChildSync } from "./child-process-environment.mjs";
import { nativeIdentity } from "./codex-native.mjs";
import { verifyRelease } from "./verify-release.mjs";
import { CREDENTIALS, atomicJSON, capacity, digest, durableRename, hasEntry, identity, inside, inventory, must, prepareRestore, sameState, snapshot, stateEntries, syncDirectory, verifySnapshot } from "./codex-snapshot.mjs";
import { assertStopped, captureBinding, checkBinding, homePath, requireCgroupV2, runnerActivity, staticBinding, systemctl } from "./codex-service.mjs";
import { PHASES, classify, render, rowLines } from "./codex-state-recovery.mjs";

export const CODEX_STATE_SCHEMA = 2;
const ID = /^(?:[a-f0-9]{40}(?:-dirty)?|unknown)$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const TERMINAL = ["completed", "failed", "restored"];
const RETENTION = ["planned", "retained", "prune-intent", "retired"];
const OLD_TERMINAL = ["completed", "restored", "retired"];
const deploy = dirname(fileURLToPath(import.meta.url));
const recordDir = root => join(root, "codex-state/v2/records");
const recordPath = (root, uuid) => join(recordDir(root), `${uuid}.json`);
const binding = tx => ({ home: tx.home, unit: tx.service });
const terminal = tx => TERMINAL.includes(tx.phase);
const replacing = tx => ["restore-prepared", "replace-intent"].includes(tx.phase);
const read = path => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`Unreadable state record: ${path}`); }
};
const nativeShape = n => n && ID.test(n.id) && HASH.test(n.sha256);

function privateJSON(path) {
  const st = lstatSync(path);
  must(st.isFile() && st.uid === process.getuid() && !(st.mode & 0o077) && st.nlink === 1, `Invalid private state record: ${path}`);
  return read(path);
}
function directory(path) { identity(path); return path; }
function filenames(path) {
  if (!hasEntry(path)) return [];
  directory(path);
  return readdirSync(path).filter(name => !name.includes(".tmp-"));
}
function cutover(root) {
  const old = join(root, "codex-state");
  if (!hasEntry(old)) return;
  directory(old);
  for (const kind of ["transactions", "backups"]) for (const name of filenames(join(old, kind))) {
    const path = join(old, kind, name);
    let ok = false;
    try { const tx = privateJSON(path); ok = kind === "transactions" ? OLD_TERMINAL.includes(tx.phase) : tx.retired === true; } catch { /* Unclassifiable old records need the previous tool. */ }
    must(ok, `Resolve old Codex state records with the previous tool release: ${path}`);
  }
}
function projection(root, name) {
  must(UUID.test(name.slice(0, -5)) && name.endsWith(".json"), `Unknown state record filename: ${name}`);
  const tx = privateJSON(join(recordDir(root), name));
  must(tx.schema === CODEX_STATE_SCHEMA && tx.uuid === name.slice(0, -5) && tx.root === root, `Invalid state identity: ${name}`);
  must(PHASES.includes(tx.phase) && RETENTION.includes(tx.snapshot?.status), `Unclassifiable phase/retention: ${name}`);
  if (["retained", "prune-intent"].includes(tx.snapshot.status) || !terminal(tx)) must(ID.test(tx.source?.id), `Invalid protected source: ${name}`);
  if (!terminal(tx)) {
    must(ID.test(tx.tool), `Invalid protected tool: ${name}`);
    must(ID.test((replacing(tx) ? tx.replacement?.from : tx.target)?.id), `Invalid protected operation release: ${name}`);
  }
  return tx;
}
function records(root) { cutover(root); return filenames(recordDir(root)).map(name => projection(root, name)); }
function selected(root, uuid) {
  must(UUID.test(uuid), "Invalid transaction UUID");
  cutover(root);
  const tx = projection(root, `${uuid}.json`);
  must(nativeShape(tx.source) && nativeShape(tx.target) && ID.test(tx.tool), "Malformed selected release identities");
  must(typeof tx.service === "string" && /^[A-Za-z0-9_.@-]+\.service$/.test(tx.service), "Malformed selected service");
  must(typeof tx.home === "string" && resolve(tx.home) === tx.home, "Malformed selected home");
  const s = tx.snapshot;
  must(typeof s.path === "string" && resolve(s.path) === s.path, "Malformed snapshot path");
  must(s.staging === join(dirname(s.path), `.staging.codex-${uuid}`), "Snapshot staging path is not its own");
  disjoint(root, tx.home, s.path);
  if (["retained", "prune-intent"].includes(s.status)) must(HASH.test(s.manifestHash), "Malformed snapshot manifest hash");
  must(Array.isArray(tx.asides), "Malformed aside list");
  const attempts = new Set();
  for (const entry of tx.asides) {
    must(UUID.test(entry.attempt) && entry.aside === join(dirname(tx.home), `.failed.codex-${entry.attempt}`) && !attempts.has(entry.attempt), "Malformed aside entry");
    attempts.add(entry.attempt);
  }
  if (replacing(tx)) {
    const r = tx.replacement;
    must(r && UUID.test(r.attempt) && nativeShape(r.from) && PHASES.includes(r.priorPhase) && !["restore-prepared", "replace-intent"].includes(r.priorPhase), "Malformed replacement identity");
    must(r.staging === join(dirname(tx.home), `.restore.codex-${r.attempt}`) && r.aside === join(dirname(tx.home), `.failed.codex-${r.attempt}`), "Malformed replacement paths");
    must(tx.asides.some(e => e.attempt === r.attempt && e.aside === r.aside), "Replacement aside is not recorded");
    must(typeof r.promoted === "boolean" && typeof r.startRequested === "boolean", "Malformed replacement checkpoints");
    if (tx.phase === "replace-intent") must(Array.isArray(r.credentials) && new Set(r.credentials).size === r.credentials.length && r.credentials.every(n => CREDENTIALS.includes(n)) && HASH.test(r.stateDigest), "Malformed replacement state");
  }
  if (tx.cleanup) must(typeof tx.cleanup.pending === "boolean" && Number.isSafeInteger(tx.cleanup.bytes) && tx.cleanup.bytes >= 0 && ownedStage(tx, tx.cleanup.path), "Malformed cleanup ownership");
  if (s.status === "prune-intent") must(tx.prune?.path === s.path && Number.isSafeInteger(tx.prune.dev) && Number.isSafeInteger(tx.prune.ino) && Number.isSafeInteger(tx.prune.bytes) && tx.prune.bytes >= 0, "Malformed prune ownership");
  return tx;
}
function ownedStage(tx, path) { return path === tx.snapshot.staging || tx.asides.some(e => path === join(dirname(tx.home), `.restore.codex-${e.attempt}`)); }
function disjoint(root, home, path) {
  must(!inside(home, path) && !inside(path, home) && !inside(join(root, "releases"), path) && !inside(join(root, "codex-state"), path) && !inside(path, root), "Snapshot overlaps protected state/releases");
}
function requireUpdate(root) { directory(join(root, ".lock.update")); }
function save(root, tx) {
  directory(join(root, ".lock.links"));
  for (const path of [join(root, "codex-state"), join(root, "codex-state/v2"), recordDir(root)]) {
    if (!hasEntry(path)) { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
    directory(path);
  }
  atomicJSON(recordPath(root, tx.uuid), tx);
}
async function withLock(root, name, fn) {
  const path = join(root, name);
  try { mkdirSync(path, { mode: 0o700 }); } // codex-recovery-site: G6.helper
  catch (error) { if (error.code === "EEXIST") throw new Error(`Lock held: ${path}`); throw error; } // codex-recovery-rethrow: lock-create
  try { return await fn(); } finally { rmdirSync(path); }
}
const publish = (root, tx) => withLock(root, ".lock.links", () => save(root, tx));
function exclude(root, uuid) {
  const blocking = records(root).find(tx => !terminal(tx) && tx.uuid !== uuid);
  must(!blocking, `Unresolved Codex transaction requires recovery: ${blocking?.uuid}`);
}
function current(root) {
  const link = readlinkSync(join(root, "current"));
  must(link.startsWith("releases/") && ID.test(link.slice(9)), "Invalid current release link");
  return link.slice(9);
}
async function release(root, id) {
  must(ID.test(id), "Invalid release identity");
  const tree = join(root, "releases", id);
  const v = verifyRelease(tree, { requireManifest: true, requireDeployManifest: true, hash: true });
  must(v.identity === id, "Release directory identity mismatch");
  const { sha256 } = await nativeIdentity(tree);
  return { id, sha256 };
}
function capable(root, id) {
  const text = readFileSync(join(root, "releases", id, "deploy/kaoiro-runner-codex-state.mjs"), "utf8");
  const matches = text.match(/^export const CODEX_STATE_SCHEMA = 2;\r?$/gm) || [];
  must(matches.length <= 1, "Ambiguous Codex state capability");
  return matches.length === 1;
}
function needCapability(root, id) { must(capable(root, id), "Update to an N2 release with the same native first"); }
async function checkRelease(root, expected) {
  const actual = await release(root, expected.id);
  must(actual.sha256 === expected.sha256, "Recorded native release changed");
}
function snapshotFor(tx) {
  must(tx.snapshot.status === "retained", "Snapshot is not retained");
  const m = verifySnapshot(tx.snapshot.path, tx.snapshot.manifestHash);
  must(m.uuid === tx.uuid && m.source.path === tx.home && m.home === tx.home, "Snapshot UUID/home differs from record");
  must(m.sourceRelease?.id === tx.source.id && m.sourceRelease?.sha256 === tx.source.sha256 && m.targetRelease?.id === tx.target.id && m.targetRelease?.sha256 === tx.target.sha256, "Snapshot release binding differs from record");
  return m;
}
async function prepare(root, target, home, destination, service, tool, pid) {
  requireUpdate(root); exclude(root); // codex-recovery-site: G2.prepare G7.prepare
  const source = await release(root, current(root)), candidate = await release(root, target);
  await release(root, tool); needCapability(root, source.id); needCapability(root, target);
  const b = captureBinding(root, service, home); // codex-recovery-site: G4.prepare
  requireCgroupV2();
  must(resolve(destination) === destination && realpathSync(dirname(destination)) === dirname(destination) && !hasEntry(destination), "Backup destination must be new and canonical");
  directory(dirname(destination)); disjoint(root, home, destination);
  const entries = inventory(home);
  capacity(dirname(destination), entries); capacity(dirname(home), entries);
  const uuid = randomUUID();
  const tx = { schema: CODEX_STATE_SCHEMA, uuid, root, service: b.unit, home: b.home, source, target: candidate, phase: "prepared", snapshot: { path: destination, staging: join(dirname(destination), `.staging.codex-${uuid}`), status: "planned" }, tool, updaterPid: Number(pid), created: new Date().toISOString(), asides: [] };
  await publish(root, tx); return uuid;
}
async function reconcile(root, tx) {
  if (tx.phase !== "prepared") return;
  if (hasEntry(tx.snapshot.path)) {
    const bytes = readFileSync(join(tx.snapshot.path, "manifest.json"));
    const candidate = { ...tx, snapshot: { ...tx.snapshot, manifestHash: digest(bytes), status: "retained" } };
    snapshotFor(candidate);
    syncDirectory(dirname(tx.snapshot.path));
    tx.snapshot = candidate.snapshot;
    await publish(root, tx);
  }
}
async function takeSnapshot(root, tx) {
  assertStopped(tx.service, tx.home); checkBinding(root, tx.service, binding(tx)); // codex-recovery-site: PS.snapshot-stopped PS.snapshot-binding
  must(current(root) === tx.source.id, "Pre-start source link changed");
  await checkRelease(root, tx.source);
  if (tx.phase === "prepared") {
    if (hasEntry(tx.snapshot.path)) await reconcile(root, tx);
    else {
      await cleanupStage(root, tx, tx.snapshot.staging);
      const result = await snapshot(tx.home, tx.snapshot.path, { uuid: tx.uuid, staging: tx.snapshot.staging, home: tx.home, sourceRelease: tx.source, targetRelease: tx.target });
      tx.snapshot.manifestHash = result.sha256; tx.snapshot.status = "retained";
    }
    tx.phase = "snapshot-verified"; await publish(root, tx);
  }
  must(sameState(inventory(tx.home, true), snapshotFor(tx).entries), "Stopped state differs from verified snapshot; recover and take a new snapshot");
}
export async function guard(root, target, uuid, preflight = false) {
  exclude(root, uuid); // codex-recovery-site: G2.guard G7.guard
  const candidate = await release(root, target);
  const retained = records(root).some(tx => ["retained", "prune-intent"].includes(tx.snapshot.status));
  if (!hasEntry(join(root, "current"))) {
    must(!uuid, "Transaction requires an existing release");
    must(!retained || capable(root, target), "A retained v2 snapshot forbids activating a pre-N2 tool"); return;
  }
  const now = await release(root, current(root));
  if (!uuid) {
    must(now.sha256 === candidate.sha256, "Codex native pin differs: use state-aware backup/restore");
    must(!retained || capable(root, target), "A retained v2 snapshot forbids activating a pre-N2 tool"); return;
  }
  requireUpdate(root);
  const tx = selected(root, uuid);
  await checkRelease(root, tx.source);
  must(!terminal(tx), "Historical terminal record cannot authorize a switch");
  const restoring = tx.phase === "replace-intent";
  const expected = restoring ? tx.source : tx.target;
  must(target === expected.id && candidate.sha256 === expected.sha256, "Transaction target differs");
  const from = restoring ? tx.replacement.from.id : tx.source.id;
  must([from, expected.id].includes(now.id), "Current is outside recorded operation"); // codex-recovery-site: G3.guard
  needCapability(root, target);
  checkBinding(root, tx.service, binding(tx), restoring && !hasEntry(tx.home)); // codex-recovery-site: G4.guard-entry PS.guard-nested PS.guard-nested-intent
  if (preflight) return;
  assertStopped(tx.service, tx.home);
  if (restoring) {
    must(tx.replacement.startRequested, "Restore start intent is missing");
    verifyReplacement(tx);
  } else {
    must(["snapshot-verified", "start-intent"].includes(tx.phase), "Forward is not ready for switching");
    const manifest = snapshotFor(tx);
    if (now.id === tx.source.id) must(sameState(inventory(tx.home, true), manifest.entries), "Stopped state differs from verified snapshot; recover");
    tx.phase = "start-intent"; save(root, tx);
  }
}
function stateDigest(entries) { return digest(JSON.stringify(stateEntries(entries).map(({ size, ...entry }) => entry.type === "file" ? { ...entry, size } : entry))); }
function verifyReplacement(tx) {
  const r = tx.replacement;
  if (hasEntry(tx.home) && !hasEntry(r.staging) && hasEntry(r.aside) && r.startRequested) return;
  must(!hasEntry(tx.home) && hasEntry(r.staging) && hasEntry(r.aside), "Inconsistent home/staging/aside layout; preserve objects for manual repair");
  must(stateDigest(inventory(r.staging, true)) === r.stateDigest, "Replacement state digest mismatch");
  for (const name of CREDENTIALS) {
    must(!hasEntry(join(r.aside, name)), "Credential remains in aside before promotion");
    must(hasEntry(join(r.staging, name)) === r.credentials.includes(name), "Credential location mismatch before promotion");
  }
}
async function admitRestore(root, tx, home, service, tool) {
  exclude(root, tx.uuid); // codex-recovery-site: G2.restore
  must(!replacing(tx), "Replacement is already unfinished");
  must(!["prepared", "snapshot-verified"].includes(tx.phase), "Use never-started source recovery");
  const manifest = snapshotFor(tx);
  must(home === tx.home && service.replace(/(?:\.service)?$/, ".service") === tx.service, "Restore home/service differs from selected record");
  checkBinding(root, tx.service, binding(tx)); // codex-recovery-site: G4.restore
  const from = await release(root, current(root));
  await checkRelease(root, tx.source); needCapability(root, tx.source.id); await release(root, tool);
  capacity(dirname(home), manifest.entries); requireCgroupV2();
  must(lstatSync(home).dev === lstatSync(dirname(home)).dev, "Restore home and staging must share one filesystem");
  const attempt = randomUUID(), aside = join(dirname(home), `.failed.codex-${attempt}`);
  tx.replacement = { attempt, from, priorPhase: tx.phase, staging: join(dirname(home), `.restore.codex-${attempt}`), aside, credentials: [], promoted: false, startRequested: false };
  tx.asides.push({ attempt, aside }); tx.phase = "restore-prepared"; tx.tool = tool;
  await publish(root, tx);
}
async function prepareRollback(root, path, home, service, tool) {
  requireUpdate(root);
  const choices = records(root).filter( // codex-recovery-site: G7.restore
    tx => tx.snapshot.path === path && tx.snapshot.status === "retained");
  must(choices.length === 1, "No unique retained snapshot matches selection");
  const tx = selected(root, choices[0].uuid);
  await admitRestore(root, tx, home, service, tool); return tx.uuid;
}
async function stageRestore(root, tx) {
  const r = tx.replacement;
  assertStopped(tx.service, tx.home); checkBinding(root, tx.service, binding(tx)); // codex-recovery-site: PS.stage
  must(current(root) === r.from.id, "Restore source link changed");
  await checkRelease(root, r.from); await checkRelease(root, tx.source);
  await cleanupStage(root, tx, r.staging);
  snapshotFor(tx);
  const manifest = prepareRestore(tx.snapshot.path, tx.snapshot.manifestHash, tx.home, r.staging);
  r.credentials = inventory(tx.home).filter(e => CREDENTIALS.includes(e.path)).map(e => e.path);
  r.stateDigest = stateDigest(manifest.entries);
  tx.phase = "replace-intent"; await publish(root, tx);
}
async function moveReplacement(root, tx) {
  const r = tx.replacement;
  assertStopped(tx.service, tx.home); // codex-recovery-site: PS.replace-stopped
  checkBinding(root, tx.service, binding(tx), !hasEntry(tx.home)); // codex-recovery-site: PS.replace-binding
  if (hasEntry(tx.home) && !hasEntry(r.staging) && hasEntry(r.aside) && r.startRequested) {
    must(current(root) === tx.source.id, "Published restore home requires its source release");
    return;
  }
  if (hasEntry(tx.home) && hasEntry(r.staging) && !hasEntry(r.aside) && !r.startRequested) {
    must(stateDigest(inventory(r.staging, true)) === r.stateDigest, "Replacement staging changed");
    inventory(tx.home); durableRename(tx.home, r.aside);
  }
  must(!hasEntry(tx.home) && hasEntry(r.staging) && hasEntry(r.aside), "Inconsistent home/staging/aside layout; preserve objects for manual repair");
  for (const name of CREDENTIALS) {
    const a = join(r.aside, name), s = join(r.staging, name);
    const inAside = hasEntry(a), inStage = hasEntry(s);
    if (!r.credentials.includes(name)) { must(!inAside && !inStage, "Unexpected credential during replacement"); continue; }
    must(inAside !== inStage, "Credential must exist in exactly one location");
    if (inAside) {
      const st = lstatSync(a); must(!st.isSymbolicLink() && st.uid === process.getuid() && (st.isDirectory() || (st.isFile() && st.nlink === 1)), "Invalid credential entry");
      durableRename(a, s);
    }
  }
  verifyReplacement(tx);
  syncDirectory(r.staging); syncDirectory(r.aside); syncDirectory(dirname(tx.home));
  r.startRequested = true; await publish(root, tx);
}
function promote(root, uuid) {
  const tx = selected(root, uuid);
  syncDirectory(root);
  if (tx.phase !== "replace-intent") return;
  requireUpdate(root); directory(join(root, ".lock.links"));
  must(current(root) === tx.source.id, "Source must be selected before home promotion");
  verifyReplacement(tx);
  const r = tx.replacement;
  if (!hasEntry(tx.home)) durableRename(r.staging, tx.home);
  syncDirectory(dirname(tx.home));
  r.promoted = true; save(root, tx);
}
function logicalSize(path) {
  let bytes = 0;
  const st = lstatSync(path);
  must(!st.isSymbolicLink() && st.uid === process.getuid(), "Unsafe cleanup root");
  if (st.isFile()) return st.size;
  must(st.isDirectory(), "Unsafe cleanup entry");
  for (const entry of readdirSync(path)) {
    const child = join(path, entry), info = lstatSync(child);
    bytes += info.isSymbolicLink() ? 0 : logicalSize(child);
  }
  return bytes;
}
async function cleanupStage(root, tx, path) {
  if (!hasEntry(path)) {
    if (tx.cleanup?.path === path && tx.cleanup.pending) { syncDirectory(dirname(path)); tx.cleanup.pending = false; await publish(root, tx); }
    return;
  }
  directory(path);
  tx.cleanup = { path, bytes: logicalSize(path), pending: true }; await publish(root, tx);
  try { rmSync(path, { recursive: true }); syncDirectory(dirname(path)); tx.cleanup.pending = false; await publish(root, tx); }
  catch (error) { throw new Error(`Owned staging cleanup remains pending: ${path}: ${error.message}`); }
}
async function returnSource(root, tx) {
  must(current(root) === tx.source.id, "Source link changed before recovery"); // codex-recovery-site: PS.return-link
  checkBinding(root, tx.service, binding(tx)); await checkRelease(root, tx.source); // codex-recovery-site: PS.return-binding
  if (tx.phase === "prepared") {
    try { await reconcile(root, tx); }
    catch { console.error(`codex-state: unverifiable snapshot left for explicit prune: ${tx.snapshot.path}`); for (const line of rowLines(tx, context(root), ["PRN"])) console.error(`codex-state: ${line}`); }
  }
  if (!hasEntry(tx.snapshot.path)) tx.snapshot.status = "retired";
  let cleanupError;
  try { await cleanupStage(root, tx, tx.snapshot.staging); } catch (error) { cleanupError = error; }
  await withLock(root, ".lock.links", async () => {
    const latest = selected(root, tx.uuid);
    must(["prepared", "snapshot-verified", "failed"].includes(latest.phase) && latest.source.id === tx.source.id && latest.source.sha256 === tx.source.sha256, "Source return phase changed before restart");
    tx.phase = "failed"; save(root, tx);
    const activity = runnerActivity(tx.service); // codex-recovery-site: PS.return-activity
    if (activity !== "active") systemctl(tx.service, "start");
    await postStart(root, tx, tx.source, "source");
  });
  if (cleanupError) throw cleanupError; // codex-recovery-rethrow: source-cleanup
}
async function postStart(root, tx, expected, role = "completion") {
  const completing = role === "completion";
  const latest = selected(root, tx.uuid);
  must(latest.phase === tx.phase, "Startup phase changed during service operation");
  // Cancellation may return to failed, whose original source is historical.
  const recorded = completing ? (replacing(latest) ? latest.source : latest.target) : role === "source" ? latest.source : latest.phase === "restore-prepared" ? latest.replacement.from : expected;
  must(recorded.id === expected.id && recorded.sha256 === expected.sha256, "Startup release changed during service operation");
  must(runnerActivity(tx.service) === "active", "Runner did not become active with a positive MainPID"); // codex-recovery-site: PS.post-start-active
  must(current(root) === expected.id, "Current differs from startup target");
  await checkRelease(root, expected); captureBinding(root, tx.service, tx.home); // codex-recovery-site: PS.post-start-binding
  try {
    execChildSync("codex-attest", "/bin/sh", ["-c", 'deploy_dir=$1; . "$deploy_dir/kaoiro-runner-common.sh"; kaoiro_read_machine_identity "$2" "$3" "$4"', "codex-state-attestation", deploy, join(root, "current"), expected.id.replace(/-dirty$/, ""), expected.id.endsWith("-dirty") || expected.id === "unknown" ? "yes" : "no"], { env: { ...process.env, KAOIRO_NODE: process.execPath }, stdio: ["ignore", "pipe", "pipe"] });
  } catch { throw new Error("Runner artifact attestation failed after start"); }
  if (completing) { latest.phase = replacing(latest) ? "restored" : "completed"; await publish(root, latest); }
}
function stopRunner(service) {
  try { systemctl(service, "stop"); }
  catch (error) {
    if (Number.isInteger(error.serviceStatus) && error.serviceStatus > 0 && error.serviceStatus < 126) error.exitCode = error.serviceStatus;
    throw error; // codex-recovery-rethrow: stop-status
  }
}
async function run(root, uuid, mode, allowDirty = "no") {
  must(["resume", "recover"].includes(mode), "Unknown Codex operation mode");
  must(["yes", "no"].includes(allowDirty), "Invalid development activation option");
  requireUpdate(root); exclude(root, uuid); // codex-recovery-site: G2.run G7.run
  let tx = selected(root, uuid);
  const returningSource = mode === "recover" && ["prepared", "snapshot-verified", "failed"].includes(tx.phase);
  const beganActive = runnerActivity(tx.service) === "active"; // codex-recovery-site: G5.began
  const tool = readFileSync(join(deploy, "../VERSION"), "utf8").trim();
  must(tx.tool === tool, "Use the recorded physical updater tool"); // codex-recovery-site: G1.run
  try {
    const admissible = replacing(tx) ? [tx.replacement.from.id, tx.source.id] : tx.phase === "start-intent" ? [tx.source.id, tx.target.id] : [tx.source.id];
    if (!terminal(tx) || returningSource) must(admissible.includes(current(root)), "Current is outside recorded operation"); // codex-recovery-site: G3.run
    checkBinding(root, tx.service, binding(tx), tx.phase === "replace-intent" && !hasEntry(tx.home)); // codex-recovery-site: G4.run-pre G5.binding-run
    if (terminal(tx) && !returningSource) return;
    if (returningSource) {
      if (runnerActivity(tx.service) === "active") stopRunner(tx.service); // codex-recovery-site: G5.pre-stop
      await returnSource(root, tx); return;
    }
    if (mode === "recover" && tx.phase === "restore-prepared") {
      const r = tx.replacement;
      must(current(root) === r.from.id, "Cancellation source link changed");
      await checkRelease(root, r.from);
      await cleanupStage(root, tx, r.staging);
      tx.phase = r.priorPhase; delete tx.replacement;
      await withLock(root, ".lock.links", async () => { save(root, tx); if (runnerActivity(tx.service) !== "active") systemctl(tx.service, "start"); await postStart(root, tx, r.from, "unchanged"); }); return; // codex-recovery-site: PS.cancel-activity
    }
    if (mode === "recover" && tx.phase === "start-intent") await admitRestore(root, tx, tx.home, tx.service, tool);
    if (tx.phase === "start-intent" && current(root) === tx.target.id && runnerActivity(tx.service) === "active") { await postStart(root, tx, tx.target); return; } // codex-recovery-site: G5.target-check
    const priorPhase = tx.phase;
    if (runnerActivity(tx.service) === "active") stopRunner(tx.service); // codex-recovery-site: G5.resume-stop
    tx = selected(root, uuid);
    must(tx.phase === priorPhase, "Phase changed during stop");
    assertStopped(tx.service, tx.home); // codex-recovery-site: PS.stopped
    if (["prepared", "snapshot-verified"].includes(tx.phase)) await takeSnapshot(root, tx);
    if (tx.phase === "restore-prepared") await stageRestore(root, tx);
    if (tx.phase === "replace-intent") await moveReplacement(root, tx);
    const target = replacing(tx) ? tx.source : tx.target;
    execChildSync("codex-switch", join(deploy, "kaoiro-runner-switch.sh"), [target.id, "--install-dir", root, "--codex-transaction", uuid, ...(allowDirty === "yes" ? ["--allow-dirty"] : [])], { stdio: ["ignore", "pipe", "inherit"] });
    tx = selected(root, uuid);
    must(tx.phase === (replacing(tx) ? "replace-intent" : "start-intent"), "Startup phase changed after switch");
    assertStopped(tx.service, tx.home); checkBinding(root, tx.service, binding(tx)); // codex-recovery-site: PS.after-switch
    must(current(root) === target.id, "Switch did not reach recorded target");
    await checkRelease(root, target);
    systemctl(tx.service, "start");
    await postStart(root, tx, target);
  } catch (error) {
    tx = selected(root, uuid);
    if (tx.phase === "restore-prepared" && beganActive) {
      try {
        const from = tx.replacement.from;
        await withLock(root, ".lock.links", async () => {
          must(current(root) === from.id, "Restore source link changed before restart");
          checkBinding(root, tx.service, binding(tx)); await checkRelease(root, from);
          if (runnerActivity(tx.service) !== "active") systemctl(tx.service, "start"); // codex-recovery-site: PS.catch-restore
          await postStart(root, tx, from, "unchanged");
        });
        console.error("codex-state: unchanged source was resumed");
      } catch (recovery) { console.error(`codex-state: source recovery refused: ${recovery.message}`); }
    }
    if (["prepared", "snapshot-verified"].includes(tx.phase)) {
      try { await returnSource(root, tx); console.error("codex-state: unchanged source was resumed"); }
      catch (recovery) { console.error(`codex-state: source recovery refused: ${recovery.message}`); }
    }
    throw error; // codex-recovery-rethrow: run-failure
  }
}
async function prune(root, uuid) {
  const tx = selected(root, uuid); exclude(root, uuid); // codex-recovery-site: G7.prune G2.prune
  must(terminal(tx), "Prune requires a terminal operation");
  if (tx.cleanup?.pending) await cleanupStage(root, tx, tx.cleanup.path);
  if (tx.snapshot.status === "retired") return;
  await withLock(root, ".lock.links", () => {
    const path = tx.snapshot.path;
    disjoint(root, tx.home, path); directory(dirname(path));
    if (hasEntry(path)) {
      const st = lstatSync(path); directory(path);
      if (tx.snapshot.status === "prune-intent") must(st.dev === tx.prune.dev && st.ino === tx.prune.ino, "Snapshot root identity changed during prune");
      else { tx.prune = { path, dev: st.dev, ino: st.ino, bytes: logicalSize(path), removed: false }; tx.snapshot.status = "prune-intent"; save(root, tx); }
      rmSync(path, { recursive: true });
    }
    syncDirectory(dirname(path));
    if (tx.prune) tx.prune.removed = true;
    tx.snapshot.status = "retired"; save(root, tx);
  });
}
function protectedReleases(root) {
  const ids = new Set();
  for (const tx of records(root)) { // codex-recovery-site: G7.protected
    if (["retained", "prune-intent"].includes(tx.snapshot.status)) ids.add(tx.source.id);
    if (!terminal(tx)) { ids.add(tx.source.id); ids.add(replacing(tx) ? tx.replacement.from.id : tx.target.id); ids.add(tx.tool); }
    if (tx.cleanup?.pending) for (const line of [`pending owned staging cleanup: ${recordPath(root, tx.uuid)}`, ...rowLines(tx, context(root), ["PRN"])]) console.error(`codex-state: ${line}`);
  }
  return [...ids].join("\n");
}
const ACTIONS = ["guard", "preflight", "prepare", "prepare-restore", "run", "resume", "recover", "prune", "promote", "inspect", "inventory", "summary", "target", "protected", "classify", "next"];
const RUNS = ["run", "resume", "recover"];
const context = root => ({ root, deploy, interpreter: process.execPath });
// Read-only: takes no lock and writes nothing. Records are published by
// atomic rename and temporary names are filtered, so a paused worker's
// record is either the old or the new version.
function next(root, uuid) {
  if (uuid) { const tx = selected(root, uuid); return [`${tx.uuid} ${tx.phase}`, ...rowLines(tx, context(root)).map(line => `  ${line}`)]; }
  const lines = [];
  for (const tx of records(root)) {
    if (!terminal(tx)) lines.push(`${tx.uuid} ${tx.phase}`, ...rowLines(tx, context(root)).map(line => `  ${line}`));
    else if (tx.cleanup?.pending) lines.push(`${tx.uuid} ${tx.phase} cleanup pending`, ...rowLines(tx, context(root), ["PRN"]).map(line => `  ${line}`));
  }
  for (const name of [".lock.update", ".lock.links"]) if (hasEntry(join(root, name))) lines.push(`lock present: ${join(root, name)}`);
  return lines;
}
function nextAction(root, uuid) {
  try { console.log(next(root, uuid).join("\n")); }
  catch (error) {
    if (classify(error.message) !== "cutover") throw error; // codex-recovery-rethrow: next-read
    for (const line of [error.message, ...render("cutover")]) console.log(line);
  }
}
async function main(argv) {
  const [action, rootArg, ...args] = argv;
  must(ACTIONS.includes(action), "Unknown Codex state action");
  const root = realpathSync(rootArg);
  if (action === "guard" || action === "preflight") await guard(root, args[0], args[1] || undefined, action === "preflight");
  else if (action === "prepare") console.log(await prepare(root, ...args));
  else if (action === "prepare-restore") console.log(await prepareRollback(root, ...args));
  else if (action === "run") await run(root, args[0], args[1], args[2]);
  else if (action === "resume" || action === "recover") await withLock(root, ".lock.update", () => run(root, args[0], action, args[1]));
  else if (action === "prune") await withLock(root, ".lock.update", () => prune(root, args[0]));
  else if (action === "promote") promote(root, args[0]);
  else if (action === "protected") console.log(protectedReleases(root));
  else if (action === "inventory") console.log(JSON.stringify({ old: { transactions: filenames(join(root, "codex-state/transactions")), backups: filenames(join(root, "codex-state/backups")) }, records: filenames(recordDir(root)) }));
  else if (action === "classify") console.log(JSON.stringify(inventory(root)));
  else if (action === "next") nextAction(root, args[0]);
  else {
    const tx = selected(root, args[0]);
    if (action === "inspect") console.log(JSON.stringify(tx, null, 2));
    else if (action === "target") console.log(replacing(tx) ? tx.source.id : tx.target.id);
    else console.log(JSON.stringify({ uuid: tx.uuid, phase: tx.phase, snapshot: tx.snapshot.status }));
  }
}
// The hint is advice printed after the refusal has been decided, so a failure
// to read the record or render it only drops lines.
function report(error, [action, rootArg, ...args]) {
  const message = String(error?.message ?? error), cls = classify(message), lines = [message];
  let root, tx, held = [];
  try { root = realpathSync(rootArg); } catch { /* no record to name */ }
  const candidates = [message.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0], ["guard", "preflight"].includes(action) ? args[1] : args[0]];
  for (const uuid of candidates) {
    if (tx || !root || !UUID.test(uuid || "")) continue;
    try { tx = selected(root, uuid); } catch { /* not a record of this root */ }
  }
  if (cls === "lock" && root) try { held = next(root); } catch { /* records unreadable */ }
  try { lines.push(...render(cls, { tx, row: RUNS.includes(action), report: held, ...context(root) })); } catch { /* unrenderable record */ }
  for (const line of lines) console.error(`codex-state: ${line}`);
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { report(error, process.argv.slice(2)); process.exitCode = error.exitCode || 78; }
}
