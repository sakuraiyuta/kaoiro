#!/usr/bin/env node
// Operator config for the deploy CLI (issue #306): a 0600 JSON file
// holding the operating values decided on #303 (2026-09-06). Every value
// has a default from that decision, so a config file only needs to state
// what it overrides.
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export class ConfigError extends Error {}

function fail(message) {
  throw new ConfigError(message);
}

/** Defaults per the #303 operator decisions (2026-09-06). `backup_root`
 *  stays null here rather than resolving `~/kaoiro-deploy` at module load
 *  — HOME is a runtime fact, not a build-time constant, and baking it in
 *  here would make every test that imports this module inherit whatever
 *  HOME the test runner happens to have. Callers resolve it lazily. */
export const DEFAULT_CONFIG = Object.freeze({
  allow_docker_override: false,
  backup_root: null,
  keep_generations: 5,
  retention_days: 30,
  capacity_multiplier: 10,
  health_poll_interval_ms: 2000,
  health_poll_timeout_ms: 60000,
  stability_window_ms: 30000,
  // deployment.md 4.5's own provenance-verification source
  // (`curl <server-url>/api/health`). 127.0.0.1:4000 matches
  // docker-compose.yaml's default port publish; an operator whose
  // KAOIRO_PUBLISH_IP is not loopback overrides this.
  health_url: "http://127.0.0.1:4000/api/health",
  // Clean-stop expectation (S1 / yuta ruling 2026-09-06): "measured on a
  // dev host, not assumed" (deployment.md 4.3 step 5). `null` here is
  // deliberate — until commit (e)'s dev-host self-test fixes a real
  // value, EVERY stop is treated as abnormal (see
  // kaoiro-server-deploy.mjs's clean-stop check), which is the safe
  // direction to fail in. An operator config sets both together once
  // the measurement exists; there is no default non-null value to fall
  // back to.
  expected_clean_stop_exit_code: null,
  expected_clean_stop_oom_killed: null,
});

const VALIDATORS = {
  allow_docker_override: (v) => typeof v === "boolean",
  // クロエ round 1 review SF-6: a relative backup_root is not caught
  // until well after the stop window opens (docker rejects a relative
  // bind-mount source with exit 125, but only once the archive step
  // tries to use it), and journal.json/manifest.json would still have
  // been written to a cwd-relative directory by then. Absolute-only,
  // checked here at config load, fails BEFORE anything is touched.
  backup_root: (v) => v === null || (typeof v === "string" && v !== "" && isAbsolute(v)),
  keep_generations: (v) => Number.isInteger(v) && v >= 1,
  retention_days: (v) => Number.isInteger(v) && v >= 1,
  capacity_multiplier: (v) => Number.isInteger(v) && v >= 1,
  health_poll_interval_ms: (v) => Number.isInteger(v) && v >= 1,
  health_poll_timeout_ms: (v) => Number.isInteger(v) && v >= 1,
  stability_window_ms: (v) => Number.isInteger(v) && v >= 0,
  health_url: (v) => {
    if (typeof v !== "string" || v === "") return false;
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  },
  expected_clean_stop_exit_code: (v) => v === null || Number.isInteger(v),
  expected_clean_stop_oom_killed: (v) => v === null || typeof v === "boolean",
};

/** Merges a config file over DEFAULT_CONFIG. Rejects an unknown key
 *  outright rather than silently ignoring it — a typo'd key
 *  (`keep_generation` for `keep_generations`) must not silently fall
 *  back to the default while the operator believes it was set. Rejects a
 *  value that fails its own type/range check for the same reason.
 *
 *  `path === undefined` (no --config given) returns the defaults as-is;
 *  every other failure mode (missing file, wrong mode, bad JSON, bad
 *  shape) throws ConfigError.
 *
 *  AUTHORIZATION-VS-CONTENT IDENTITY (ふじ design review S2). Mode and
 *  ownership are checked, and the file is read, through the SAME open
 *  file descriptor — a stat-by-path followed by a separate
 *  readFileSync-by-path would let the path be replaced between the two
 *  calls (classic TOCTOU), so the mode this function approved would not
 *  be the mode of the bytes it actually parses. Opening once and using
 *  fstat + a read on that fd closes that specific window.
 *
 *  WHAT THIS DOES NOT CLOSE: everything before the open() itself. A
 *  party with write access to this path (or to a directory in it) at any
 *  point before this call — necessarily the same privilege level needed
 *  to plant a malicious --config in the first place — is not defended
 *  against by mode/owner checks done AFTER they already acted. This
 *  function proves "the fd I opened, at open time, was 0600 and owned by
 *  me", not "no same-privilege party has ever touched this file". */
export function loadConfig(path) {
  if (path === undefined) return { ...DEFAULT_CONFIG };

  let fd;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    fail(`--config file is unreadable at ${path}: ${err.message}`);
  }
  let raw;
  try {
    const stat = fstatSync(fd);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      fail(
        `--config file must be mode 0600, found ${mode.toString(8)}: ${path} (chmod 600 ${path})`,
      );
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      fail(
        `--config file must be owned by the current user (uid ${process.getuid()}), found uid ${stat.uid}: ${path}`,
      );
    }
    raw = readFileSync(fd, "utf8");
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    fail(`--config file is unreadable at ${path}: ${err.message}`);
  } finally {
    closeSync(fd);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`--config file is not valid JSON at ${path}: ${err.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`--config file must contain a JSON object: ${path}`);
  }

  for (const [key, value] of Object.entries(parsed)) {
    const validate = VALIDATORS[key];
    if (validate === undefined) {
      fail(`--config file has an unknown key: ${key} (${path})`);
    }
    if (!validate(value)) {
      fail(`--config file has an invalid value for ${key}: ${JSON.stringify(value)} (${path})`);
    }
  }

  return { ...DEFAULT_CONFIG, ...parsed };
}
