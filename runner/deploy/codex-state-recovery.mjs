#!/usr/bin/env node
// Recovery contract of the Codex state helper: which outcome each command has
// in each record phase, and the only source of the hint text that refusals
// print. The helper's control flow decides; the property test checks that its
// outcomes and rendered hints equal this table (docs/plans/issue-709-n3-recovery-table.md).
import { realpathSync } from "node:fs";
import { join } from "node:path";

export const PHASES = ["prepared", "snapshot-verified", "start-intent", "completed", "failed", "restore-prepared", "replace-intent", "restored"];
export const COMMANDS = ["RES", "REC", "RST", "PRN", "UPD", "RBK"];
export const LABELS = { RES: "resume", REC: "recover", RST: "restore", PRN: "prune", RBK: "rollback" };
export const CLASSES = ["transaction", "config", "integrity", "transient", "lock", "cutover", "usage", "none", "unclassified"];
export const CAUSAL = ["transaction", "config", "integrity", "transient", "lock", "cutover"];
export const OUTCOMES = ["settle", "held", "refuse", "noop", ...PHASES];
const RUNBOOK = "docs/operations/runner-update-and-rollback.md";
export const ANCHORS = {
  backup: `${RUNBOOK}#codex-state-backup`,
  table: `${RUNBOOK}#recovery-table`,
  config: `${RUNBOOK}#editing-the-runner-environment`,
  integrity: "docs/operations/codex-home.md#fresh-setup-after-failed-snapshot-recovery",
  lock: `${RUNBOOK}#stale-operation-locks`,
  cutover: `${RUNBOOK}#old-records-and-barriers`,
};

const M = {
  tool: "Use the recorded physical updater tool",
  unresolved: "Unresolved Codex transaction requires recovery: ${}",
  outside: "Current is outside recorded operation",
  activity: "Runner activity is transitional or unknown",
  lock: "Lock held: ${}",
  old: "Resolve old Codex state records with the previous tool release: ${}",
  shellLock: "another run holds ",
  nonTerminal: "Prune requires a terminal operation",
  noSnapshot: "No unique retained snapshot matches selection",
  replacing: "Replacement is already unfinished",
  descendants: "Runner descendants remain",
  notStopped: "Runner is not fully stopped",
  nextHome: "Next launch CODEX_HOME differs from requested home",
};
const BINDING = ["Selected installed service differs from record", M.nextHome, "Running CODEX_HOME differs from requested home", "Restore home/service differs from selected record"];
const site = (prefix, names, fields) => names.map(name => ({ id: `${prefix}.${name}`, ...fields }));

// One row per pre-mutation call site; the id matches a codex-recovery-site
// marker at that call.
export const GUARDS = [
  { id: "G1.run", messages: [M.tool], class: "transaction" },
  ...site("G2", ["guard", "prepare", "restore", "run", "prune"], { messages: [M.unresolved], class: "transaction", pin: "refuses %s before its first mutation with a second unfinished operation" }),
  ...site("G3", ["run", "guard"], { messages: [M.outside], class: "integrity", pin: "refuses %s before authorization" }),
  ...site("G4", ["run-pre", "guard-entry", "restore", "prepare"], { messages: BINDING, class: "config", pin: "refuses restore admission with requested %s disagreement before stop" }),
  ...site("G5", ["began", "binding-run", "pre-stop", "target-check", "resume-stop"], { messages: [M.activity], class: "transient", pin: "handles %s without unsafe subsequent effects" }),
  { id: "G6.helper", messages: [M.lock], class: "lock", pin: "preserves a held %s and takes no other unowned lock" },
  ...site("G6", ["updater", "switch-links", "install-links"], { messages: [M.shellLock], class: "lock" }),
  ...site("G7", ["guard", "prepare", "restore", "run", "prune", "protected"], { messages: [M.old], class: "cutover", pin: "blocks every remaining mutation entrance on an unresolved old %s" }),
];

