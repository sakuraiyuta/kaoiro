import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isValidEnvConsistencyV2, parsePersistenceManifest } from "../kaoiro-deploy-env-v2.mjs";
import { isValidEnvConsistency } from "../kaoiro-deploy-manifest.mjs";

const digest = s => createHash("sha256").update(s).digest("hex");
const raw = JSON.stringify([{store:"users",env:"USERS",default_file:"users.dets",default_path:"/tmp/users.dets"}]);
const old = JSON.stringify([{store:"other",env:"OTHER",default_file:"other.dets",default_path:"/tmp/other.dets"}]);
const record = () => ({guard_schema:2,old_image_id:`sha256:${"a".repeat(64)}`,target_image_id:`sha256:${"b".repeat(64)}`,path_policy:"textual_state_volume_v1",target_manifest_raw:raw,target_manifest_sha256:digest(raw),entries:{USERS:{kind:"existing",store_id:"users",target_env:"USERS",target_path:"/var/lib/kaoiro/users.dets",old_env:"USERS",old_effective_path:"/var/lib/kaoiro/users.dets",old_path_source:"env",volume_name:"state"}}});

test("v2 binds every target store to an inside matching path", () => {
  const r = record(); assert.equal(isValidEnvConsistencyV2(r), true);
  delete r.entries.USERS; assert.equal(isValidEnvConsistencyV2(r), false);
  const changed = record(); changed.entries.USERS.old_effective_path = "/var/lib/kaoiro/else.dets"; assert.equal(isValidEnvConsistencyV2(changed), false);
  const outside = record(); outside.entries.USERS.target_path = outside.entries.USERS.old_effective_path = "/var/lib/kaoiro-else/x"; assert.equal(isValidEnvConsistencyV2(outside), false);
  const hash = record(); hash.target_manifest_sha256 = "0".repeat(64); assert.equal(isValidEnvConsistencyV2(hash), false);
});

test("v2 new-store evidence does not fabricate an old path", () => {
  const r = record(); r.entries.USERS = {kind:"new_store",store_id:"users",target_env:"USERS",target_path:"/var/lib/kaoiro/users.dets",old_effective_path:null,old_manifest_contract:"exhaustive_stable_v1",old_manifest_raw:old,old_manifest_sha256:digest(old),target_probe_path:"/var/lib/kaoiro/users.dets",probe_result:"absent",operator_accepted_new_store:true,volume_name:"state"};
  assert.equal(isValidEnvConsistencyV2(r), true);
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
