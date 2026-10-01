import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, symlinkSync,
  writeFileSync, openSync, closeSync, fsyncSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const CREDENTIALS = ["auth.json", ".credentials.json", "secrets", "mcp-oauth-locks"];
// rust-v0.156.1 and rust-v0.159.3: state/src/sqlite.rs, rollout/src,
// message-history/src/lib.rs, config/src, skills/src/lib.rs. Extension trees
// have no copy-all exemption: their classification needs separate review.
const DBS = ["state_5", "logs_2", "goals_1", "memories_1", "memories_v2_1", "queue_1", "thread_history_1"];
const STATE_DIRS = new Set(["sessions", "archived_sessions", "db-backups", "memories", "memories_v2", "memories_extensions", "rules", "skills"]);
const STATE_FILES = new Set(["config.toml", "managed_config.toml", "AGENTS.md", "AGENTS.override.md", "history.jsonl", "session_index.jsonl", "installation_id", "hooks.json", ".sandbox_migration"]);
const DISPOSABLE = new Set(["tmp", ".tmp", "thread-writer-locks", "log", "shell_snapshots", "models_cache.json", "version.json"]);
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const inside = (root, path) => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)); };
export function must(condition, message) { if (!condition) throw new Error(message); }
// A dangling link is a present, invalid entry, never an empty installation.
export function hasEntry(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
export function identity(path) {
  must(isAbsolute(path) && realpathSync(path) === resolve(path), "Directory must use its original canonical absolute path");
  const st = lstatSync(path);
  must(st.isDirectory() && st.uid === process.getuid() && !(st.mode & 0o077), "Directory must be private and owned by the operator");
  return { path: realpathSync(path), dev: st.dev, ino: st.ino, mode: st.mode & 0o777 };
}
export function atomicJSON(path, value) {
  const temp = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const parent = openSync(dirname(path), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
function classification(name) {
  if (CREDENTIALS.includes(name)) return "credential";
  if (DISPOSABLE.has(name)) return "disposable";
  if (STATE_DIRS.has(name) || STATE_FILES.has(name) || DBS.some((db) => ["", "-wal", "-shm", "-journal"].some((suffix) => name === `${db}.sqlite${suffix}`))) return "state";
  throw new Error(`Unclassified Codex home entry: ${name}`);
}

export function inventory(home, hash = false) {
  identity(home);
  const entries = [];
  const walk = (dir, category) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(home, path);
      const kind = category ?? classification(name);
      const st = lstatSync(path);
      must(st.uid === process.getuid(), "Foreign-owned home entry");
      const type = st.isDirectory() ? "directory" : st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : "special";
      must(type !== "special", "Unsupported special entry in Codex home");
      must(type !== "file" || st.nlink === 1, "Hard-linked home entry is unsupported");
      const entry = { path: rel, category: kind, type, mode: st.mode & 0o777, size: st.size };
      if (type === "symlink") {
        must(kind !== "credential", "Credential symlink is unsupported");
        must(!/^(sessions|archived_sessions|db-backups)(\/|$)/.test(rel) && !rel.includes(".sqlite"), "External database/session storage is unsupported");
        entry.target = readlinkSync(path);
      }
      if (hash && kind === "state" && type === "file") entry.sha256 = digest(readFileSync(path));
      entries.push(entry);
      if (type === "directory") walk(path, kind);
    }
  };
  walk(home);
  return entries;
}
export function stateEntries(entries) { return entries.filter((e) => e.category === "state"); }
function stableEntries(entries) {
  return entries.map(({ size, ...e }) => e.type === "file" ? { ...e, size } : e);
}
export function sameState(a, b) {
  return JSON.stringify(stableEntries(stateEntries(a))) === JSON.stringify(stableEntries(stateEntries(b)));
}
function migrationFiles(entries) {
  return stateEntries(entries).filter((e) => e.type === "file" && /^[^/]+\.sqlite(?:-wal|-shm|-journal)?$/.test(e.path));
}
export function capacity(parent, entries, migrationCopy = false) {
  const bytes = stateEntries(entries).reduce((sum, e) => sum + (e.type === "file" ? e.size : 0), 0);
  const diagnostics = migrationCopy ? migrationFiles(entries) : [];
  const migrationCopyBytes = diagnostics.reduce((sum, e) => sum + e.size, 0);
  const migrationCopyInodes = diagnostics.length + diagnostics.filter((e) => e.path.endsWith(".sqlite")).length * 2;
  // Logical sizes omit block rounding and new SQLite SHM (~32 KiB per DB);
  // the reserve of at least 1 GiB is assumed to absorb both.
  const reserve = Math.max(Math.ceil(bytes * 0.2), 1024 ** 3);
  const fs = statfsSync(parent);
  must(fs.bavail * fs.bsize >= bytes + migrationCopyBytes + reserve, "Insufficient snapshot/restore disk capacity");
  must(fs.ffree >= entries.length + migrationCopyInodes + 10, "Insufficient snapshot/restore inodes");
  return { logicalBytes: bytes, migrationCopyBytes, migrationCopyInodes, reserveBytes: reserve, entries: entries.length };
}
export function throughputEstimate(parent, entries) {
  const stage = join(parent, `.codex-throughput-${randomUUID()}`);
  const count = 16, bytes = 64 * 1024;
  const start = performance.now();
  mkdirSync(stage, { mode: 0o700 });
  try {
    const sample = Buffer.alloc(bytes, 0x61);
    for (let i = 0; i < count; i++) {
      const source = join(stage, `source-${i}`), copy = join(stage, `copy-${i}`);
      writeFileSync(source, sample, { mode: 0o600 });
      copyFileSync(source, copy);
      must(digest(readFileSync(copy)) === digest(sample), "Throughput sample copy failed");
    }
    const seconds = Math.max((performance.now() - start) / 1000, 0.001);
    const logicalBytes = stateEntries(entries).reduce((sum, e) => sum + (e.type === "file" ? e.size : 0), 0);
    return { sampleSeconds: seconds, sampleBytes: count * bytes, sampleFiles: count,
      estimatedSeconds: Math.max(logicalBytes / (count * bytes), entries.length / count) * seconds,
      advisoryOnly: true };
  } finally { rmSync(stage, { recursive: true }); }
}
function copyEntries(source, dest, entries) {
  mkdirSync(dest, { mode: 0o700 });
  for (const e of stateEntries(entries)) {
    const path = join(dest, e.path);
    must(inside(dest, path) && e.path !== "" && !isAbsolute(e.path), "Invalid snapshot relative path");
    if (e.type === "directory") mkdirSync(path, { mode: 0o700 });
    else if (e.type === "symlink") symlinkSync(e.target, path);
    else { copyFileSync(join(source, e.path), path); chmodSync(path, e.mode); }
  }
  for (const e of [...stateEntries(entries)].reverse()) {
    if (e.type === "directory") chmodSync(join(dest, e.path), e.mode);
  }
}
export async function migrationLevels(payload, entries) {
  const dbs = entries.filter((e) => e.category === "state" && e.type === "file" && /^[^/]+\.sqlite$/.test(e.path));
  if (!dbs.length) return {};
  const { DatabaseSync } = await import("node:sqlite");
  const levels = {};
  // SQLite readOnly still creates or rewrites WAL sidecars. Neither the
  // source nor the hash-bound snapshot payload may be opened by SQLite.
  const scratch = mkdtempSync(join(dirname(payload), ".migration-levels-"));
  try {
    for (const e of migrationFiles(entries)) {
      copyFileSync(join(payload, e.path), join(scratch, e.path));
    }
    for (const e of dbs) {
      const db = new DatabaseSync(join(scratch, e.path), { readOnly: true });
      try {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'").get();
        levels[e.path] = has ? db.prepare("SELECT version, success FROM _sqlx_migrations ORDER BY version").all() : [];
      } finally { db.close(); }
    }
    return levels;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
export async function snapshot(home, destination, metadata) {
  const source = identity(home);
  const parent = realpathSync(dirname(destination));
  must(isAbsolute(destination) && !hasEntry(destination) && join(parent, basename(destination)) === destination, "Snapshot destination must be new and canonical");
  must(!inside(home, destination) && !inside(destination, home), "Snapshot overlaps Codex home");
  const entries = inventory(home, true);
  capacity(parent, entries, true);
  const stage = metadata.staging;
  must(stage === join(parent, `.staging.codex-${metadata.uuid}`), "Invalid snapshot staging ownership");
  mkdirSync(stage, { mode: 0o700 });
  copyEntries(home, join(stage, "state"), entries);
  const manifest = { schema: 1, classification: 1, ...metadata, source, entries: stateEntries(entries), credentialsOmitted: CREDENTIALS, migrationLevels: await migrationLevels(join(stage, "state"), entries) };
  must(sameState(entries, inventory(join(stage, "state"), true)), "Snapshot copy differs from source");
  must(sameState(entries, inventory(home, true)), "Source changed during snapshot");
  atomicJSON(join(stage, "manifest.json"), manifest);
  renameSync(stage, destination);
  return { manifest, sha256: digest(readFileSync(join(destination, "manifest.json"))) };
}
export function verifySnapshot(path, expectedHash) {
  identity(path);
  const bytes = readFileSync(join(path, "manifest.json"));
  must(digest(bytes) === expectedHash, "Snapshot manifest digest mismatch");
  const manifest = JSON.parse(bytes);
  must(manifest.schema === 1 && manifest.classification === 1 && Array.isArray(manifest.entries), "Unsupported snapshot manifest");
  must(JSON.stringify(readdirSync(path).sort()) === JSON.stringify(["manifest.json", "state"]), "Unexpected snapshot entry");
  const actual = inventory(join(path, "state"), true);
  must(actual.every((e) => e.category === "state"), "Snapshot contains excluded entries");
  must(sameState(actual, manifest.entries), "Snapshot payload mismatch");
  return manifest;
}
export function prepareRestore(snapshotPath, expectedHash, home, stage) {
  const manifest = verifySnapshot(snapshotPath, expectedHash);
  must(manifest.source.path === home, "Snapshot belongs to a different home");
  identity(home);
  capacity(dirname(home), manifest.entries);
  copyEntries(join(snapshotPath, "state"), stage, manifest.entries);
  must(sameState(inventory(stage, true), manifest.entries), "Restore staging mismatch");
  return manifest;
}
export function promoteRestore(home, stage, quarantine, recordMove) {
  inventory(home);
  identity(stage);
  must(dirname(home) === dirname(stage) && dirname(home) === dirname(quarantine), "Restore directories must be siblings");
  must(!hasEntry(quarantine), "Restore quarantine already exists");
  recordMove("quarantine-intent");
  renameSync(home, quarantine);
  recordMove("quarantined");
  for (const name of CREDENTIALS) {
    const path = join(quarantine, name);
    if (hasEntry(path)) {
      recordMove(`credential-intent:${name}`);
      renameSync(path, join(stage, name));
      recordMove(`credential-moved:${name}`);
    }
  }
  recordMove("promote-intent");
  renameSync(stage, home);
  recordMove("state-restored");
}