const b = (id, cmds, outcome, fields = {}) => ({ id, cmds, outcome, ...fields });
const refuse = (id, cmds, message, cls, fields = {}) => b(id, cmds, "refuse", { message, class: cls, ...fields });
const via = (id, cmds, guard) => ({ id, cmds, guard });
const prePrune = id => refuse(id, ["PRN"], M.nonTerminal, "transaction");
const preUpdates = p => [via(`${p}-UPD`, ["UPD"], "G2.prepare"), via(`${p}-RBK`, ["RBK"], "G2.guard")];
const DEAD = "recovers after dead worker at $phase $to $when";
const snapshotSites = [
  b("PS.snapshot-stopped", ["RES"], "settle", { pre: "activity-window", message: M.notStopped, class: "transient", site: true }),
  b("PS.snapshot-binding", ["RES"], "settle", { pre: "activity-window", message: M.activity, class: "transient", site: true }),
];
const sourceReturn = [
  b("PS.return-link", ["REC"], "held", { pre: "late-link", message: "Source link changed before recovery", class: "integrity", site: true, pin: "refuses source restart after %s" }),
  b("PS.return-binding", ["REC"], "held", { pre: "late-home", message: M.nextHome, class: "config", site: true }),
  b("PS.return-activity", ["REC"], "held", { pre: "activity-window", final: "failed", message: M.activity, class: "transient", site: true }),
];
const terminal = [
  b("T-noop", ["RES", "REC"], "noop", { pin: DEAD }),
  b("T-RST-ok", ["RST"], "restored", { pre: "snapshot-retained", pin: "restores an explicitly selected older snapshot after an intermediate snapshot and release were pruned" }),
  refuse("T-RST-retired", ["RST"], M.noSnapshot, "transaction", { pre: "snapshot-retired" }),
  b("T-PRN", ["PRN"], "noop", { pre: "snapshot-retained", pin: "retries durable prune intent with %s" }),
  b("T-UPD", ["UPD"], "noop"),
  b("T-RBK-ok", ["RBK"], "noop", { pre: "same-native" }),
  refuse("T-RBK-native", ["RBK"], "Codex native pin differs: use state-aware backup/restore", "config", { pre: "differing-native", pin: "refuses cross-native code-only switching with zero link mutations" }),
  refuse("T-RBK-pre-n2", ["RBK"], "A retained v2 snapshot forbids activating a pre-N2 tool", "config", { pre: "pre-n2-target" }),
];
const forward = ["RES", "REC"];

export const TABLE = {
  prepared: { next: forward, branches: [
    b("P-RES-ok", ["RES"], "completed", { pre: "current-source" }),
    b("P-RES-copy", ["RES"], "settle", { pre: "copy-fault", pin: "resumes source after %s with recoverable residue" }),
    b("P-REC-ok", ["REC"], "failed", { pre: "current-source", pin: DEAD }),
    refuse("P-RST-own", ["RST"], M.noSnapshot, "transaction"),
    b("PS.stopped", ["RES"], "settle", { pre: "late-populated", message: M.descendants, class: "transient", site: true, pin: "restarts a failed restore only if admission began %s" }),
    prePrune("P-PRN"), ...preUpdates("P"),
    ...snapshotSites, ...sourceReturn,
  ] },
  "snapshot-verified": { next: forward, branches: [
    b("V-RES-ok", ["RES"], "completed", { pre: "state-equal" }),
    b("V-RES-stale", ["RES"], "settle", { pre: "state-differs", pin: "refuses stale snapshot reuse after a source boot but keeps recover usable" }),
    b("V-REC-ok", ["REC"], "failed", { pre: "current-source", pin: DEAD }),
    b("V-REC-missing", ["REC"], "failed", { pre: "snapshot-missing", pin: "recovers a verified record with a missing snapshot without activating the candidate" }),
    refuse("V-RST-own", ["RST"], "Use never-started source recovery", "transaction"),
    prePrune("V-PRN"), ...preUpdates("V"),
    b("PS.guard-nested", ["RES"], "settle", { pre: "activity-window", message: M.activity, class: "transient", site: true }),
    ...snapshotSites, ...sourceReturn,
  ] },
  "start-intent": { next: forward, branches: [
    b("S-RES-source", ["RES"], "completed", { pre: "current-source" }),
    b("S-RES-target", ["RES"], "completed", { pre: "current-target" }),
    b("S-RES-attest", ["RES"], "held", { pre: "attest-fault", message: "Runner artifact attestation failed after start", class: "transaction", pin: "retains start-intent when the actual CLI reports %s" }),
    b("S-RES-stale", ["RES"], "held", { pre: "state-differs", message: "Stopped state differs from verified snapshot; recover", class: "transaction" }),
    b("S-REC-ok", ["REC"], "restored", { pre: "snapshot-retained", pin: "records forward intent before independent boot at $phase $promote" }),
    refuse("S-REC-nosnap", ["REC"], "Snapshot is not retained", "integrity", { pre: "snapshot-unretained", pin: "refuses recovery from a snapshot not marked retained" }),
    b("S-RST-own", ["RST"], "restored", { pre: "snapshot-retained" }),
    prePrune("S-PRN"), ...preUpdates("S"),
    b("PS.guard-nested-intent", ["RES"], "held", { pre: "activity-window", message: M.activity, class: "transient", site: true }),
    b("PS.after-switch", ["RES"], "held", { pre: "activity-window", message: M.notStopped, class: "transient", site: true }),
    b("PS.post-start-active", ["RES"], "held", { pre: "no-start", message: "Runner did not become active with a positive MainPID", class: "transient", site: true, pin: "refuses unsafe post-start %s even when version succeeds" }),
    b("PS.post-start-binding", ["RES"], "held", { pre: "bad-live", message: "Running CODEX_HOME differs from requested home", class: "config", site: true }),
  ] },
  completed: { next: ["RST", "PRN", "RBK"], branches: terminal },
  failed: { next: ["REC", "RST", "PRN", "RBK"], branches: [
    b("F-RES", ["RES"], "noop"),
    b("F-REC-ok", ["REC"], "failed", { pre: "current-source" }),
    refuse("F-REC-moved", ["REC"], M.outside, "integrity", { pre: "current-moved" }),
    b("F-RST", ["RST"], "restored", { pre: "snapshot-retained", pin: "restores a terminal failed snapshot after later work and cancels back to its admission release" }),
    b("F-PRN", ["PRN"], "failed", { pre: "snapshot-retained" }),
    b("F-PRN-cleanup", ["PRN"], "failed", { pre: "cleanup-pending", pin: "keeps failed staging cleanup named and retries it without discarding state" }),
    b("F-UPD", ["UPD"], "noop", { pre: "copy-fault" }),
    ...terminal.filter(x => x.cmds.includes("RBK")),
  ] },
  "restore-prepared": { next: forward, branches: [
    b("R-RES-ok", ["RES"], "restored", { pre: "current-from" }),
    b("R-RES-fail", ["RES"], "held", { pre: "late-link", message: "Restore source link changed", class: "transaction" }),
    b("R-REC-cancel", ["REC"], "completed", { pre: "current-from", pin: "cancels an admitted restore before replacement and resumes its admission release" }),
    refuse("R-REC-moved", ["REC"], "Cancellation source link changed", "integrity", { pre: "current-source", pin: "refuses changed restore current before staging and source restart" }),
    refuse("R-RST", ["RST"], M.replacing, "transaction"),
    prePrune("R-PRN"), ...preUpdates("R"),
    b("PS.stage", ["RES"], "held", { pre: "activity-window", message: M.notStopped, class: "transient", site: true }),
    b("PS.replace-stopped", ["RES"], "held", { pre: "activity-window", final: "replace-intent", message: M.notStopped, class: "transient", site: true }),
    b("PS.replace-binding", ["RES"], "held", { pre: "activity-window", final: "replace-intent", message: M.activity, class: "transient", site: true }),
    b("PS.cancel-activity", ["REC"], "held", { pre: "activity-window", final: "completed", message: M.activity, class: "transient", site: true }),
    b("PS.catch-restore", ["RES"], "held", { pre: "activity-window", message: M.activity, class: "transient", site: true }),
  ] },
  "replace-intent": { next: forward, branches: [
    ...["L1", "L2", "L3", "L4"].map(l => b(`Q-${l}`, forward, "restored", { pre: `layout-${l}`, pin: "finishes after independent boot at $phase $from $credential $to $promote $when" })),
    refuse("Q-bad", forward, "Replacement state digest mismatch", "integrity", { pre: "staging-corrupt", pin: "preserves all objects when staging is corrupt %s" }),
    refuse("Q-cred", forward, "Credential must exist in exactly one location", "integrity", { pre: "credential-both", pin: "refuses %s credential locations before promotion without overwrite" }),
    refuse("Q-RST", ["RST"], M.replacing, "transaction"),
    prePrune("Q-PRN"), ...preUpdates("Q"),
  ] },
  restored: { next: ["RST", "PRN", "RBK"], branches: terminal },
};
if (Object.keys(TABLE).join() !== PHASES.join()) throw new Error("Recovery table rows differ from the record phases");

