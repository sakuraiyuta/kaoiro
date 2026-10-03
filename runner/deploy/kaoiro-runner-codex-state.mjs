#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { nativeIdentity } from "./codex-native.mjs";
import { verifyRelease } from "./verify-release.mjs";
import { atomicJSON, capacity, digest, hasEntry, identity, inside, inventory, must, prepareRestore, promoteRestore, sameState, snapshot, throughputEstimate, verifySnapshot } from "./codex-snapshot.mjs";
import { assertStopped, captureBinding, checkBinding, staticBinding } from "./codex-service.mjs";

const ID = /^[a-f0-9]{40}(?:-dirty)?$|^unknown$/;
const UUID = /^[a-f0-9-]{36}$/;
const TERMINAL = ["completed", "restored", "retired"];
const LEGACY = "Legacy Codex transaction requires operator recovery or retirement";
const PENDING = "Unresolved Codex recovery requires acceptance or operator recovery";
const RECEIPT = "Malformed accepted binding receipt";
const LINEAGE = "Invalid accepted Codex recovery lineage";
const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const canon = (value) => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
function privateDir(path) {
  if (!hasEntry(path)) mkdirSync(path, { mode: 0o700 });
  identity(path);
}
function readJSON(path) {
  const st = lstatSync(path);
  must(st.isFile() && st.uid === process.getuid() && !(st.mode & 0o077) && st.nlink === 1, "Invalid private state record");
  const record = JSON.parse(readFileSync(path, "utf8"));
  must(record.schema === 1, "Unsupported state record schema");
  return record;
}
function paths(root) {
  const base = join(root, "codex-state");
  return { base, transactions: join(base, "transactions"), backups: join(base, "backups") };
}
function staticShape(b, live) {
  const ints = (o, ...keys) => keys.every((key) => Number.isSafeInteger(o[key]));
  const env = (m) => !!m && typeof m === "object" && !Array.isArray(m) && Object.entries(m).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string");
  const keys = ["home", "unit", "config", "sourceHash", "configIdentity", "manager", "effective", "unitSources", "execStart"];
  return exact(b, live ? [...keys, "live"] : keys) &&
    exact(b.home, ["path", "dev", "ino", "mode"]) && typeof b.home.path === "string" && resolve(b.home.path) === b.home.path && ints(b.home, "dev", "ino", "mode") &&
    typeof b.unit === "string" && /^[A-Za-z0-9_.@-]+\.service$/.test(b.unit) && typeof b.config === "string" && b.config.startsWith("/") &&
    (b.sourceHash === null ? b.configIdentity === null : sha(b.sourceHash) && exact(b.configIdentity, ["dev", "ino"]) && ints(b.configIdentity, "dev", "ino")) &&
    env(b.manager) && env(b.effective) &&
    Array.isArray(b.unitSources) && b.unitSources.every((s) => exact(s, ["path", "sha256"]) && typeof s.path === "string" && s.path.startsWith("/") && sha(s.sha256)) &&
    typeof b.execStart === "string" &&
    (!live || (exact(b.live, ["pid", "start"]) && Number.isSafeInteger(b.live.pid) && b.live.pid > 0 && typeof b.live.start === "string"));
}
function validateReceipt(record) {
  const a = record.acceptance;
  must(a && typeof a === "object" && !Array.isArray(a), RECEIPT);
  must(a.version === undefined || a.version === 1, "Unsupported transaction binding receipt version");
  must(exact(a, ["version", "evidenceHash", "accepted", "binding"]) && sha(a.evidenceHash) && typeof a.accepted === "string" && !Number.isNaN(Date.parse(a.accepted)) && staticShape(a.binding, false) && Number.isSafeInteger(record.sequence) && record.sequence > 0, RECEIPT);
  const own = { ...record.binding };
  delete own.live;
  const expected = record.mode === "restore" ? { ...own, home: { ...own.home, dev: a.binding.home.dev, ino: a.binding.home.ino } } : own;
  must(canon(expected) === canon(a.binding), RECEIPT);
}
// A transaction without the discriminator is legacy; one with it must be fully valid.
function validateTransactionState(record) {
  const a = record.acceptance;
  if (!Object.hasOwn(record, "bindingReceiptVersion")) {
    must(a === undefined || (!!a && typeof a === "object" && !("version" in a) && !("binding" in a)), RECEIPT);
    return;
  }
  must(record.bindingReceiptVersion === 1, "Unsupported transaction binding receipt version");
  must(staticShape(record.binding, true) && (record.mode === "forward" || UUID.test(record.backupUUID)), "Malformed state record binding");
  const terminal = TERMINAL.includes(record.phase);
  if (a !== undefined || record.sequence !== undefined) {
    must(terminal && a !== undefined, RECEIPT);
    validateReceipt(record);
  } else must(!terminal || (record.mode === "forward" && record.phase !== "completed"), RECEIPT);
  must(record.mode === "forward" || !terminal || record.phase === "restored", RECEIPT);
}
function validateRecord(record, root, kind, name) {
  const native = (value) => value && typeof value.id === "string" && ID.test(value.id) && sha(value.sha256) && typeof value.path === "string" && !value.path.startsWith("/") && !value.path.split("/").includes("..");
  const binding = record.binding;
  must(binding && typeof binding.home?.path === "string" && binding.home.path.startsWith("/") && Number.isSafeInteger(binding.home.dev) && Number.isSafeInteger(binding.home.ino) && typeof binding.unit === "string" && /^[A-Za-z0-9_.@-]+\.service$/.test(binding.unit), "Malformed state record binding");
  must(typeof record.uuid === "string" && UUID.test(record.uuid) && name === `${record.uuid}.json` && native(record.source) && native(record.target) && typeof record.tool === "string" && ID.test(record.tool) && typeof record.snapshot === "string" && record.snapshot.startsWith("/") && Number.isSafeInteger(record.order) && record.order > 0, "Malformed Codex state reference");
  if (kind === "backups") {
    must(typeof record.retired === "boolean" && typeof record.restored === "boolean" && sha(record.manifestHash), "Malformed backup retention state");
  } else {
    const phases = ["prepared", "stopped", "snapshot-verified", "switch-authorized", "start-attempted", "awaiting-acceptance", "completed", "restore-prepared", "code-recovery-prepared", "restore-intent", "quarantine-intent", "quarantined", "promote-intent", "state-restored", "restored", "retired"];
    must(record.root === root && ["forward", "restore", "code-recovery"].includes(record.mode) && typeof record.phase === "string" && (phases.includes(record.phase) || /^credential-(?:intent|moved):(?:auth\.json|\.credentials\.json|secrets|mcp-oauth-locks)$/.test(record.phase)), "Malformed state transaction phase");
    validateTransactionState(record);
  }
}
function records(root, kind) {
  const p = paths(root);
  if (!hasEntry(p.base)) return [];
  identity(p.base);
  if (!hasEntry(p[kind])) return [];
  identity(p[kind]);
  return readdirSync(p[kind]).filter((name) => !name.includes(".tmp-") && !name.includes(".damaged-")).map((name) => {
    must(/^[a-zA-Z0-9-]+\.json$/.test(name), "Unknown state record filename");
    const record = readJSON(join(p[kind], name));
    validateRecord(record, root, kind, name);
    return record;
  });
}
function init(root) { const p = paths(root); for (const key of ["base", "transactions", "backups"]) privateDir(p[key]); return p; }
function currentRelease(root) {
  const target = readlinkSync(join(root, "current"));
  must(/^releases\/[^/]+$/.test(target) && ID.test(target.slice(9)), "Invalid current release link");
  return target.slice(9);
}
async function releaseIdentity(root, id, strict = false) {
  must(ID.test(id), "Invalid release identity");
  const tree = join(root, "releases", id);
  const verified = verifyRelease(tree, { requireManifest: true, requireDeployManifest: strict, hash: true });
  must(verified.identity === id, "Release directory identity mismatch");
  return { id, ...await nativeIdentity(tree) };
}
function liveOwner(owner) {
  const pid = Number(owner);
  must(Number.isSafeInteger(pid) && pid > 1, "Missing updater PID");
  let ancestor = process.ppid;
  while (ancestor > 1 && ancestor !== pid) {
    const row = readFileSync(`/proc/${ancestor}/stat`, "utf8");
    ancestor = Number(row.slice(row.lastIndexOf(")") + 2).split(" ")[1]);
  }
  must(ancestor === pid, "Updater PID is not an ancestor");
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return { pid, start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] };
}
function lockOwner(root, tx) {
  const record = readJSON(join(root, ".lock.update", "codex-owner.json"));
  must(record.uuid === tx.uuid && JSON.stringify(record.owner) === JSON.stringify(tx.owner), "State transaction does not own the update lock");
  const stat = readFileSync(`/proc/${tx.owner.pid}/stat`, "utf8");
  must(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === tx.owner.start, "State transaction owner is gone");
}
function save(root, tx) { atomicJSON(join(paths(root).transactions, `${tx.uuid}.json`), tx); }
function transaction(root, uuid) {
  must(/^[a-f0-9-]{36}$/.test(uuid), "Invalid transaction UUID");
  const tx = readJSON(join(paths(root).transactions, `${uuid}.json`));
  validateRecord(tx, root, "transactions", `${uuid}.json`);
  must(tx.root === root && tx.uuid === uuid, "Transaction belongs to another installation");
  return tx;
}
function reference(root, tx) {
  const ref = readJSON(join(paths(root).backups, `${tx.uuid}.json`));
  validateRecord(ref, root, "backups", `${tx.uuid}.json`);
  return ref;
}
function verifiedReference(root, tx) {
  const ref = reference(root, tx);
  must(ref.snapshot === tx.snapshot && JSON.stringify(ref.source) === JSON.stringify(tx.source) && JSON.stringify(ref.target) === JSON.stringify(tx.target) && ref.tool === tx.tool && JSON.stringify(ref.binding) === JSON.stringify(tx.binding), "Backup reference differs from its transaction");
  const manifest = verifySnapshot(ref.snapshot, ref.manifestHash);
  must(manifest.uuid === tx.uuid && JSON.stringify(manifest.sourceRelease) === JSON.stringify(tx.source) && JSON.stringify(manifest.targetRelease) === JSON.stringify(tx.target) && JSON.stringify(manifest.binding) === JSON.stringify(tx.binding), "Snapshot release/home binding differs from its transaction");
  return { ref, manifest };
}
function activeReferences(root) { return records(root, "backups").filter((r) => !r.retired); }
const isLegacy = (tx) => !Object.hasOwn(tx, "bindingReceiptVersion");
const requireModern = (tx) => must(!isLegacy(tx), LEGACY);
function unresolved(root) { return records(root, "transactions").filter((tx) => !TERMINAL.includes(tx.phase)); }
function ownPending(root, tx) {
  const own = new Set([tx.uuid, ...(tx.mode === "forward" ? [] : [tx.backupUUID])]);
  must(unresolved(root).every((other) => own.has(other.uuid)), PENDING);
}
function acceptedEvents(root) {
  const events = records(root, "transactions").filter((tx) => tx.acceptance !== undefined);
  must(events.every((e) => Number.isSafeInteger(e.sequence) && e.sequence > 0), RECEIPT);
  must(new Set(events.map((e) => e.sequence)).size === events.length, "Ambiguous accepted Codex lineage sequence");
  return events.sort((x, y) => x.sequence - y.sequence);
}
// Metadata only: the snapshot and releases of a retired original may be gone.
function recoveryLineage(root, rec, settled) {
  must(rec.mode !== "forward" && UUID.test(rec.backupUUID), LINEAGE);
  const original = transaction(root, rec.backupUUID);
  const ref = reference(root, original);
  must(!isLegacy(original) && original.mode === "forward" && original.order < rec.order, LINEAGE);
  must(ref.snapshot === original.snapshot && JSON.stringify(ref.source) === JSON.stringify(original.source) && JSON.stringify(ref.target) === JSON.stringify(original.target) && ref.tool === original.tool && canon(ref.binding) === canon(original.binding), LINEAGE);
  must(rec.snapshot === original.snapshot && rec.target.id === original.source.id && rec.target.sha256 === original.source.sha256 && [original.source.id, original.target.id].includes(rec.source.id), LINEAGE);
  if (settled) must(ref.restored === true && ["restored", "retired"].includes(original.phase), LINEAGE);
  else {
    const phases = rec.mode === "code-recovery" ? ["snapshot-verified", "switch-authorized"] : ["snapshot-verified", "switch-authorized", "start-attempted", "awaiting-acceptance", "completed"];
    must(!ref.retired && [...phases, "restored"].includes(original.phase), LINEAGE);
    must(!records(root, "transactions").some((r) => r.uuid !== rec.uuid && r.backupUUID === rec.backupUUID && r.acceptance !== undefined), LINEAGE);
  }
  return { original, ref };
}
// The restored home identity comes from the latest accepted transaction
// for the home, never from a per-home file.
function acceptedHome(root, old, current) {
  const latest = acceptedEvents(root).filter((e) => e.binding.home.path === old.binding.home.path).at(-1);
  if (!latest || latest.order < old.order) return old.binding;
  requireModern(latest);
  must(latest.target.id === current.id && latest.target.sha256 === current.sha256, "Latest accepted Codex lineage target mismatch");
  must(latest.binding.unit === old.binding.unit, "Latest accepted Codex lineage unit mismatch");
  if (latest.mode !== "forward") recoveryLineage(root, latest, true);
  const { dev, ino } = latest.acceptance.binding.home;
  return { ...old.binding, home: { ...old.binding.home, dev, ino } };
}
export async function guard(root, target, uuid, preflight = false) {
  if (!hasEntry(join(root, "current"))) {
    must(!uuid, "State transaction requires an existing release");
    await releaseIdentity(root, target);
    return;
  }
  const source = await releaseIdentity(root, currentRelease(root));
  const candidate = await releaseIdentity(root, target);
  const refs = activeReferences(root);
  if (!uuid) {
    must(!unresolved(root).length, "Unresolved Codex transaction requires recovery");
    must(refs.length === 0, "Retained Codex state requires a state-aware update/restore");
    must(source.sha256 === candidate.sha256, "Codex native pin differs: use state-aware backup/restore");
    return;
  }
  const tx = transaction(root, uuid);
  requireModern(tx);
  ownPending(root, tx);
  lockOwner(root, tx);
  must(tx.target.id === target && tx.source.id === source.id && tx.source.sha256 === source.sha256 && tx.target.sha256 === candidate.sha256, "Transaction release binding mismatch");
  checkBinding(root, tx.service, tx.binding, tx.mode === "restore");
  if (preflight) return;
  assertStopped(tx.service, tx.binding.home.path);
  const { ref, manifest } = verifiedReference(root, tx.mode !== "forward" ? transaction(root, tx.backupUUID) : tx);
  if (tx.mode === "code-recovery") assertNeverStarted(root, tx);
  must(tx.phase === (tx.mode === "restore" ? "state-restored" : tx.mode === "code-recovery" ? "code-recovery-prepared" : "snapshot-verified"), "State transaction is not ready for switching");
  must(sameState(inventory(tx.binding.home.path, true), manifest.entries), "Stopped state differs from verified snapshot");
  tx.phase = "switch-authorized";
  save(root, tx);
}
async function prepare(root, target, home, destination, service, tool, owner) {
  must(process.platform === "linux", "State-aware operation requires Linux");
  must(hasEntry(join(root, ".lock.update")), "Update lock is required");
  must(!unresolved(root).length, "Recover or accept the previous Codex state transaction first");
  for (const ref of activeReferences(root)) requireModern(transaction(root, ref.uuid));
  const source = await releaseIdentity(root, currentRelease(root));
  const candidate = await releaseIdentity(root, target, true);
  await releaseIdentity(root, tool, true);
  const binding = captureBinding(root, service, home);
  must(!hasEntry(destination) && resolve(destination) === destination && realpathSync(dirname(destination)) === dirname(destination), "Backup destination must be new and canonical");
  identity(dirname(destination));
  must(!inside(home, destination) && !inside(destination, home) && !inside(join(root, "releases"), destination) && !inside(destination, root), "Backup destination overlaps protected state/releases");
  const entries = inventory(home);
  const estimate = { backup: capacity(dirname(destination), entries, true), restore: capacity(dirname(home), entries), throughput: throughputEstimate(dirname(destination), entries) };
  if (entries.some((e) => e.path.endsWith(".sqlite"))) await import("node:sqlite");
  const p = init(root);
  const uuid = randomUUID();
  const tx = { schema: 1, bindingReceiptVersion: 1, uuid, root, mode: "forward", order: Math.max(0, ...records(root, "transactions").map((r) => r.order || 0)) + 1, owner: liveOwner(owner), source, target: candidate, tool, binding, service, snapshot: destination, staging: join(dirname(destination), `.staging.codex-${uuid}`), estimate, created: new Date().toISOString(), phase: "prepared" };
  atomicJSON(join(root, ".lock.update", "codex-owner.json"), { schema: 1, uuid, owner: tx.owner });
  atomicJSON(join(p.transactions, `${uuid}.json`), tx);
  return uuid;
}
async function takeSnapshot(root, uuid) {
  const tx = transaction(root, uuid);
  requireModern(tx);
  lockOwner(root, tx);
  must(tx.phase === "prepared", "Transaction is not prepared");
  checkBinding(root, tx.service, tx.binding);
  assertStopped(tx.service, tx.binding.home.path);
  tx.phase = "stopped"; save(root, tx);
  const result = await snapshot(tx.binding.home.path, tx.snapshot, { uuid, staging: tx.staging, sourceRelease: tx.source, targetRelease: tx.target, binding: tx.binding, created: new Date().toISOString() });
  atomicJSON(join(paths(root).backups, `${uuid}.json`), { schema: 1, uuid, snapshot: tx.snapshot, manifestHash: result.sha256, source: tx.source, target: tx.target, tool: tx.tool, binding: tx.binding, order: tx.order, created: tx.created, retired: false, restored: false });
  tx.phase = "snapshot-verified"; save(root, tx);
}
async function beforeStart(root, uuid) {
  const tx = transaction(root, uuid);
  requireModern(tx);
  ownPending(root, tx);
  lockOwner(root, tx);
  if (tx.mode === "code-recovery") assertNeverStarted(root, tx);
  must(tx.phase === "switch-authorized" && currentRelease(root) === tx.target.id, "Switch did not reach the recorded target");
  const current = await releaseIdentity(root, tx.target.id);
  must(current.sha256 === tx.target.sha256, "Target native changed after switch");
  checkBinding(root, tx.service, tx.binding, tx.mode === "restore");
  assertStopped(tx.service, tx.binding.home.path);
  const { ref, manifest } = verifiedReference(root, tx.mode !== "forward" ? transaction(root, tx.backupUUID) : tx);
  must(sameState(inventory(tx.binding.home.path, true), manifest.entries), "Stopped state changed before startup");
  tx.phase = "start-attempted"; save(root, tx);
}
function assertNeverStarted(root, tx) {
  const original = transaction(root, tx.backupUUID);
  must(original.mode === "forward" && ["snapshot-verified", "switch-authorized"].includes(original.phase), "Cannot prove candidate never started");
  must(tx.target.id === original.source.id && tx.target.sha256 === original.source.sha256, "Code recovery must return to original source");
}
async function prepareRecovery(root, uuid, owner) {
  const original = transaction(root, uuid);
  requireModern(original);
  lockOwner(root, original);
  const neverStarted = original.mode === "forward" && ["snapshot-verified", "switch-authorized"].includes(original.phase);
  return prepareRollback(root, original.snapshot, original.binding.home.path, original.service, original.tool, owner, neverStarted ? original.uuid : undefined);
}
async function prepareRollback(root, snapshotPath, home, service, tool, owner, neverStartedUUID) {
  must(unresolved(root).every((tx) => tx.mode === "forward" && tx.snapshot === snapshotPath), PENDING);
  const refs = activeReferences(root);
  const selected = refs.find((r) => r.snapshot === snapshotPath && !r.restored);
  must(selected, "No retained reference matches this snapshot");
  const old = transaction(root, selected.uuid);
  requireModern(old);
  // Defence in depth: only takeSnapshot writes backup references, always for a
  // forward, so this fails only for a forged reference and transaction pair.
  must(old.mode === "forward", LINEAGE);
  const candidates = refs.filter((r) => !r.restored && r.binding.home.path === home).sort((a, b) => a.order - b.order);
  must(candidates.at(-1)?.uuid === selected.uuid, `Non-latest restore refused; intervening transactions: ${candidates.filter((r) => r.order > selected.order).map((r) => r.uuid).join(", ")}`);
  const { manifest: original } = verifiedReference(root, old);
  must(original.source.path === home && old.binding.home.path === home, "Restore home binding mismatch");
  const now = currentRelease(root);
  must([old.source.id, old.target.id].includes(now), "Restore would skip release/state lineage");
  const binding = staticBinding(root, service, home);
  await releaseIdentity(root, tool, true);
  const source = await releaseIdentity(root, now);
  checkBinding(root, service, acceptedHome(root, old, source));
  // A running restore must also prove the live environment, not just config.
  try { assertStopped(service, home); } catch { captureBinding(root, service, home); }
  const target = await releaseIdentity(root, old.source.id);
  must(target.sha256 === old.source.sha256, "Backup source native changed");
  capacity(dirname(home), original.entries);
  const uuid = randomUUID();
  const tx = { schema: 1, bindingReceiptVersion: 1, uuid, root, mode: neverStartedUUID ? "code-recovery" : "restore", order: Math.max(0, ...records(root, "transactions").map((r) => r.order || 0)) + 1, owner: liveOwner(owner), source, target, tool, binding: { ...binding, live: old.binding.live }, service, backupUUID: old.uuid, snapshot: snapshotPath, staging: join(dirname(home), `.restore.codex-${uuid}`), quarantine: join(dirname(home), `.failed.codex-${uuid}`), phase: neverStartedUUID ? "code-recovery-prepared" : "restore-prepared", created: new Date().toISOString() };
  atomicJSON(join(root, ".lock.update", "codex-owner.json"), { schema: 1, uuid, owner: tx.owner });
  save(root, tx);
  return uuid;
}
function restore(root, uuid) {
  const tx = transaction(root, uuid);
  requireModern(tx);
  lockOwner(root, tx);
  if (tx.mode === "code-recovery") return;
  must(tx.mode === "restore" && tx.phase === "restore-prepared", "Restore transaction is not prepared");
  checkBinding(root, tx.service, tx.binding);
  assertStopped(tx.service, tx.binding.home.path);
  const { ref } = verifiedReference(root, transaction(root, tx.backupUUID));
  prepareRestore(ref.snapshot, ref.manifestHash, tx.binding.home.path, tx.staging);
  tx.phase = "restore-intent"; save(root, tx);
  promoteRestore(tx.binding.home.path, tx.staging, tx.quarantine, (phase) => { tx.phase = phase; save(root, tx); });
}
function protectedReleases(root) {
  const ids = new Set();
  for (const ref of activeReferences(root)) {
    must(ID.test(ref.source.id) && ID.test(ref.tool), "Invalid protected release record");
    ids.add(ref.source.id); ids.add(ref.tool);
  }
  for (const tx of records(root, "transactions")) {
    if (!["completed", "restored", "retired"].includes(tx.phase)) { ids.add(tx.source.id); ids.add(tx.tool); }
  }
  return [...ids].join("\n");
}
async function accept(root, uuid, evidenceFile) {
  must(hasEntry(join(root, ".lock.update")) && hasEntry(join(root, ".lock.links")), "Acceptance requires update and links locks");
  const tx = transaction(root, uuid);
  requireModern(tx);
  must(tx.phase === "awaiting-acceptance", "Transaction has not reached startup checks");
  const proof = async () => {
    must(currentRelease(root) === tx.target.id, "Acceptance target is not current");
    const native = await releaseIdentity(root, tx.target.id);
    must(native.sha256 === tx.target.sha256, "Acceptance native mismatch");
    const captured = captureBinding(root, tx.service, tx.binding.home.path);
    checkBinding(root, tx.service, tx.binding, tx.mode === "restore");
    const evidence = readJSON(evidenceFile);
    must(evidence.uuid === uuid && evidence.nativeHash === native.sha256 && evidence.codexStart === true && (evidence.history === true || evidence.explicitNewSession === true), "Acceptance requires actual Codex start and history or explicit new-session evidence");
    return { captured, evidenceHash: digest(readFileSync(evidenceFile)) };
  };
  const first = await proof();
  const binding = { ...first.captured };
  delete binding.live;
  // checkBinding in proof() established live static binding == tx.binding
  // (a restore may differ in home dev/ino), the relation validateReceipt
  // enforces, so done is not re-validated: a persisted invalid receipt would
  // make every records() scan refuse.
  const done = { ...tx, acceptance: { version: 1, evidenceHash: first.evidenceHash, accepted: new Date().toISOString(), binding }, sequence: Math.max(0, ...records(root, "transactions").map((r) => r.sequence || 0)) + 1, phase: tx.mode !== "forward" ? "restored" : "completed" };
  // Settlement comes first so a failed write leaves this transaction
  // awaiting acceptance, and a rerun of accept finishes it.
  if (tx.mode !== "forward") {
    const { original, ref } = recoveryLineage(root, tx, false);
    if (!ref.restored) { ref.restored = true; atomicJSON(join(paths(root).backups, `${ref.uuid}.json`), ref); }
    if (original.phase !== "restored") { original.phase = "restored"; save(root, original); }
  }
  const last = await proof();
  must(canon(last.captured) === canon(first.captured) && last.evidenceHash === first.evidenceHash, "Acceptance state changed during settlement");
  save(root, done);
}
async function retire(root, uuid, evidenceFile) {
  must(hasEntry(join(root, ".lock.update")) && hasEntry(join(root, ".lock.links")), "Retirement requires both locks");
  const tx = transaction(root, uuid), ref = reference(root, tx);
  must(["completed", "restored"].includes(tx.phase), "Cannot retire an incomplete transaction");
  await releaseIdentity(root, currentRelease(root));
  must(!records(root, "transactions").some((r) => r.backupUUID === uuid && !["restored", "retired"].includes(r.phase)), "Recovery still depends on this snapshot");
  if (!isLegacy(tx) && tx.phase === "restored") {
    const recoveries = records(root, "transactions").filter((r) => r.backupUUID === uuid && r.acceptance !== undefined);
    must(recoveries.length === 1, LINEAGE);
    recoveryLineage(root, recoveries[0], true);
  }
  const evidence = readJSON(evidenceFile);
  must(evidence.uuid === uuid && evidence.gate6 === true && evidence.productionCodexStart === true && (evidence.productionHistory === true || evidence.explicitNewSession === true) && evidence.abandonRollback === true, "Explicit accepted migration and rollback-retirement evidence is required");
  if (!ref.retired) {
    verifySnapshot(ref.snapshot, ref.manifestHash);
    ref.retired = true; ref.retirementEvidence = digest(readFileSync(evidenceFile));
    atomicJSON(join(paths(root).backups, `${uuid}.json`), ref);
  }
  if (hasEntry(ref.snapshot)) {
    verifySnapshot(ref.snapshot, ref.manifestHash);
    rmSync(ref.snapshot, { recursive: true });
  }
  tx.phase = "retired"; save(root, tx);
  console.log(JSON.stringify({ retired: uuid, removedSnapshot: ref.snapshot, released: [ref.source.id, ref.tool] }));
}
async function main(argv) {
  const [action, rootArg, ...args] = argv;
  const root = realpathSync(rootArg);
  if (action === "guard" || action === "preflight") await guard(root, args[0], args[1] || undefined, action === "preflight");
  else if (action === "prepare") console.log(await prepare(root, ...args));
  else if (action === "snapshot") await takeSnapshot(root, args[0]);
  else if (action === "before-start") await beforeStart(root, args[0]);
  else if (action === "started") { const tx = transaction(root, args[0]); requireModern(tx); lockOwner(root, tx); must(tx.phase === "start-attempted", "Invalid startup phase"); tx.phase = "awaiting-acceptance"; save(root, tx); }
  else if (action === "prepare-recovery") console.log(await prepareRecovery(root, ...args));
  else if (action === "summary") { const { uuid, mode, phase } = transaction(root, args[0]); console.log(JSON.stringify({ uuid, mode, phase })); }
  else if (action === "prepare-restore") console.log(await prepareRollback(root, ...args));
  else if (action === "restore") restore(root, args[0]);
  else if (action === "inspect") console.log(JSON.stringify(transaction(root, args[0]), null, 2));
  else if (action === "target") console.log(transaction(root, args[0]).target.id);
  else if (action === "protected") console.log(protectedReleases(root));
  else if (action === "retire") await retire(root, ...args);
  else if (action === "accept") await accept(root, ...args);
  else if (action === "classify") console.log(JSON.stringify(inventory(root), null, 2));
  else throw new Error("Unknown Codex state action");
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const argv = process.argv.slice(2);
  const locked = [];
  try {
    if (["accept", "retire"].includes(argv[0])) {
      for (const name of [".lock.update", ".lock.links"]) {
        const path = join(realpathSync(argv[1]), name);
        mkdirSync(path, { mode: 0o700 }); locked.push(path);
      }
    }
    await main(argv);
  } catch (error) {
    console.error(`codex-state: ${error.message}`); process.exitCode = 78;
  } finally {
    for (const path of locked.reverse()) rmdirSync(path);
  }
}
