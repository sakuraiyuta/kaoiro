import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  isValidManifestShape,
  ManifestError,
  readManifest,
  writeManifest,
} from "../kaoiro-deploy-manifest.mjs";

function validManifest() {
  return {
    schema_version: 1,
    transaction_id: "20260906T101500Z",
    compose_artifact: { path: "server/docker-compose.yaml", sha256: "a".repeat(64) },
    env_consistency: { checked: true },
    image_id: "sha256:" + "b".repeat(64),
    source_sha: "c".repeat(40),
    target_sha: "d".repeat(40),
    volume_id: "kaoiro_kaoiro-state",
    archive: { path: "/backup/kaoiro-dets-1.tar.gz", sha256: "e".repeat(64) },
    required_entries: [
      { path: "users.dets", owner: "1000:1000", mode: "0600" },
    ],
  };
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-manifest-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("isValidManifestShape accepts a well-formed manifest", () => {
  assert.equal(isValidManifestShape(validManifest()), true);
});

test("isValidManifestShape rejects a bad source_sha", () => {
  const bad = validManifest();
  bad.source_sha = "not-a-sha";
  assert.equal(isValidManifestShape(bad), false);
});

test("isValidManifestShape rejects a missing compose_artifact sha256", () => {
  const bad = validManifest();
  delete bad.compose_artifact.sha256;
  assert.equal(isValidManifestShape(bad), false);
});

test("isValidManifestShape rejects a required_entries item without owner", () => {
  const bad = validManifest();
  bad.required_entries = [{ path: "users.dets", mode: "0600" }];
  assert.equal(isValidManifestShape(bad), false);
});

test("isValidManifestShape rejects an unknown schema_version", () => {
  const bad = validManifest();
  bad.schema_version = 2;
  assert.equal(isValidManifestShape(bad), false);
});

test("writeManifest then readManifest round-trips", () => {
  const manifest = validManifest();
  writeManifest(dir, manifest);
  assert.deepEqual(readManifest(dir), manifest);
});

test("writeManifest refuses a malformed manifest", () => {
  const bad = validManifest();
  bad.volume_id = "";
  assert.throws(() => writeManifest(dir, bad), ManifestError);
});

test("readManifest throws when manifest.json is absent", () => {
  assert.throws(() => readManifest(dir), ManifestError);
});

test("readManifest throws on invalid JSON", () => {
  writeManifest(dir, validManifest());
  const target = join(dir, "manifest.json");
  // Overwrite directly — writeManifest itself only ever writes valid JSON.
  writeFileSync(target, "not json at all");
  assert.throws(() => readManifest(dir), ManifestError);
});