// Messages raised by two or more branches or guards with different classes.
export const SHARED_MESSAGES = {};

// Shell lines, by file and literal prefix: usage (exit 64) and plain
// messages need no record; a causal class needs a guard that raises it.
export const SHELL_REFUSALS = {
  "kaoiro-runner-update.sh": {
    "$1 needs a value": "usage",
    "repeated or conflicting recovery option": "usage",
    "$1 requires an absolute path": "usage",
    "--tarball needs a value": "usage",
    "--from-repo needs a value": "usage",
    "--install-dir needs a value": "usage",
    "--service needs a value": "usage",
    "--target needs a value": "usage",
    "--keep needs a value": "usage",
    "unknown argument: $1": "usage",
    "usage: $prog --tarball <path> | --from-repo <path>": "usage",
    "--tarball and --from-repo are mutually exclusive": "usage",
    "--target only applies with --from-repo": "usage",
    "resume/recover excludes forward and restore inputs": "usage",
    "restore requires --codex-home and excludes forward inputs": "usage",
    "--codex-home and --codex-backup-dir must be paired": "usage",
    "--keep must be a non-negative integer: $keep": "usage",
    "--keep must be at least 1": "usage",
    "systemd-run not found: $systemd_run_bin (--detach is Linux/systemd only)": "none",
    "failed to queue $UPDATE_UNIT.service — nothing was started, and nothing has changed": "none",
    "  journalctl --user -u %s.service -f\\n": "none",
    "  systemctl --user status %s.service\\n": "none",
    "$service does not launch through $root/current/ — install the release profile unit first (runner/README.md). ExecStart: ${exec_start:-<unreadable>}": "none",
    "not a kaoiro checkout: $builder is missing or not executable": "none",
    "%s: building a tarball from %s\\n": "none",
    "the build produced no tarball in $build_dir": "none",
    "the build produced more than one tarball in $build_dir": "none",
    "%s: installing %s\\n": "none",
    "%s: prepared release %s\\n": "none",
    "refusing to activate $id: only a clean 40-hex revision may become current — build from a clean tree, or pass --allow-dirty for a development host": "none",
    "%s: WARNING: external Codex-home writers are not inspected; snapshot recovery may fail and require fresh setup (docs/operations/codex-home.md)\\n": "none",
    "Codex restore preflight refused before stop; see docs/operations/runner-update-and-rollback.md#codex-state-backup": "none",
    "Codex backup preflight refused before stop; see docs/operations/runner-update-and-rollback.md#codex-state-backup": "none",
    "Cannot read the published transaction target": "none",
    "Target build format refused before stopping the runner": "none",
    "Codex pin transition requires an explicit state backup; see docs/operations/runner-update-and-rollback.md#codex-state-backup": "none",
    "%s: stopping %s\\n": "none",
    "%s: switch failed; restarting the previous release\\n": "none",
    "switch to $id failed; $service was restarted on the release it was already using": "none",
    "%s: starting %s\\n": "none",
    "%s: update did NOT reach a good state; roll back with:\\n": "none",
    "  %s --user stop %s\\n": "none",
    "  %s --rollback --install-dir %s\\n": "none",
    "  %s --user start %s\\n": "none",
    "current is $prune_current; expected releases/$id; release pruning skipped; a later update retries; see docs/operations/runner-update-and-rollback.md#recovery-table": "none",
    "Cannot determine retained Codex releases; see docs/operations/runner-update-and-rollback.md#recovery-table": "none",
    "%s: pruning release %s\\n": "none",
    "%s: %s is running release %s\\n": "none",
  },
  "kaoiro-runner-switch.sh": {
    "--install-dir needs a value": "usage",
    "--codex-transaction needs a value": "usage",
    "unknown option: $1": "usage",
    "more than one release id given": "usage",
    "no releases installed under $root": "none",
    "no such release: $_id (looked in $root/releases)": "none",
    "release directory $_id carries identity $KAOIRO_VERIFIED_IDENTITY — refusing to activate a name that does not match its contents": "none",
    "production activation requires a completed landing or release tag; --allow-dirty is development only": "none",
    "Codex state activation refused": "none",
    "%s: current already points at %s\\n": "none",
    "%s: current -> releases/%s\\n": "none",
    "--rollback takes no release id": "usage",
    "no previous release recorded under $root": "none",
    "previous does not point into releases/: $prev": "none",
    "previous points at an unusable release id: $prev_id": "none",
    "previous release is gone: $prev_target": "none",
    "previous release directory $prev_id carries identity $KAOIRO_VERIFIED_IDENTITY — refusing to roll back onto a name that does not match its contents": "none",
    "Codex state rollback refused; use the state-aware updater; see docs/operations/runner-update-and-rollback.md#codex-state-backup": "none",
    "%s: rolled back, current -> %s\\n": "none",
    "usage: $prog <release-id> | --rollback [--install-dir <dir>]": "usage",
    "unusable release id: $id": "usage",
    "refusing to activate $id: only a clean 40-hex revision may become current — pass --allow-dirty for a development host": "none",
  },
  "kaoiro-runner-install.sh": {
    "--install-dir needs a value": "usage",
    "unknown option: $1": "usage",
    "more than one tarball given": "usage",
    "usage: $prog <tarball> [--install-dir <dir>] [--allow-dirty]": "usage",
    "tarball not found: $tarball": "none",
    "tar not found in PATH": "none",
    "%s: extracting %s\\n": "none",
    "archive is empty: $tarball": "none",
    "archive has more than one top-level entry: $tarball": "none",
    "archive's top-level entry is a symlink, not a directory: $tarball": "none",
    "archive's top-level entry is not a directory: $tarball": "none",
    "release carries an unusable identity: $id": "none",
    "release $id is already installed but carries identity $KAOIRO_VERIFIED_IDENTITY — refusing to guess; remove it by hand after checking what uses it": "none",
    "%s: release %s is already installed and verified, keeping it\\n": "none",
    "release $id is already installed and its id does not identify its content — pass --allow-dirty to replace it (development only)": "none",
    "Cannot determine retained Codex releases; see docs/operations/runner-update-and-rollback.md#recovery-table": "none",
    "release is protected by a Codex backup; see docs/operations/runner-update-and-rollback.md#prune-and-owned-staging-cleanup": "none",
    "refusing to replace release $id: $link points at it": "none",
    "%s: replacing installed release %s\\n": "none",
    "%s: installed %s\\n": "none",
  },
  "kaoiro-runner-common.sh": {
    "%s: %s\\n": "none",
    "HOME is unset; pass --install-dir or set KAOIRO_RUNNER_INSTALL_DIR": "none",
    "HOME is unset; set KAOIRO_RUNNER_DIR": "none",
    "%s: another run holds %s\\n": "lock",
    "%s: inspect that worker before removing a stale lock dir\\n": "none",
    "%s: see: docs/operations/runner-update-and-rollback.md#stale-operation-locks\\n": "none",
    "node not found: $node_bin (set KAOIRO_NODE)": "none",
    "%s\\n": "none",
    "$1 must not begin with '-': $2": "usage",
    "%s: removing abandoned staging dir %s\\n": "none",
    "release tree failed verification: $_tree": "none",
    "release tree is incomplete: deploy/kaoiro-runner-launch.sh missing or not executable in $_tree": "none",
  },
};

