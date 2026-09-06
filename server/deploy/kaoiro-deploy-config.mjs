#!/usr/bin/env node
// Operator config for the deploy CLI (issue #306): a 0600 JSON file
// holding the operating values decided on #303 (2026-09-06). Every value
// has a default from that decision, so a config file only needs to state
// what it overrides.
import { readFileSync, statSync } from "node:fs";

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
});

const VALIDATORS = {
  allow_docker_override: (v) => typeof v === "boolean",
  backup_root: (v) => v === null || (typeof v === "string" && v !== ""),
  keep_generations: (v) => Number.isInteger(v) && v >= 1,
  retention_days: (v) => Number.isInteger(v) && v >= 1,
  capacity_multiplier: (v) => Number.isInteger(v) && v >= 1,
  health_poll_interval_ms: (v) => Number.isInteger(v) && v >= 1,
  health_poll_timeout_ms: (v) => Number.isInteger(v) && v >= 1,
  stability_window_ms: (v) => Number.isInteger(v) && v >= 0,
};

/** Merges a config file over DEFAULT_CONFIG. Rejects an unknown key
 *  outright rather than silently ignoring it — a typo'd key
 *  (`keep_generation` for `keep_generations`) must not silently fall
 *  back to the default while the operator believes it was set. Rejects a
 *  value that fails its own type/range check for the same reason.
 *
 *  `path === undefined` (no --config given) returns the defaults as-is;
 *  every other failure mode (missing file, wrong mode, bad JSON, bad
 *  shape) throws ConfigError. */
export function loadConfig(path) {
  if (path === undefined) return { ...DEFAULT_CONFIG };

  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    fail(`--config file is unreadable at ${path}: ${err.message}`);
  }
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    fail(
      `--config file must be mode 0600, found ${mode.toString(8)}: ${path} (chmod 600 ${path})`,
    );
  }

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    fail(`--config file is unreadable at ${path}: ${err.message}`);
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
