import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FLEET_RPC, requireFleetCompatibility, targetFormats, validateFleet } from "../kaoiro-build-compatibility.mjs";

const revision = "a".repeat(40);
const modern = { id: "host", build_version: "2026.10.09.2" };
const snapshot = { schema: 1, hosts: [modern], wrappers: [] };

test("an absent target capability is legacy-only and cannot accept a modern fleet", () => {
  const formats = targetFormats({ revision }, revision);
  assert.deepEqual(formats, ["legacy-calver"]);
  assert.throws(() => validateFleet(snapshot, formats), /does not support/);
  assert.deepEqual(validateFleet({ ...snapshot, hosts: [{ ...modern, build_version: "2026.9.0" }] }, formats).hosts.length, 1);
});

test("modern identities require the bridge capability in either fleet group", () => {
  const formats = targetFormats({ revision, build_identity_formats: ["legacy-calver", "landing-calver-v1"] }, revision);
  assert.equal(validateFleet(snapshot, formats), snapshot);
  assert.throws(() => validateFleet({ ...snapshot, hosts: [], wrappers: [modern] }, ["legacy-calver"]), /does not support/);
  for (const version of ["untagged", "2026.10.09.2"]) {
    assert.throws(() => validateFleet({ ...snapshot, hosts: [{ ...modern, build_version: version }] }, ["legacy-calver"]), /does not support/);
  }
});

test("unreadable or malformed observations never establish legacy compatibility", () => {
  for (const value of [null, {}, { ...snapshot, schema: 2 }, { ...snapshot, hosts: [{ id: "host" }] },
    { ...snapshot, hosts: [modern, modern] }, { ...snapshot, hosts: [{ ...modern, build_version: "2026.02.30.1" }] }]) {
    assert.throws(() => validateFleet(value, ["legacy-calver", "landing-calver-v1"]), /compatibility refused/);
  }
  assert.throws(() => targetFormats({ revision: "b".repeat(40) }, revision), /full revision/);
  assert.throws(() => targetFormats({ revision, build_identity_formats: ["future"] }, revision), /malformed/);
});

test("the command reaches the live node through fixed rpc and fleet-stopped never waives target attestation", () => {
  const dir = mkdtempSync(join(tmpdir(), "fuji571-fleet-rpc-"));
  try {
    const bin = join(dir, "docker");
    writeFileSync(bin, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0] === 'run') console.log(${JSON.stringify(JSON.stringify({ revision }))});\nelse if (args[0] === 'exec' && args[3] === 'rpc' && args[4] === ${JSON.stringify(FLEET_RPC)}) console.log(${JSON.stringify(JSON.stringify(snapshot))});\nelse process.exit(1);\n`, { mode: 0o700 });
    const input = { bin, targetImageId: "sha256:pinned", targetRevision: revision, containerId: "current" };
    assert.throws(() => requireFleetCompatibility(input), /does not support/);
    const proof = requireFleetCompatibility({ ...input, fleetStopped: true });
    assert.equal(proof.target_revision, revision);
    assert.equal(proof.fleet_stopped, true);
    assert.equal(proof.fleet, undefined);
    assert.throws(() => requireFleetCompatibility({ ...input, targetRevision: "b".repeat(40), fleetStopped: true }), /full revision/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