// throw statements that pass an error through unchanged, and imports the
// scan cannot follow; each has a codex-recovery-rethrow marker.
export const RETHROWS = {
  "lock-create": "withLock passes a mkdir failure other than EEXIST through",
  "source-cleanup": "returnSource rethrows the staging cleanup failure after the source restart",
  "stop-status": "stopRunner keeps the service manager's exit status on the error",
  "run-failure": "run() rethrows the original failure after its settle attempts",
  "next-read": "next passes every failure except an old-record barrier through",
  "sdk-require": "resolving the release's own Codex SDK runs release code",
  "sdk-import": "importing the release's own Codex SDK runs release code",
  "lstat-type": "an unusual lstat errno is passed through unchanged",
  "anomaly-forward": "walkAncestors reports each anomaly through fail()",
  "runtime-require": "resolving the release's runtime closure runs release code",
  "verify-cli": "the command-line wrapper passes unexpected errors through",
  "lstat": "hasEntry passes an lstat failure other than ENOENT through",
  "service-manager": "systemctl rethrows its normalized service-manager failure",
};

// Every literal message (or template prefix) the helper's static import
// closure can throw, and the files that throw it.
export const REFUSALS = {
  "${} declares the runtime asset ${} as an absolute path": { files: ["verify-release.mjs"] },
  "${} declares the runtime asset ${}, which is not a regular file": { files: ["verify-release.mjs"] },
  "${} declares the runtime asset ${}, which resolves outside the release: ${}": { files: ["verify-release.mjs"] },
  "${} declares the runtime asset ${}, which this release does not contain: ${}": { files: ["verify-release.mjs"] },
  "${} does not match its MANIFEST.json sha256": { files: ["verify-release.mjs"] },
  "${} does not parse as JavaScript: ${}": { files: ["verify-release.mjs"] },
  "${} has a malformed kaoiro.runtimeAssets (expected an array of strings)": { files: ["verify-release.mjs"] },
  "${} has no relative ESM import entry": { files: ["verify-release.mjs"] },
  "${} imports ${}, which this release does not contain": { files: ["verify-release.mjs"] },
  "${} imports ${}, whose target ${} this release does not contain": { files: ["verify-release.mjs"] },
  "${} is a broken symlink: ${}": { files: ["verify-release.mjs"] },
  "${} is missing or unresolvable: ${}": { files: ["verify-release.mjs"] },
  "${} is missing — the workspace dependency link was never created (pnpm install has not run)": { files: ["verify-release.mjs"] },
  "${} is not a directory: ${}": { files: ["verify-release.mjs"] },
  "${} is not an ordinary file: ${}": { files: ["verify-release.mjs"] },
  "${} is not resolvable from @kaoiro/codex": { files: ["verify-release.mjs"] },
  "${} is not resolvable: ${}": { files: ["verify-release.mjs"] },
  "${} is present but unreadable: ${}": { files: ["verify-release.mjs"] },
  "${} is unreachable: ${}": { files: ["verify-release.mjs"] },
  "${} is unreadable: ${}": { files: ["verify-release.mjs"] },
  "${} resolves outside the release: ${}": { files: ["verify-release.mjs"] },
  "${}'s package.json is not an ordinary file: ${}": { files: ["verify-release.mjs"] },
  "${}'s package.json is unreadable or malformed: ${}": { files: ["verify-release.mjs"] },
  "${}'s package.json is unreadable: ${}": { files: ["verify-release.mjs"] },
  "${}/package.json is missing, unreadable or malformed: ${}": { files: ["verify-release.mjs"] },
  "@kaoiro/codex must declare an exact @openai/codex version": { files: ["verify-release.mjs"] },
  "@kaoiro/codex package.json is unreadable or malformed: ${}": { files: ["verify-release.mjs"] },
  "@openai/codex is not resolvable from @kaoiro/codex: ${}": { files: ["verify-release.mjs"] },
  "@openai/codex package.json is unreadable or malformed: ${}": { files: ["verify-release.mjs"] },
  "@openai/codex version ${} does not match @kaoiro/codex exact dependency ${}": { files: ["verify-release.mjs"] },
  "A retained v2 snapshot forbids activating a pre-N2 tool": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Ambiguous Codex native candidates": { files: ["codex-native.mjs"] },
  "Ambiguous Codex state capability": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Ambiguous running ${}": { files: ["codex-service.mjs"] },
  "Backup destination must be new and canonical": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Cancellation source link changed": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Cannot establish launch-user HOME": { files: ["codex-service.mjs"] },
  "Cannot establish running HOME": { files: ["codex-service.mjs"] },
  "Cannot read required service-manager state": { files: ["codex-service.mjs"] },
  "Codex SDK is missing": { files: ["codex-native.mjs"] },
  "Codex backend native paths disagree": { files: ["codex-native.mjs"] },
  "Codex native path is not executable": { files: ["codex-native.mjs"] },
  "Codex native pin differs: use state-aware backup/restore": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Codex runtime resolves outside its release": { files: ["codex-native.mjs"] },
  "Credential location mismatch before promotion": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Credential must exist in exactly one location": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Credential remains in aside before promotion": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Credential symlink is unsupported": { files: ["codex-snapshot.mjs"] },
  "Current differs from startup target": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Current is outside recorded operation": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Directory must be private and owned by the operator": { files: ["codex-snapshot.mjs"] },
  "Directory must use its original canonical absolute path": { files: ["codex-snapshot.mjs"] },
  "External database/session storage is unsupported": { files: ["codex-snapshot.mjs"] },
  "Foreign-owned home entry": { files: ["codex-snapshot.mjs"] },
  "Forward is not ready for switching": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Forward snapshot requires a running source runner": { files: ["codex-service.mjs"] },
  "Hard-linked home entry is unsupported": { files: ["codex-snapshot.mjs"] },
  "Historical terminal record cannot authorize a switch": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Home must use its canonical absolute path": { files: ["codex-service.mjs"] },
  "Inconsistent home/staging/aside layout; preserve objects for manual repair": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Installed unit must use KillMode=control-group": { files: ["codex-service.mjs"] },
  "Insufficient snapshot/restore disk capacity": { files: ["codex-snapshot.mjs"] },
  "Insufficient snapshot/restore inodes": { files: ["codex-snapshot.mjs"] },
  "Invalid credential entry": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Invalid current release link": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Invalid development activation option": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Invalid private state record: ${}": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Invalid protected operation release: ${}": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Invalid protected source: ${}": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Invalid protected tool: ${}": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Invalid release identity": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Invalid snapshot relative path": { files: ["codex-snapshot.mjs"] },
  "Invalid snapshot staging ownership": { files: ["codex-snapshot.mjs"] },
  "Invalid state identity: ${}": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Invalid transaction UUID": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Lock held: ${}": { files: ["kaoiro-runner-codex-state.mjs"] },
  "MANIFEST.json does not match the expected { files: {...} } shape": { files: ["verify-release.mjs"] },
  "MANIFEST.json has a malformed sha256 for ${}": { files: ["verify-release.mjs"] },
  "MANIFEST.json is missing (not a release built by the builder)": { files: ["verify-release.mjs"] },
  "MANIFEST.json is missing from a built release (VERSION is present) — reinstall it; only a repo-direct checkout, which has no VERSION either, may start without one": { files: ["verify-release.mjs"] },
  "MANIFEST.json is not valid JSON: ${}": { files: ["verify-release.mjs"] },
  "MANIFEST.json lists no files": { files: ["verify-release.mjs"] },
  "MANIFEST.json omits ${}, which @kaoiro/codex resolves at runtime": { files: ["verify-release.mjs"] },
  "MANIFEST.json omits ${}, which the package graph says this release must carry": { files: ["verify-release.mjs"] },
  "MANIFEST.json omits required deploy/${}": { files: ["verify-release.mjs"] },
  "Malformed aside entry": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Malformed aside list": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Malformed cleanup ownership": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Malformed prune ownership": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Malformed replacement checkpoints": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Malformed replacement identity": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Malformed replacement paths": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Malformed replacement state": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Malformed selected home": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Malformed selected release identities": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Malformed selected service": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Malformed snapshot manifest": { files: ["codex-snapshot.mjs"] },
  "Malformed snapshot manifest hash": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Malformed snapshot path": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Next launch CODEX_HOME differs from requested home": { files: ["codex-service.mjs"] },
  "No unique retained snapshot matches selection": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Owned staging cleanup remains pending: ${}: ${}": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Phase changed during stop": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Pre-start source link changed": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Prune requires a terminal operation": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Published restore home requires its source release": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Recorded native release changed": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Recovery message has conflicting classes: ${}": { files: ["codex-state-recovery.mjs"] },
  "Recovery table rows differ from the record phases": { files: ["codex-state-recovery.mjs"] },
  "Release directory identity mismatch": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Replacement aside is not recorded": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Replacement is already unfinished": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Replacement staging changed": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Replacement state digest mismatch": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Resolve old Codex state records with the previous tool release: ${}": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Restore directories must be siblings": { files: ["codex-snapshot.mjs"] },
  "Restore home and staging must share one filesystem": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Restore home/service differs from selected record": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Restore quarantine already exists": { files: ["codex-snapshot.mjs"] },
  "Restore source link changed": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Restore source link changed before restart": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Restore staging mismatch": { files: ["codex-snapshot.mjs"] },
  "Restore start intent is missing": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Runner activity is transitional or unknown": { files: ["codex-service.mjs"] },
  "Runner artifact attestation failed after start": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Runner changed during home read": { files: ["codex-service.mjs"] },
  "Runner descendants remain": { files: ["codex-service.mjs"] },
  "Runner did not become active with a positive MainPID": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Runner is not fully stopped": { files: ["codex-service.mjs"] },
  "Running CODEX_HOME differs from requested home": { files: ["codex-service.mjs"] },
  "Selected installed service differs from record": { files: ["codex-service.mjs"] },
  "Snapshot UUID/home differs from record": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Snapshot belongs to a different home": { files: ["codex-snapshot.mjs"] },
  "Snapshot contains excluded entries": { files: ["codex-snapshot.mjs"] },
  "Snapshot copy differs from source": { files: ["codex-snapshot.mjs"] },
  "Snapshot destination must be new and canonical": { files: ["codex-snapshot.mjs"] },
  "Snapshot is not retained": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Snapshot manifest digest mismatch": { files: ["codex-snapshot.mjs"] },
  "Snapshot overlaps Codex home": { files: ["codex-snapshot.mjs"] },
  "Snapshot overlaps protected state/releases": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Snapshot payload mismatch": { files: ["codex-snapshot.mjs"] },
  "Snapshot release binding differs from record": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Snapshot root identity changed during prune": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Snapshot staging path is not its own": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Source changed during snapshot": { files: ["codex-snapshot.mjs"] },
  "Source link changed before recovery": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Source must be selected before home promotion": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Source return phase changed before restart": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Startup phase changed after switch": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Startup phase changed during service operation": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Startup release changed during service operation": { files: ["kaoiro-runner-codex-state.mjs"] },
  "State-aware operation requires unified cgroup v2": { files: ["codex-service.mjs"] },
  "State-aware operations require explicit next-start CODEX_HOME": { files: ["codex-service.mjs"] },
  "State-aware updates require Linux systemd": { files: ["codex-service.mjs"] },
  "State-aware updates require an installed persistent unit": { files: ["codex-service.mjs"] },
  "Stopped state differs from verified snapshot; recover": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Stopped state differs from verified snapshot; recover and take a new snapshot": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Switch did not reach recorded target": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Transaction requires an existing release": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Transaction target differs": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Unclassifiable phase/retention: ${}": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Unclassified Codex home entry: ${}": { files: ["codex-snapshot.mjs"] },
  "Undefined runner.env path expansion": { files: ["codex-service.mjs"] },
  "Unexpected credential during replacement": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Unexpected snapshot entry": { files: ["codex-snapshot.mjs"] },
  "Unknown Codex operation mode": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Unknown Codex state action": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Unknown state record filename: ${}": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Unreadable state record: ${}": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Unrenderable recovery command: ${}": { files: ["codex-state-recovery.mjs"] },
  "Unresolved Codex transaction requires recovery: ${}": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Unsafe cleanup entry": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Unsafe cleanup root": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Unsupported Codex activation platform": { files: ["codex-native.mjs"] },
  "Unsupported SDK import entry": { files: ["codex-native.mjs"] },
  "Unsupported SDK native resolver interface": { files: ["codex-native.mjs"] },
  "Unsupported environment escaping": { files: ["codex-service.mjs"] },
  "Unsupported installed unit property: ${}": { files: ["codex-service.mjs"] },
  "Unsupported relevant unit environment expansion": { files: ["codex-service.mjs"] },
  "Unsupported runner ExecStart": { files: ["codex-service.mjs"] },
  "Unsupported runner.env expansion": { files: ["codex-service.mjs"] },
  "Unsupported runner.env expression": { files: ["codex-service.mjs"] },
  "Unsupported runner.env quoting": { files: ["codex-service.mjs"] },
  "Unsupported runner.env shell syntax": { files: ["codex-service.mjs"] },
  "Unsupported runner.env value": { files: ["codex-service.mjs"] },
  "Unsupported snapshot manifest": { files: ["codex-snapshot.mjs"] },
  "Unsupported special entry in Codex home": { files: ["codex-snapshot.mjs"] },
  "Unsupported unit environment assignment": { files: ["codex-service.mjs"] },
  "Unsupported unit identity": { files: ["codex-service.mjs"] },
  "Unterminated environment quote": { files: ["codex-service.mjs"] },
  "Update to an N2 release with the same native first": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Use never-started source recovery": { files: ["kaoiro-runner-codex-state.mjs"] },
  "Use the recorded physical updater tool": { files: ["kaoiro-runner-codex-state.mjs"] },
  "VERSION (${}) disagrees with dist/build-info.json (${})": { files: ["verify-release.mjs"] },
  "closure re-derivation needs `node --experimental-vm-modules` (vm.SourceTextModule is unavailable) — the verifier was launched without it": { files: ["verify-release.mjs"] },
  "dist/build-info.json does not match the build-identity shape": { files: ["verify-release.mjs"] },
  "dist/build-info.json is not valid JSON: ${}": { files: ["verify-release.mjs"] },
  "dist/build-info.json is unreadable: ${}": { files: ["verify-release.mjs"] },
  "release is missing its entry point ${}: ${}": { files: ["verify-release.mjs"] },
  "release root is a symlink, not a directory": { files: ["verify-release.mjs"] },
  "release root is not a directory": { files: ["verify-release.mjs"] },
  "release root is unreadable: ${}": { files: ["verify-release.mjs"] },
  "runner.env must be a private owned file": { files: ["codex-service.mjs"] },
  "runner.env path must be absolute": { files: ["codex-service.mjs"] },
  "runner.env requires literal assignments only": { files: ["codex-service.mjs"] },
  "runner.env symlinks are unsupported for state updates": { files: ["codex-service.mjs"] },
  "unknown child environment profile": { files: ["child-process-environment.mjs"] },
  "unprepared child environment refused": { files: ["child-process-environment.mjs"] }
};

