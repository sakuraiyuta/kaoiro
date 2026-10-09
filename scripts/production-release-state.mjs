const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ALIAS_SOURCE = "[a-z0-9][a-z0-9-]{0,31}";
export const RELEASE_UUID = new RegExp(`^${UUID_SOURCE}$`);
export const RELEASE_ALIAS = new RegExp(`^${ALIAS_SOURCE}$`);
export const RELEASE_DIGEST = /^[0-9a-f]{64}$/;
export const RELEASE_SHA = /^[0-9a-f]{40}$/;

export const RECORD_KINDS = Object.freeze({
  plan: "attempt.json",
  completion: "completion.json",
  acknowledgment: "tag-ack.json",
  abandonment: "abandonment.json",
  quarantine: "quarantine.json",
  retirement: "retirement.json",
  canary: "canary.json",
  serverAudit: "server-audit.json",
});

const fixedRecords = Object.values(RECORD_KINDS);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const entry = (scope, id, source, type, disposition, exit) => Object.freeze({
  scope, id, pattern: new RegExp(`^(?:${source})$`), type, disposition, exit,
});

export const ROOT_LAYOUT = Object.freeze([
  entry("root", "attempt", UUID_SOURCE, "directory", "classify", "attempt lifecycle"),
  entry("root", "start", `\\.start-${UUID_SOURCE}`, "directory", "diagnostic", "recover-staging"),
  entry("root", "history-lock", "\\.lock.history", "directory", "diagnostic", "release or recover-lock"),
  ...fixedRecords.map(name => entry("attempt", name, escape(name), "file", "classify", "attempt lifecycle")),
  entry("attempt", "runner-fact", `runner-(?:baseline|before|after)-${ALIAS_SOURCE}\\.json`, "file", "classify", "attempt lifecycle"),
  entry("attempt", "activity", `runner-activity-${ALIAS_SOURCE}-${UUID_SOURCE}\\.json`, "file", "classify", "attempt lifecycle"),
  entry("attempt", "record-lock", "\\.lock.record", "directory", "diagnostic", "release or recover-lock"),
  entry("attempt", "queue-lock", `\\.lock.queue-${ALIAS_SOURCE}`, "directory", "diagnostic", "release or recover-lock"),
  entry("attempt", "legacy-completion-lock", "\\.lock.completion", "directory", "diagnostic", "recover-lock"),
  entry("attempt", "incident", "incident-evidence", "directory", "classify", "quarantine or verified repair"),
  entry("incident", "manifest", "manifest\\.json", "file", "classify", "verified repair"),
  entry("incident", "manifest-version", "[0-9a-f]{64}\\.manifest\\.json", "file", "classify", "verified repair"),
  entry("incident", "bytes", "[0-9a-f]{64}\\.raw", "file", "classify", "verified repair"),
  ...["release-owner.json", "release-audit.json", "release-switch-proof.json"].map(name =>
    entry("update-lock", name, escape(name), "file", "classify", "owner cleanup or verified dead-owner recovery")),
  ...["owner.json", "recovery.json"].map(name => entry("administrative", name, escape(name), "file", "diagnostic", "recover-lock or recover-staging")),
  entry("administrative", "staged-plan", "attempt\\.json", "file", "diagnostic", "commit start or recover-staging"),
  ...["root", "attempt", "administrative", "incident", "update-lock"].map(scope => entry(scope, "write", `\\.write-(?:${Object.keys(RECORD_KINDS).join("|")}|runner-fact|activity|owner|recovery|incident-manifest|incident-bytes)-${UUID_SOURCE}`, "file", "diagnostic", "recover-staging")),
  entry("attempt", "legacy-temporary", `(?:${fixedRecords.map(escape).join("|")}|runner-baseline-[0-9a-f]{16}\\.json)\\.tmp\\.[1-9][0-9]*`, "file", "diagnostic", "recover-staging"),
]);

export function releaseName(scope, name, type) {
  const rules = ROOT_LAYOUT.filter(rule => rule.scope === scope && rule.pattern.test(name));
  if (rules.length !== 1 || (type !== undefined && rules[0]?.type !== type)) {
    throw new Error(`unknown release history entry: ${scope}/${name} (${type ?? "unknown type"})`);
  }
  return rules[0];
}

export function assertGrammarCoverage(observations) {
  for (const { scope, name, type } of observations) releaseName(scope, name, type);
  for (const state of RELEASE_STATES) {
    if (!state.id || !state.disposition || !state.exit || !Array.isArray(state.guards)) {
      throw new Error(`release state has no disposition/exit: ${state.id}`);
    }
  }
  return true;
}

