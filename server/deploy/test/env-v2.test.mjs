import "../../../scripts/test/fixtures/test-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isValidEnvConsistencyV2, isWithinStateVolume, parsePersistenceManifest } from "../kaoiro-deploy-env-v2.mjs";
import { isValidEnvConsistency } from "../kaoiro-deploy-manifest.mjs";

const digest = s => createHash("sha256").update(s).digest("hex");
const raw = JSON.stringify([{store:"users",env:"USERS",default_file:"users.dets",default_path:"/tmp/users.dets"}]);
const old = JSON.stringify([{store:"other",env:"OTHER",default_file:"other.dets",default_path:"/tmp/other.dets"}]);
const record = () => ({guard_schema:2,old_image_id:`sha256:${"a".repeat(64)}`,target_image_id:`sha256:${"b".repeat(64)}`,path_policy:"textual_state_volume_v1",target_manifest_raw:raw,target_manifest_sha256:digest(raw),entries:{USERS:{kind:"existing",store_id:"users",target_env:"USERS",target_path:"/var/lib/kaoiro/users.dets",old_env:"USERS",old_effective_path:"/var/lib/kaoiro/users.dets",old_path_source:"env",volume_name:"state"}}});
const newRecord = () => {
  const r = record();
  r.entries.USERS = {kind:"new_store",store_id:"users",target_env:"USERS",target_path:"/var/lib/kaoiro/users.dets",old_effective_path:null,old_manifest_contract:"exhaustive_stable_v1",old_manifest_raw:old,old_manifest_sha256:digest(old),target_probe_path:"/tmp/users.dets",probe_result:"absent",destination_probe_result:"absent",operator_accepted_new_store:true,volume_name:"state"};
  return r;
};

const setDefaultPath = (r, path) => {
  const entries = JSON.parse(r.target_manifest_raw);
  entries[0].default_path = path;
  r.target_manifest_raw = JSON.stringify(entries);
  r.target_manifest_sha256 = digest(r.target_manifest_raw);
  r.entries.USERS.target_probe_path = path;
};

const readerCases = [
  ["top-level keys", record, r => { r.extra = true; }],
  ["schema", record, r => { r.guard_schema = 3; }],
  ["old image", record, r => { r.old_image_id = "bad"; }],
  ["target image", record, r => { r.target_image_id = "bad"; }],
  ["path policy", record, r => { r.path_policy = "bad"; }],
  ["target manifest hash", record, r => { r.target_manifest_sha256 = "0".repeat(64); }],
  ["target manifest parsing", record, r => { const a = JSON.parse(raw); delete a[0].default_file; r.target_manifest_raw = JSON.stringify(a); r.target_manifest_sha256 = digest(r.target_manifest_raw); }],
  ["entry count", record, r => { r.entries.EXTRA = {...r.entries.USERS}; }],
  ["store id", record, r => { r.entries.USERS.store_id = "other"; }],
  ["target env", record, r => { r.entries.USERS.target_env = "OTHER"; }],
  ["target path", record, r => { r.entries.USERS.target_path = r.entries.USERS.old_effective_path = "/outside"; }],
  ["volume name", record, r => { r.entries.USERS.volume_name = ""; }],
  ["existing keys", record, r => { r.entries.USERS.extra = true; }],
  ["existing old env", record, r => { r.entries.USERS.old_env = ""; }],
  ["existing old path", record, r => { r.entries.USERS.old_effective_path = "/var/lib/kaoiro/other"; }],
  ["existing source", record, r => { r.entries.USERS.old_path_source = "other"; }],
  ["new store keys", newRecord, r => { r.entries.USERS.extra = true; }],
  ["new store old path", newRecord, r => { r.entries.USERS.old_effective_path = "/var/lib/kaoiro/old"; }],
  ["new store contract", newRecord, r => { r.entries.USERS.old_manifest_contract = "other"; }],
  ["old manifest hash", newRecord, r => { r.entries.USERS.old_manifest_sha256 = "0".repeat(64); }],
  ["probe matches default", newRecord, r => { r.entries.USERS.target_probe_path = "/tmp/other"; }],
  ["probe absolute", newRecord, r => { setDefaultPath(r, "relative"); }],
  ["probe normalized", newRecord, r => { setDefaultPath(r, "/tmp/../relative"); }],
  ["probe absent", newRecord, r => { r.entries.USERS.probe_result = "present"; }],
  ["destination absent", newRecord, r => { r.entries.USERS.destination_probe_result = "present"; }],
  ["operator accepted", newRecord, r => { r.entries.USERS.operator_accepted_new_store = false; }],
  ["old manifest excludes store", newRecord, r => { r.entries.USERS.old_manifest_raw = raw; r.entries.USERS.old_manifest_sha256 = digest(raw); }],
  ["old manifest parsing", newRecord, r => { const a = JSON.parse(old); delete a[0].default_file; r.entries.USERS.old_manifest_raw = JSON.stringify(a); r.entries.USERS.old_manifest_sha256 = digest(r.entries.USERS.old_manifest_raw); }],
  ["unknown kind", record, r => { r.entries.USERS.kind = "other"; }],
];
for (const [name, make, change] of readerCases) {
  test(`v2 reader rejects ${name}`, () => {
    const r = make();
    assert.equal(isValidEnvConsistencyV2(r), true);
    change(r);
    assert.equal(isValidEnvConsistencyV2(r), false);
  });
}

