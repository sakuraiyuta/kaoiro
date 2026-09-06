#!/usr/bin/env node
// Classifies the running-container / state situation into the four
// branches decided on #303/#306 for "no running container":
//   (A) one stopped container            -> recover baseline from it
//   (B) no container but state exists    -> recovery from the manifest,
//                                            never auto-classified fresh
//   (C) truly fresh                      -> `start --initialize` only
//   (D) paused/dead/multiple/mismatch    -> diagnose, exit non-zero
//
// `start` (commit b) uses this to refuse creating a fresh deployment on
// top of state it does not recognise; `update`/`rollback` (later
// commits) reuse it for the same "what am I actually looking at" step
// rather than re-deriving their own branch logic.
import { dockerComposeContainerNames, dockerInspect } from "./kaoiro-deploy-docker.mjs";

export const BRANCH = Object.freeze({
  STOPPED_CONTAINER: "A",
  STATE_WITHOUT_CONTAINER: "B",
  FRESH: "C",
  DIAGNOSE: "D",
});

/** `hasState` is the caller's own answer to "does a manifest or a
 *  non-empty volume already exist" — this module only reads docker, it
 *  never inspects the filesystem or a manifest itself, so that question
 *  stays with whichever caller owns the transaction directory. */
export function classify(bin, cwd, service, hasState) {
  const names = dockerComposeContainerNames(bin, cwd, service);
  if (names.length > 1) {
    return {
      branch: BRANCH.DIAGNOSE,
      reason: `${names.length} containers match service ${service}; expected 0 or 1`,
    };
  }
  if (names.length === 0) {
    return hasState
      ? {
          branch: BRANCH.STATE_WITHOUT_CONTAINER,
          reason: "no container, but manifest/volume state already exists",
        }
      : { branch: BRANCH.FRESH, reason: "no container and no prior state" };
  }
  const [container] = names;
  const status = dockerInspect(bin, container, "{{.State.Status}}");
  if (status === "exited") {
    return { branch: BRANCH.STOPPED_CONTAINER, reason: "container is exited", container };
  }
  return {
    branch: BRANCH.DIAGNOSE,
    reason: `container status is "${status}", expected "exited"`,
    container,
  };
}