const state = (id, disposition, exit, guards, match) => Object.freeze({ id, disposition, exit, guards: Object.freeze(guards), match });
export const RELEASE_STATES = Object.freeze([
  state("unknown_identity", "refuse", "repair-history from verified original/backup; never invent identity", ["identity"], value => !value.identityKnown),
  state("invalid_quarantined", "terminal-incident", "archive; keep incident on cards", ["incident-manifest", "idle-at-transition"], value => value.quarantineValid),
  state("deployed_uncompleted", "terminal-incident", "archive; keep incident on cards", ["retired-all-legs", "idle-at-transition"], value => value.retirementValid),
  state("invalid_completion", "unresolved", "quarantine known UUID or verified repair", ["identity", "idle-at-transition", "preserve-bytes"], value => value.invalid || value.conflict),
  state("abandoned", "resolved", "archive", ["unused-at-transition", "idle-at-transition"], value => value.abandonmentValid),
  state("published", "resolved", "verified archive", ["completion", "remote-pair"], value => value.completionValid && value.publication === "published"),
  state("publication_missing", "unresolved", "dispatch and reconcile or UUID-bound update skip", ["completion", "remote-pair"], value => value.completionValid && value.publication === "missing"),
  state("publication_unconfirmed", "unresolved", "repair remote/checkout and reconcile; bounded update skip only for known UUID", ["completion", "remote-pair"], value => value.completionValid),
  state("rollout_active", "unresolved", "wait/inspect or verified not-started timer cancellation", ["activity"], value => value.activity !== "idle"),
  state("deployed_incomplete", "unresolved", "complete/repair or retire-deployed after every leg leaves target", ["applied", "retired-all-legs", "idle-at-transition"], value => value.applied),
  state("in_progress", "unresolved", "resume/complete or guarded abandon", ["unused-at-transition", "idle-at-transition"], () => true),
]);

export function classifyReleaseState(observation) {
  return RELEASE_STATES.find(rule => rule.match(observation));
}

export const ADMIN_STATES = Object.freeze([
  { id: "authority_unavailable", disposition: "refuse", exit: "enroll empty root or repair verified authority" },
  { id: "empty_root", disposition: "resolved", exit: "legitimate enrolled baseline" },
  { id: "uncommitted_staging", disposition: "diagnostic", exit: "dead-writer recovery or recover-staging" },
  { id: "live_lock", disposition: "diagnostic", exit: "owner releases normally" },
  { id: "stale_or_legacy_lock", disposition: "diagnostic", exit: "recover-lock; age never proves death" },
  { id: "archived_terminal", disposition: "resolved", exit: "inspection and retained incident reporting" },
  { id: "capacity", disposition: "refuse-at-1000", exit: "verified archive; warn at 900" },
  { id: "switch_proof", disposition: "current-child-only", exit: "owner cleanup or validated source recovery" },
]);

export function releaseStateTable() {
  return [
    "| State | Disposition | Exit | Guards |",
    "|---|---|---|---|",
    ...[...RELEASE_STATES, ...ADMIN_STATES].map(rule => `| ${rule.id} | ${rule.disposition} | ${rule.exit} | ${(rule.guards ?? []).join(", ")} |`),
  ].join("\n");
}

export function validateReleaseReason(value) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.startsWith("-") ||
      Buffer.byteLength(value) > 512 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error("release reason must be one nonempty line of at most 512 UTF-8 bytes, without controls/format characters");
  }
  return value;
}

export function validateReleaseContext(uuid, digest) {
  if (!uuid && !digest) return null;
  if (!RELEASE_UUID.test(uuid ?? "") || !RELEASE_DIGEST.test(digest ?? "")) {
    throw new Error("--release-attempt and --release-plan-sha256 require a lowercase v4 UUID and 64-hex digest together");
  }
  return { attempt_uuid: uuid, plan_sha256: digest };
}

export function validateReleaseSkip(csv, reason) {
  if (!csv && !reason) return [];
  validateReleaseReason(reason);
  const values = typeof csv === "string" ? csv.split(",") : [];
  if (Buffer.byteLength(csv ?? "") > 3699 || values.length < 1 || values.length > 100 ||
      values.some(value => !RELEASE_UUID.test(value)) || new Set(values).size !== values.length) {
    throw new Error("release skip requires 1–100 unique lowercase v4 UUIDs and a reason");
  }
  return values;
}

export function parseReleaseOptions(args, allowed) {
  if (args.length % 2 !== 0 || args.length > 32) throw new Error("bounded option/value pairs required");
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!/^--[a-z][a-z0-9-]*$/.test(key) || !allowed.includes(key.slice(2)) ||
        Object.hasOwn(flags, key.slice(2)) || typeof value !== "string" || !value ||
        value.startsWith("-") || Buffer.byteLength(value) > 4096 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
      throw new Error(`invalid or repeated release option: ${key}`);
    }
    flags[key.slice(2)] = value;
  }
  return flags;
}
