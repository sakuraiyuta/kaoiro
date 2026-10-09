export function isLandingBuildVersion(value) {
  if (typeof value !== "string") return false;
  const match = /^(2[0-9]{3}|[3-9][0-9]{3})\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])\.([1-9][0-9]{0,5})$/.exec(value);
  if (!match || match[0] !== value) return false;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function isValidBuildVersion(value) {
  if (value === "unknown" || value === "untagged") return true;
  if (typeof value !== "string") return false;
  return isLandingBuildVersion(value) || /^\d{4}\.(?:[1-9]|1[0-2])\.\d{1,6}$/.exec(value)?.[0] === value;
}

export function isValidBuildBranch(value) {
  if (typeof value !== "string" || value.length === 0 ||
      new TextEncoder().encode(value).length > 256 || value === "@" ||
      value.startsWith("-") || value.endsWith(".") ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(value) ||
      value.includes("..") || value.includes("@{")) return false;
  return value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function hasValidBuildBranch(version, branch) {
  return branch === undefined
    ? !isLandingBuildVersion(version) && version !== "untagged"
    : isValidBuildBranch(branch);
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function attests(info, expected, allowDirty = false) {
  if (!info || typeof info !== "object" || Array.isArray(info)) return false;
  if (typeof expected !== "string" ||
      (expected !== "unknown" && /^[0-9a-f]{40}$/.exec(expected)?.[0] !== expected)) return false;
  if (expected === "unknown" && !allowDirty) return false;
  if (info.revision !== expected || typeof info.dirty !== "boolean" || (!allowDirty && info.dirty)) return false;
  if (typeof info.built_at !== "string" || (info.built_at !== "unknown" &&
      (!Number.isFinite(Date.parse(info.built_at)) || new Date(info.built_at).toISOString() !== info.built_at))) return false;
  const hasVersion = Object.hasOwn(info, "version");
  if (hasVersion !== Object.hasOwn(info, "channel") || !hasValidBuildBranch(info.version, info.branch)) return false;
  if (hasVersion && (!isValidBuildVersion(info.version) || !["dev", "release"].includes(info.channel))) return false;
  if (info.channel === "release" && (info.dirty || expected === "unknown" || ["unknown", "untagged"].includes(info.version))) return false;
  return !isLandingBuildVersion(info.version) || (!info.dirty && expected !== "unknown");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, value, expected, allow] = process.argv.slice(2);
    let info;
    if (mode === "--legacy-file") {
      info = JSON.parse(readFileSync(join(value, "dist/build-info.json"), "utf8"));
      if (isLandingBuildVersion(info.version) || info.version === "untagged") throw new Error("new artifacts require the JSON CLI");
      const archive = readFileSync(join(value, "VERSION"), "utf8").trim();
      if (archive !== `${info.revision}${info.dirty ? "-dirty" : ""}`) throw new Error("archive identity mismatch");
      if (!attests(info, expected, allow === "yes")) throw new Error("legacy identity mismatch");
      process.stdout.write(`${JSON.stringify(info)}\n`);
    } else if (mode === "--json") {
      info = JSON.parse(value);
      if (!attests(info, expected, allow === "yes")) throw new Error("machine identity mismatch");
    } else {
      throw new Error("unsupported attestation mode");
    }
  } catch (error) {
    process.stderr.write(`build identity: ${error.message}\n`);
    process.exitCode = 1;
  }
}
