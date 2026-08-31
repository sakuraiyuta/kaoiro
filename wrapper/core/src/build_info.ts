// Wrapper build identity reader. The sibling build-info.json is generated
// from the repository-wide scripts/build-identity.mjs before this package is
// deployed; runtime never asks git for provenance.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface WrapperBuildInfo {
  revision: string;
  dirty: boolean;
  version: string;
  channel: "dev" | "release";
}

const UNKNOWN_WRAPPER_BUILD_INFO: WrapperBuildInfo = {
  revision: "unknown",
  dirty: false,
  version: "unknown",
  channel: "dev",
};

const BUILD_REVISION_RE = /^[0-9a-f]{40}$/;
const BUILD_VERSION_RE = /^\d{4}\.(?:[1-9]|1[0-2])\.\d+$/;

function validBuiltAt(value: unknown): value is string {
  if (value === "unknown") return true;
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validBuildInfo(value: unknown): value is WrapperBuildInfo & { built_at: string } {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.revision === "string" &&
    (raw.revision === "unknown" || BUILD_REVISION_RE.test(raw.revision)) &&
    typeof raw.dirty === "boolean" &&
    validBuiltAt(raw.built_at) &&
    typeof raw.version === "string" &&
    (raw.version === "unknown" || BUILD_VERSION_RE.test(raw.version)) &&
    (raw.channel === "dev" || raw.channel === "release")
  );
}

/** Reads the wrapper artifact's own build info. Missing, malformed, or
 * partially generated artifacts are visible as one bounded unknown identity. */
export function loadWrapperBuildInfo(
  file = join(dirname(fileURLToPath(import.meta.url)), "build-info.json"),
): WrapperBuildInfo {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return UNKNOWN_WRAPPER_BUILD_INFO;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNKNOWN_WRAPPER_BUILD_INFO;
  }
  if (!validBuildInfo(parsed)) return UNKNOWN_WRAPPER_BUILD_INFO;
  return {
    revision: parsed.revision,
    dirty: parsed.dirty,
    version: parsed.version,
    channel: parsed.channel,
  };
}