test("v2 binds every target store to an inside matching path", () => {
  const r = record(); assert.equal(isValidEnvConsistencyV2(r), true);
  delete r.entries.USERS; assert.equal(isValidEnvConsistencyV2(r), false);
  const extra = record(); extra.entries.EXTRA = {...extra.entries.USERS, target_env:"EXTRA"};
  assert.equal(isValidEnvConsistencyV2(extra), false);
  const changed = record(); changed.entries.USERS.old_effective_path = "/var/lib/kaoiro/else.dets"; assert.equal(isValidEnvConsistencyV2(changed), false);
  const outside = record(); outside.entries.USERS.target_path = outside.entries.USERS.old_effective_path = "/var/lib/kaoiro-else/x"; assert.equal(isValidEnvConsistencyV2(outside), false);
  const hash = record(); hash.target_manifest_sha256 = "0".repeat(64); assert.equal(isValidEnvConsistencyV2(hash), false);
});

test("v2 new-store evidence does not fabricate an old path", () => {
  const r = record(); r.entries.USERS = {kind:"new_store",store_id:"users",target_env:"USERS",target_path:"/var/lib/kaoiro/users.dets",old_effective_path:null,old_manifest_contract:"exhaustive_stable_v1",old_manifest_raw:old,old_manifest_sha256:digest(old),target_probe_path:"/tmp/users.dets",probe_result:"absent",destination_probe_result:"absent",operator_accepted_new_store:true,volume_name:"state"};
  assert.equal(isValidEnvConsistencyV2(r), true);
  const probePresent = structuredClone(r); probePresent.entries.USERS.probe_result = "present";
  assert.equal(isValidEnvConsistencyV2(probePresent), false);
  const destinationPresent = structuredClone(r); destinationPresent.entries.USERS.destination_probe_result = "present";
  assert.equal(isValidEnvConsistencyV2(destinationPresent), false);
  const wrongProbe = structuredClone(r); wrongProbe.entries.USERS.target_probe_path = "/tmp/other.dets";
  assert.equal(isValidEnvConsistencyV2(wrongProbe), false);
  r.entries.USERS.old_manifest_raw = raw; r.entries.USERS.old_manifest_sha256 = digest(raw);
  assert.equal(isValidEnvConsistencyV2(r), false);
});

test("manifest rejects duplicate keys and duplicate store identities", () => {
  assert.throws(() => parsePersistenceManifest('[{"store":"a","store":"b","env":"A","default_file":"x","default_path":"/x"}]'));
  const one = JSON.parse(raw)[0]; assert.throws(() => parsePersistenceManifest(JSON.stringify([one, {...one,env:"OTHER"}])));
});

test("shared reader keeps legacy records and rejects partial v2 as legacy", () => {
  assert.equal(isValidEnvConsistency({skipped:true, reason:"legacy"}), true);
  assert.equal(isValidEnvConsistency({skipped:false, entries:{}}), true);
  assert.equal(isValidEnvConsistency(record()), true);
  assert.equal(isValidEnvConsistency({guard_schema:2, skipped:true, reason:"legacy"}), false);
});

test("v2 fails closed on malformed identity, manifest, and evidence", () => {
  const scenarios = [
    r => { r.old_image_id = "sha256:short"; },
    r => { r.target_image_id = "sha256:short"; },
    r => { r.path_policy = "other"; },
    r => { r.target_manifest_raw = "[]"; r.target_manifest_sha256 = digest("[]"); },
    r => { r.entries.USERS.target_env = "OTHER"; },
    r => { r.entries.USERS.store_id = "other"; },
    r => { r.entries.USERS.target_path = r.entries.USERS.old_effective_path = "/var/lib/kaoiro/../escape"; },
    r => { r.entries.USERS.old_path_source = "target"; },
    r => { r.entries.USERS.volume_name = ""; },
    r => { r.entries.USERS.unexpected = true; },
    r => { r.unexpected = true; },
  ];
  for (const change of scenarios) {
    const r = record(); change(r); assert.equal(isValidEnvConsistencyV2(r), false, change.toString());
  }
});

test("manifest validates environment identifiers and shape", () => {
  const entry = JSON.parse(raw)[0];
  assert.throws(() => parsePersistenceManifest(JSON.stringify([{...entry, env:".*"}])));
  assert.throws(() => parsePersistenceManifest(JSON.stringify([{...entry, extra:true}])));
  assert.throws(() => parsePersistenceManifest(JSON.stringify([entry, {...entry, store:"other"}])));
});

test("state volume path containment is normalized and boundary aware", () => {
  assert.equal(isWithinStateVolume("/var/lib/kaoiro/a.dets"), true);
  for (const path of ["relative", "/var/lib/kaoiro", "/var/lib/kaoiro/", "/var/lib/kaoiro-other/a", "/var/lib/kaoiro/../outside", "/var/lib/kaoiro//a"]) {
    assert.equal(isWithinStateVolume(path), false, path);
  }
});
