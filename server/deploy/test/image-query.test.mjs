import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { queryManifestRaw, queryPersistenceContract } from "../kaoiro-deploy-image-query.mjs";

test("raw query keeps bytes and rejects invalid UTF-8", () => {
  const dir = mkdtempSync(join(tmpdir(), "momo920-query-"));
  try {
    const bin = join(dir, "docker");
    writeFileSync(bin, '#!/bin/sh\nprintf "  []\\n"\n', {mode:0o700});
    assert.equal(queryManifestRaw(bin, "sha256:x"), "  []\n");
    writeFileSync(bin, '#!/bin/sh\nprintf "\\377"\n', {mode:0o700});
    assert.throws(() => queryManifestRaw(bin, "sha256:x"));
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test("contract query accepts only a successful exact marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "momo920-contract-"));
  try {
    const bin = join(dir, "docker");
    writeFileSync(bin, '#!/bin/sh\nprintf \'"exhaustive_stable_v1"\\n\'\n', {mode:0o700});
    assert.equal(queryPersistenceContract(bin, "sha256:x"), "exhaustive_stable_v1");
    writeFileSync(bin, '#!/bin/sh\nprintf \'"other"\\n\'\n', {mode:0o700});
    assert.equal(queryPersistenceContract(bin, "sha256:x"), null);
    writeFileSync(bin, '#!/bin/sh\nexit 1\n', {mode:0o700});
    assert.equal(queryPersistenceContract(bin, "sha256:x"), null);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test("query enforces timeouts and contract timeout has no marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "momo920-timeout-"));
  try {
    const bin = join(dir, "docker");
    writeFileSync(bin, '#!/bin/sh\nwhile :; do :; done\n', {mode:0o700});
    assert.throws(() => queryManifestRaw(bin, "sha256:x", {timeout:100}), e => e.code === "ETIMEDOUT");
    assert.equal(queryPersistenceContract(bin, "sha256:x", {timeout:100}), null);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test("query passes temporary-directory values without shell expansion", () => {
  const dir = mkdtempSync(join(tmpdir(), "momo920-env-"));
  try {
    const bin = join(dir, "docker");
    writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {mode:0o700});
    const lines = queryManifestRaw(bin, "sha256:x", {env:{TEMP:"",TMP:"literal value"}}).trim().split("\n");
    assert.deepEqual(lines.slice(0, 9), ["run", "--rm", "--entrypoint", "/usr/bin/env", "sha256:x", "-u", "TMPDIR", "TEMP=", "TMP=literal value"]);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
