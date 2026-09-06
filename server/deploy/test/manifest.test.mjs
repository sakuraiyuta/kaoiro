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
    env_consistency: {
      skipped: false,
      entries: {
        KAOIRO_CLIENT_TOKENS: {
          declared: "set",
          compose: "set",
          container_effective: "set",
          container_source: "env",
          match: true,
        },
      },
    },
    image_id: "sha256:" + "b".repeat(64),
    source_sha: "c".repeat(40),
    target_sha: "d".repeat(40),
    volume_id: "kaoiro_kaoiro-state",
    archive: { path: "/backup/kaoiro-dets-1.tar.gz", sha256: "e".repeat(64) },
    required_entries: [
      { path: "users.dets", owner: "1000:1000", mode: "0600" },
    ],
    rollback_tag: `kaoiro-server:rollback-${"c".repeat(40)}`,
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

test("isValidManifestShape rejects an image_id that is not a sha256 digest", () => {
  const bad = validManifest();
  bad.image_id = "not-an-image";
  assert.equal(isValidManifestShape(bad), false);
});

test("isValidManifestShape rejects a required_entries owner that is not numeric uid:gid", () => {
  const bad = validManifest();
  bad.required_entries = [{ path: "users.dets", owner: "banana", mode: "0600" }];
  assert.equal(isValidManifestShape(bad), false);
});

test("isValidManifestShape rejects a required_entries mode that is not octal", () => {
  const bad = validManifest();
  bad.required_entries = [{ path: "users.dets", owner: "1000:1000", mode: "banana" }];
  assert.equal(isValidManifestShape(bad), false);
});

test("isValidManifestShape rejects duplicate required_entries paths", () => {
  const bad = validManifest();
  bad.required_entries = [
    { path: "users.dets", owner: "1000:1000", mode: "0600" },
    { path: "users.dets", owner: "1000:1000", mode: "0644" },
  ];
  assert.equal(isValidManifestShape(bad), false);
});

test("isValidManifestShape rejects an env_consistency entry with a non-boolean match", () => {
  const bad = validManifest();
  bad.env_consistency = {
    skipped: false,
    entries: {
      KAOIRO_CLIENT_TOKENS: {
        declared: "set",
        compose: "set",
        container_effective: "set",
        container_source: "env",
        match: "yes",
      },
    },
  };
  assert.equal(isValidManifestShape(bad), false);
});

// issue #220 absorption: env_consistency's discriminated union.
test("isValidManifestShape accepts env_consistency reporting skipped with a reason", () => {
  const manifest = validManifest();
  manifest.env_consistency = { skipped: true, reason: "eval exited 1: module not landed" };
  assert.equal(isValidManifestShape(manifest), true);
});

test("isValidManifestShape rejects env_consistency skipped:true with no reason", () => {
  const bad = validManifest();
  bad.env_consistency = { skipped: true };
  assert.equal(isValidManifestShape(bad), false);
});

test("isValidManifestShape rejects env_consistency skipped:false with no entries", () => {
  const bad = validManifest();
  bad.env_consistency = { skipped: false };
  assert.equal(isValidManifestShape(bad), false);
});

test("isValidManifestShape rejects a bare per-key map with no skipped discriminator (the pre-#220 shape)", () => {
  const bad = validManifest();
  bad.env_consistency = {
    KAOIRO_CLIENT_TOKENS: {
      declared: "set",
      compose: "set",
      container_effective: "set",
      container_source: "env",
      match: true,
    },
  };
  assert.equal(isValidManifestShape(bad), false);
});

// クロエ round 5 review A-MF-2: container_effective replaces the original
// 2-way raw-env `container` field — never null (the image's own
// default_path fills in when the container's raw env is unset), and
// container_source names which of the two it actually is.
test("isValidManifestShape rejects an env_consistency entry with a null container_effective", () => {
  const bad = validManifest();
  bad.env_consistency.entries.KAOIRO_CLIENT_TOKENS.container_effective = null;
  assert.equal(isValidManifestShape(bad), false);
});

test("isValidManifestShape rejects an env_consistency entry with an unknown container_source", () => {
  const bad = validManifest();
  bad.env_consistency.entries.KAOIRO_CLIENT_TOKENS.container_source = "guessed";
  assert.equal(isValidManifestShape(bad), false);
});

// director ruling 2026-09-06: recorded so retention's docker-tag cleanup
// reads the tag from the manifest, never a docker-image-list glob.
test("isValidManifestShape rejects a malformed rollback_tag", () => {
  const bad = validManifest();
  bad.rollback_tag = "kaoiro-server:rollback-not-a-sha";
  assert.equal(isValidManifestShape(bad), false);
});

test("isValidManifestShape rejects a rollback_tag naming a different sha than source_sha", () => {
  const bad = validManifest();
  bad.rollback_tag = `kaoiro-server:rollback-${"9".repeat(40)}`;
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