export function branches() {
  const seen = new Set();
  return PHASES.flatMap(phase => TABLE[phase].branches.filter(x => !seen.has(x) && seen.add(x)).map(x => ({ ...x, phase })));
}

export function classes() {
  const found = new Map();
  for (const entry of [...GUARDS.flatMap(g => g.messages.map(message => ({ message, class: g.class }))), ...branches().filter(x => x.message)]) {
    if (!found.has(entry.message)) found.set(entry.message, new Set());
    found.get(entry.message).add(entry.class);
  }
  const result = new Map();
  for (const [message, set] of found) {
    if (set.size === 1) result.set(message, [...set][0]);
    else if (SHARED_MESSAGES[message]) result.set(message, SHARED_MESSAGES[message].class);
    else throw new Error(`Recovery message has conflicting classes: ${message}`);
  }
  return result;
}

// A template key writes each substitution as ${}.
export const keyPattern = key => new RegExp(`^${key.split("${}").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*")}$`);
export function classify(message) {
  const known = classes();
  if (known.has(message)) return known.get(message);
  let match;
  for (const key of known.keys()) if (key.includes("${}") && keyPattern(key).test(message) && (!match || key.length > match.length)) match = key;
  return match ? known.get(match) : "unclassified";
}

export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// RES and REC must run from the record's physical tool (G1); the other
// commands use the tool that renders them, because a terminal record's tool
// release is not protected from pruning.
export function argv(key, tx, { root, deploy, interpreter = process.execPath }) {
  const recorded = join(root, "releases", tx.tool, "deploy");
  if (key === "RES" || key === "REC") return [join(recorded, "kaoiro-runner-update.sh"), "--install-dir", root, `--${LABELS[key]}-codex-transaction`, tx.uuid];
  if (key === "RST") return [join(deploy, "kaoiro-runner-update.sh"), "--install-dir", root, "--service", tx.service, "--restore-codex-backup", tx.snapshot.path, "--codex-home", tx.home];
  if (key === "PRN") return [interpreter, join(deploy, "kaoiro-runner-codex-state.mjs"), "prune", root, tx.uuid];
  if (key === "RBK") return [join(deploy, "kaoiro-runner-switch.sh"), "--rollback", "--install-dir", root];
  throw new Error(`Unrenderable recovery command: ${key}`);
}

