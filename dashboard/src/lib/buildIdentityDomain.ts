export function isLandingBuildVersion(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(2[0-9]{3}|[3-9][0-9]{3})\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])\.([1-9][0-9]{0,5})$/.exec(value);
  if (!match || match[0] !== value) return false;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function isValidBuildVersion(value: unknown): value is string {
  if (value === "unknown" || value === "untagged") return true;
  if (typeof value !== "string") return false;
  return isLandingBuildVersion(value) || /^\d{4}\.(?:[1-9]|1[0-2])\.\d{1,6}$/.exec(value)?.[0] === value;
}

export function isValidBuildBranch(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 ||
      new TextEncoder().encode(value).length > 256 || value === "@" ||
      value.startsWith("-") || value.endsWith(".") ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(value) ||
      value.includes("..") || value.includes("@{")) return false;
  return value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function hasValidBuildBranch(version: unknown, branch: unknown): boolean {
  return branch === undefined
    ? !isLandingBuildVersion(version) && version !== "untagged"
    : isValidBuildBranch(branch);
}
