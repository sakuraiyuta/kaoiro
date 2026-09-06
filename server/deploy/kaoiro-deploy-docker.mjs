#!/usr/bin/env node
// Docker operation wrapper + the fake-docker override gate (issue #306).
//
// THE GATE. KAOIRO_DEPLOY_DOCKER_BIN lets a caller point every docker
// invocation at a substitute binary — the seam unit tests need to pin
// branch classification and phase transitions without a real docker
// daemon. Left unguarded, that same env var would let a stray value in a
// production shell silently redirect a live deploy at a fake binary (an
// operator's own docker wrapper alias, a leftover test export) with no
// visible sign anything changed. So this is not a config value pointing
// AT an override — it is a config-file PERMISSION gate ON the env var:
// the operator's --config file (0600, untracked) must explicitly carry
// `allow_docker_override: true` before KAOIRO_DEPLOY_DOCKER_BIN is even
// read. Without that flag the env var is silently ignored, not rejected
// loudly — a production host legitimately never sets it, and a loud
// rejection there would fire on every ordinary run.
import { execFileSync } from "node:child_process";

/** Resolves which docker binary this run uses, and whether that is an
 *  override. Callers surface `overridden` in --dry-run / status output
 *  (as `docker=fake`) so an operator reading a plan can never mistake a
 *  gated test run for a production one. */
export function resolveDockerBin(config, env = process.env) {
  const override = env.KAOIRO_DEPLOY_DOCKER_BIN;
  if (!override || config?.allow_docker_override !== true) {
    return { bin: "docker", overridden: false };
  }
  return { bin: override, overridden: true };
}

/** Runs `<bin> <args>`, returning trimmed stdout. Throws (with stderr
 *  attached by execFileSync itself) on a non-zero exit — callers decide
 *  what a given failure means (branch classification, abort, ...); this
 *  only runs the process. */
export function runDocker(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: "utf8", ...opts }).trim();
}

/** `docker inspect <target> --format <format>` — one target, one format
 *  per call. Kept narrow rather than a generic passthrough: every caller
 *  in this CLI wants exactly one field answering exactly one question,
 *  and a wider surface would just move the guessing into each call site
 *  instead of settling it here once. */
export function dockerInspect(bin, target, format) {
  return runDocker(bin, ["inspect", target, "--format", format]);
}
