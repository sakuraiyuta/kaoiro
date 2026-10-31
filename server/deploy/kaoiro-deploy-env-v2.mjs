import { createHash } from "node:crypto";
import { posix } from "node:path";

const IMAGE = /^sha256:[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CONTRACT = "exhaustive_stable_v1";
const nonempty = v => typeof v === "string" && v.length > 0;
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, expected) => object(v) && Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const sha256 = s => createHash("sha256").update(s, "utf8").digest("hex");
export const isWithinStateVolume = p => nonempty(p) && posix.isAbsolute(p) && posix.normalize(p) === p && p.startsWith("/var/lib/kaoiro/");

// JSON.parse otherwise accepts duplicated object keys with last-wins semantics.
export function parseUniqueJson(raw) {
  let i = 0;
  const ws = () => { while (/\s/.test(raw[i] ?? "") && i < raw.length) i++; };
  function string() {
    const start = i++;
    while (i < raw.length) {
      if (raw[i] === "\\") { i += 2; continue; }
      if (raw[i++] === '"') return JSON.parse(raw.slice(start, i));
    }
    throw new Error("unterminated JSON string");
  }
  function value() {
    ws();
    if (raw[i] === '"') { string(); return; }
    if (raw[i] === "{") {
      i++; ws(); const seen = new Set();
      if (raw[i] === "}") { i++; return; }
      while (true) {
        ws(); if (raw[i] !== '"') throw new Error("expected JSON object key");
        const k = string(); if (seen.has(k)) throw new Error("duplicate JSON key"); seen.add(k);
        ws(); if (raw[i++] !== ":") throw new Error("expected colon"); value(); ws();
        const c = raw[i++]; if (c === "}") return; if (c !== ",") throw new Error("expected comma");
      }
    }
    if (raw[i] === "[") {
      i++; ws(); if (raw[i] === "]") { i++; return; }
      while (true) { value(); ws(); const c = raw[i++]; if (c === "]") return; if (c !== ",") throw new Error("expected comma"); }
    }
    const start = i; while (i < raw.length && !/[\s,\]}]/.test(raw[i])) i++;
    if (i === start) throw new Error("expected JSON value");
    JSON.parse(raw.slice(start, i));
  }
  if (typeof raw !== "string") throw new Error("expected JSON text");
  value(); ws(); if (i !== raw.length) throw new Error("trailing JSON");
  return JSON.parse(raw);
}

export function parsePersistenceManifest(raw) {
  const value = parseUniqueJson(raw);
  if (!Array.isArray(value) || value.length === 0) throw new Error("invalid persistence manifest");
  const stores = new Set(), envs = new Set();
  for (const entry of value) {
    if (!keys(entry, ["store", "env", "default_file", "default_path"]) || ![entry.store, entry.env, entry.default_file, entry.default_path].every(nonempty) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.env) || stores.has(entry.store) || envs.has(entry.env)) {
      throw new Error("invalid or duplicate persistence entry");
    }
    stores.add(entry.store); envs.add(entry.env);
  }
  return value;
}

export function isValidEnvConsistencyV2(value) {
  try {
    if (!keys(value, ["guard_schema", "old_image_id", "target_image_id", "path_policy", "target_manifest_raw", "target_manifest_sha256", "entries"]) ||
      value.guard_schema !== 2 || !IMAGE.test(value.old_image_id) || !IMAGE.test(value.target_image_id) || value.path_policy !== "textual_state_volume_v1" ||
      !nonempty(value.target_manifest_raw) || !DIGEST.test(value.target_manifest_sha256) || sha256(value.target_manifest_raw) !== value.target_manifest_sha256 || !object(value.entries)) return false;
    const target = parsePersistenceManifest(value.target_manifest_raw);
    if (Object.keys(value.entries).length !== target.length) return false;
    for (const t of target) {
      const e = value.entries[t.env];
      if (!object(e) || e.store_id !== t.store || e.target_env !== t.env || !isWithinStateVolume(e.target_path) || !nonempty(e.volume_name)) return false;
      if (e.kind === "existing") {
        if (!keys(e, ["kind", "store_id", "target_env", "target_path", "old_env", "old_effective_path", "old_path_source", "volume_name"]) ||
          !nonempty(e.old_env) || e.old_effective_path !== e.target_path || !["env", "old_manifest"].includes(e.old_path_source)) return false;
      } else if (e.kind === "new_store") {
        if (!keys(e, ["kind", "store_id", "target_env", "target_path", "old_effective_path", "old_manifest_contract", "old_manifest_raw", "old_manifest_sha256", "target_probe_path", "probe_result", "destination_probe_result", "operator_accepted_new_store", "volume_name"]) ||
          e.old_effective_path !== null || e.old_manifest_contract !== CONTRACT || !nonempty(e.old_manifest_raw) || !DIGEST.test(e.old_manifest_sha256) ||
          sha256(e.old_manifest_raw) !== e.old_manifest_sha256 || e.target_probe_path !== t.default_path || !posix.isAbsolute(e.target_probe_path) || posix.normalize(e.target_probe_path) !== e.target_probe_path ||
          e.probe_result !== "absent" || e.destination_probe_result !== "absent" || e.operator_accepted_new_store !== true ||
          parsePersistenceManifest(e.old_manifest_raw).some(old => old.store === e.store_id)) return false;
      } else return false;
    }
    return true;
  } catch { return false; }
}
