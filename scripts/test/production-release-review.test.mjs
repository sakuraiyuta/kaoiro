import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { enrolledHealthUrl, validateRuntimeHosts } from "../production-release-plan.mjs";
import { readLifecycleInspection } from "../production-release-lifecycle.mjs";
import { collectServerCompletion } from "../collect-production-release.mjs";
import { parseReleaseOptions } from "../production-release-state.mjs";

const inventory = {
  schema: 1,
  runtime_hosts: [{ alias: "runner-01", runtime_host_id: "private-machine-marker" }],
  authority: {
    server: { root: "/private/server", sha256: "a".repeat(64) },
    runners: [{ alias: "runner-01", root: "/private/runner", sha256: "b".repeat(64) }],
  },
  health_url: "https://recording.example/health",
};

test("public alias refuses a raw runtime ID and its dictionary-checkable host hash", () => {
  for (const alias of ["private-machine-marker",
    createHash("sha256").update("private-machine-marker").digest("hex").slice(0, 16)]) {
    assert.throws(() => validateRuntimeHosts([{ alias, runtime_host_id: "private-machine-marker" }]),
      /alias reveals a runtime ID or its host-key hash/);
  }
  validateRuntimeHosts(inventory.runtime_hosts);
});

test("completion and lifecycle resolve their health URL from the fixed inventory before external reads", async () => {
  assert.equal(enrolledHealthUrl(inventory), inventory.health_url);
  assert.equal(enrolledHealthUrl(inventory, inventory.health_url), inventory.health_url);
  for (const url of ["https://staging.example/health", "https://recording.example/other"]) {
    assert.throws(() => enrolledHealthUrl(inventory, url), /differs from fixed enrollment/);
    await assert.rejects(readLifecycleInspection({}, { inventory, healthUrl: url }), /differs from fixed enrollment/);
    await assert.rejects(collectServerCompletion({}, { inventory, healthUrl: url }), /differs from fixed enrollment/);
  }
  const { health_url, ...legacy } = inventory;
  assert.throws(() => enrolledHealthUrl(legacy), /fixed enrollment health URL required/);
  for (const health_url of ["file:///private", "https://user:secret@recording.example/health", "https://recording.example/health#fragment"])
    assert.throws(() => enrolledHealthUrl({ ...inventory, health_url }), /fixed health URL/);
});

test("the queue JSON envelope accommodates 100 UUID skips while each updater value remains bounded", () => {
  const uuids = Array.from({ length: 100 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`).join(",");
  const value = JSON.stringify(["--tarball", "/private/artifact", "--skip-release-reconciliation", uuids,
    "--skip-reason", "x".repeat(512)]);
  assert.ok(Buffer.byteLength(value) > 4096);
  assert.equal(parseReleaseOptions(["--update-args", value], ["update-args"],
    { valueBounds: { "update-args": 32 * 4096 + 256 } })["update-args"], value);
  assert.throws(() => parseReleaseOptions(["--update-args", "x".repeat(32 * 4096 + 257)], ["update-args"],
    { valueBounds: { "update-args": 32 * 4096 + 256 } }), /invalid/);
});
