import { execFileSync } from "node:child_process";
import { TextDecoder } from "node:util";

export const IMAGE_QUERY_TIMEOUT_MS = 30_000;
export const PERSISTENCE_CONTRACT = "exhaustive_stable_v1";
const MANIFEST_EXPR = "IO.puts(Jason.encode!(KaoiroServer.PersistencePaths.manifest()))";
const CONTRACT_EXPR = "IO.puts(Jason.encode!(KaoiroServer.PersistencePaths.contract()))";

export function queryImageRaw(bin, imageId, expression, { env = null, timeout = IMAGE_QUERY_TIMEOUT_MS } = {}) {
  const args = ["run", "--rm"];
  if (env !== null) {
    args.push("--entrypoint", "/usr/bin/env", imageId);
    for (const name of ["TMPDIR", "TEMP", "TMP"]) {
      if (!Object.hasOwn(env, name)) args.push("-u", name);
    }
    for (const name of ["TMPDIR", "TEMP", "TMP"]) {
      if (Object.hasOwn(env, name)) args.push(`${name}=${env[name]}`);
    }
    args.push("/app/bin/kaoiro_server", "eval", expression);
  } else {
    args.push("--entrypoint", "/app/bin/kaoiro_server", imageId, "eval", expression);
  }
  const raw = execFileSync(bin, args, { timeout, maxBuffer: 2 * 1024 * 1024 });
  return new TextDecoder("utf-8", { fatal: true }).decode(raw);
}

export function queryManifestRaw(bin, imageId, opts) {
  return queryImageRaw(bin, imageId, MANIFEST_EXPR, opts);
}

export function queryPersistenceContract(bin, imageId, opts) {
  try {
    return JSON.parse(queryImageRaw(bin, imageId, CONTRACT_EXPR, opts)) === PERSISTENCE_CONTRACT ? PERSISTENCE_CONTRACT : null;
  } catch {
    return null;
  }
}
