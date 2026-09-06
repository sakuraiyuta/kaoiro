import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { dockerInspect, resolveDockerBin } from "../kaoiro-deploy-docker.mjs";

let dir;
let fakeBin;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-docker-"));
  fakeBin = join(dir, "fake-docker.sh");
  // Echoes back its own argv, one per line, so a test can assert exactly
  // what this module invoked it with.
  writeFileSync(
    fakeBin,
    "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done\n",
  );
  chmodSync(fakeBin, 0o700);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("resolveDockerBin ignores the override when the config has no explicit opt-in", () => {
  const result = resolveDockerBin(undefined, { KAOIRO_DEPLOY_DOCKER_BIN: fakeBin });
  assert.deepEqual(result, { bin: "docker", overridden: false });
});

test("resolveDockerBin ignores the override when config sets allow_docker_override to something other than true", () => {
  const result = resolveDockerBin(
    { allow_docker_override: "true" },
    { KAOIRO_DEPLOY_DOCKER_BIN: fakeBin },
  );
  assert.deepEqual(result, { bin: "docker", overridden: false });
});

test("resolveDockerBin activates the override only with both the env var and the config opt-in", () => {
  const result = resolveDockerBin(
    { allow_docker_override: true },
    { KAOIRO_DEPLOY_DOCKER_BIN: fakeBin },
  );
  assert.deepEqual(result, { bin: fakeBin, overridden: true });
});

test("resolveDockerBin stays on the real binary when the opt-in is set but no env var is present", () => {
  const result = resolveDockerBin({ allow_docker_override: true }, {});
  assert.deepEqual(result, { bin: "docker", overridden: false });
});

test("dockerInspect runs the resolved binary with inspect/target/--format", () => {
  const output = dockerInspect(fakeBin, "some-container", "{{.State.Status}}");
  assert.equal(output, "inspect\nsome-container\n--format\n{{.State.Status}}");
});
