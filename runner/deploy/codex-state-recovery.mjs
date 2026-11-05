import { join } from "node:path";

export const PHASES = ["prepared", "snapshot-verified", "start-intent", "completed", "failed", "restore-prepared", "replace-intent", "restored"];
export const LABELS = { RES: "resume", REC: "recover", RST: "restore", PRN: "prune", RBK: "rollback" };
const RUNBOOK = "docs/operations/runner-update-and-rollback.md";
export const ANCHORS = {
  backup: `${RUNBOOK}#codex-state-backup`,
  table: `${RUNBOOK}#recovery-table`,
  lock: `${RUNBOOK}#stale-operation-locks`,
  cutover: `${RUNBOOK}#old-records-and-barriers`,
};
const NEXT = {
  prepared: ["RES", "REC"],
  "snapshot-verified": ["RES", "REC"],
  "start-intent": ["RES", "REC"],
  completed: ["RST", "PRN", "RBK"],
  failed: ["REC", "RST", "PRN", "RBK"],
  "restore-prepared": ["RES", "REC"],
  "replace-intent": ["RES", "REC"],
  restored: ["RST", "PRN", "RBK"],
};
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
  return NEXT[tx.phase].filter(key => key === "RST" ? tx.snapshot.status === "retained" : key === "PRN" ? retained || tx.cleanup?.pending === true : true);
}

export function rowLines(tx, context, keys = entries(tx)) {
  return keys.map(key => `next (${LABELS[key]}): ${argv(key, tx, context).map(quote).join(" ")}`);
}
