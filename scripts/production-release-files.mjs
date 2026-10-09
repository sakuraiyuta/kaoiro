import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RELEASE_UUID, RECORD_KINDS, releaseName, validateReleaseReason } from "./production-release-state.mjs";

export const MAX_PRIVATE_RECORD = 524_288;
export const releaseBytesDigest = value => createHash("sha256").update(value).digest("hex");
export const releaseJsonBytes = value => Buffer.from(`${JSON.stringify(value)}\n`);

export function requirePrivateDirectory(path) {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 ||
      realpathSync(absolute) !== absolute) throw new Error(`unsafe private release directory: ${absolute}`);
  return stat;
}

export function createPrivateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  requirePrivateDirectory(path);
  return path;
}

export function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function readPrivateBytes(path, { maxBytes = MAX_PRIVATE_RECORD, legacyMode = false, privateParent = true } = {}) {
  if (privateParent) requirePrivateDirectory(dirname(path));
  else {
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022) !== 0 ||
        realpathSync(dirname(path)) !== resolve(dirname(path))) throw new Error("unsafe private file parent");
  }
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() ||
      (!legacyMode && (before.mode & 0o077) !== 0) || before.size > maxBytes) {
    throw new Error(`unsafe or oversized private release file: ${path}`);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65_536, maxBytes + 1 - size));
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      size += count;
      if (size > maxBytes) throw new Error("private release file exceeds streaming bound");
      chunks.push(buffer.subarray(0, count));
    }
  } finally { closeSync(fd); }
  const raw = Buffer.concat(chunks, size);
  const after = lstatSync(path);
  if (raw.length > maxBytes || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.mtimeMs !== after.mtimeMs) {
    throw new Error("snapshot_changed");
  }
  return raw;
}

export function readPrivateJson(path, options) {
  return JSON.parse(readPrivateBytes(path, options));
}

export function writePrivateRecord(dir, filename, value, { kind, scope = "attempt", replaceInvalid = false } = {}) {
  requirePrivateDirectory(dir);
  releaseName(scope, filename, "file");
  const target = join(dir, filename);
  const raw = Buffer.isBuffer(value) ? value : releaseJsonBytes(value);
  if (raw.length > MAX_PRIVATE_RECORD) throw new Error("private release record exceeds bound");
  if (existsSync(target) && !replaceInvalid) {
    if (!readPrivateBytes(target, { legacyMode: true }).equals(raw)) throw new Error(`immutable release record differs: ${filename}`);
    return { path: target, sha256: releaseBytesDigest(raw), reused: true };
  }
  const registeredKind = kind ?? Object.entries(RECORD_KINDS).find(([, name]) => name === filename)?.[0];
  if (!registeredKind) throw new Error("durable record kind is not registered");
  const temporary = `.write-${registeredKind}-${randomUUID()}`;
  releaseName(scope, temporary, "file");
  const path = join(dir, temporary);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(path, target); syncDirectory(dir); }
  finally { if (existsSync(path)) unlinkSync(path); }
  return { path: target, sha256: releaseBytesDigest(raw), reused: false };
}

export function namedProcessIdentity(pid, read = readFileSync) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("positive named PID required");
  const text = read(`/proc/${pid}/stat`, "utf8");
  const close = text.lastIndexOf(")");
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const startTicks = fields[19];
  if (close < 0 || !Number.isSafeInteger(ppid) || ppid < 0 || !/^[1-9][0-9]*$/.test(startTicks ?? "")) {
    throw new Error("unreadable named PID identity");
  }
  return { pid, ppid, start_ticks: startTicks };
}

export function acquireReleaseLock(dir, key, scope = "attempt") {
  requirePrivateDirectory(dir);
  const filename = `.lock.${key}`;
  releaseName(scope, filename, "directory");
  const path = join(dir, filename);
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`release lock held; inspect/recover-lock ${path}`);
    throw error;
  }
  const identity = namedProcessIdentity(process.pid);
  const owner = { schema: 1, invocation_uuid: randomUUID(), ...identity };
  writePrivateRecord(path, "owner.json", owner, { kind: "owner", scope: "administrative" });
  const stat = requirePrivateDirectory(path);
  return { path, owner, dev: stat.dev, ino: stat.ino };
}

export function releaseReleaseLock(lock) {
  const stat = requirePrivateDirectory(lock.path);
  const owner = readPrivateJson(join(lock.path, "owner.json"));
  if (stat.dev !== lock.dev || stat.ino !== lock.ino || owner.invocation_uuid !== lock.owner.invocation_uuid) {
    throw new Error("release lock owner changed");
  }
  unlinkSync(join(lock.path, "owner.json"));
  rmdirSync(lock.path);
  syncDirectory(dirname(lock.path));
}

export function withReleaseLock(dir, key, fn, scope) {
  const lock = acquireReleaseLock(dir, key, scope);
  try { return fn(lock); } finally { releaseReleaseLock(lock); }
}

export async function withAsyncReleaseLock(dir, key, fn, scope) {
  const lock = acquireReleaseLock(dir, key, scope);
  try { return await fn(lock); } finally { releaseReleaseLock(lock); }
}

export function releaseEntryInventory(dir, scope) {
  requirePrivateDirectory(dir);
  return readdirSync(dir).sort().map(name => {
    const stat = lstatSync(join(dir, name));
    const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "special";
    releaseName(scope, name, type);
    return { scope, name, type, dev: stat.dev, ino: stat.ino, size: stat.size, mtime_ms: stat.mtimeMs };
  });
}

export function recoverReleaseResidue({ root, entry, scope = "root", observedDigest, reason,
  writersStopped = false, readProcess = namedProcessIdentity }) {
  validateReleaseReason(reason);
  const rule = releaseName(scope, entry, "directory");
  if (rule.disposition !== "diagnostic") throw new Error("only registered administrative residue can be recovered");
  const path = join(root, entry);
  requirePrivateDirectory(path);
  const inventory = releaseEntryInventory(path, "administrative");
  const bytes = Buffer.from(JSON.stringify(inventory));
  if (releaseBytesDigest(bytes) !== observedDigest) throw new Error("residue changed since inspection");
  let owner;
  try { owner = readPrivateJson(join(path, "owner.json")); }
  catch (error) { if (error.code !== "ENOENT" && !writersStopped) throw error; }
  if (owner) {
    try {
      const current = readProcess(owner.pid);
      if (current.start_ticks === owner.start_ticks) throw new Error("live owner cannot be recovered");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  } else if (!writersStopped) throw new Error("owner unknown; explicit stopped-writer confirmation required");
  const incidentRoot = createPrivateDirectory(`${resolve(root)}-incidents`);
  const destination = join(incidentRoot, randomUUID());
  renameSync(path, destination);
  writePrivateRecord(destination, "recovery.json", { schema: 1, entry, observed_sha256: observedDigest,
    reason, recovered_at: new Date().toISOString(), writer_confirmation: writersStopped }, { kind: "recovery", scope: "administrative" });
  syncDirectory(root);
  syncDirectory(incidentRoot);
  return { recovered: true, destination };
}

export function attemptDirectory(root, uuid) {
  if (!RELEASE_UUID.test(uuid ?? "")) throw new Error("lowercase v4 attempt UUID required before path construction");
  requirePrivateDirectory(root);
  const path = join(root, uuid);
  requirePrivateDirectory(path);
  return path;
}