export function entries(tx) {
  const retained = ["retained", "prune-intent"].includes(tx.snapshot?.status);
  return TABLE[tx.phase].next.filter(key => key === "RST" ? tx.snapshot.status === "retained" : key === "PRN" ? retained || tx.cleanup?.pending === true : true);
}

export function rowLines(tx, context, keys = entries(tx)) {
  return keys.map(key => `next (${LABELS[key]}): ${argv(key, tx, context).map(quote).join(" ")}`);
}

const ADVICE = {
  transaction: [],
  config: [`see: ${ANCHORS.config}`],
  integrity: ["preserve every named object (home, snapshot, staging and asides) for manual repair", `see: ${ANCHORS.integrity}`],
  transient: ["the service state was transitional; rerun the same command"],
  lock: [`see: ${ANCHORS.lock}`],
  cutover: [`see: ${ANCHORS.cutover}`],
  usage: [],
  none: [],
  unclassified: [`see: ${ANCHORS.table}`],
};

// Lines printed after a refusal's message. `row` asks for the record's next
// lines whatever the class (failures inside a run); `report` is the output of
// `next <root>` for the lock class.
export function render(cls, { tx, row = false, report = [], ...context } = {}) {
  const own = tx && (row || ["transaction", "transient", "unclassified"].includes(cls)) ? rowLines(tx, context) : [];
  return [...own, ...ADVICE[cls], ...(cls === "lock" ? report : [])];
}

export function runbook() {
  const lines = ["| Phase | Command | Branch | Precondition | Outcome | Class |", "|---|---|---|---|---|---|"];
  for (const x of branches()) {
    const phases = PHASES.filter(p => TABLE[p].branches.some(y => y.id === x.id)).map(p => `\`${p}\``).join(", ");
    const outcome = x.guard ? `refuse (${x.guard})` : x.final ? `${x.outcome} (${x.final})` : x.outcome;
    lines.push(`| ${phases} | ${x.cmds.join(", ")} | ${x.id} | ${x.pre || "—"} | ${outcome} | ${x.class || "—"} |`);
  }
  lines.push("", "| Site | Class | Message |", "|---|---|---|");
  for (const g of GUARDS) lines.push(`| ${g.id} | ${g.class} | ${g.messages.map(m => `"${m.trim()}"`).join("; ")} |`);
  lines.push("", "| Phase | `next` lines |", "|---|---|");
  for (const p of PHASES) lines.push(`| \`${p}\` | ${TABLE[p].next.map(k => LABELS[k]).join(", ")} |`);
  return lines.join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename) && process.argv[2] === "--runbook") console.log(runbook());
