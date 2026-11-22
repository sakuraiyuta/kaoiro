import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravitySubcommandPrefix } from "./subcommand.js";

export const GATE_DEADLINE_MS = 55 * 60 * 1000;
export const HOOK_TIMEOUT_SECONDS = 60 * 60;
/** The vendor's default; a Stop hook that times out ends the loop. */
export const STOP_HOOK_TIMEOUT_SECONDS = 30;
export const CUSTOMIZATION_OWNER_NAMESPACE = "kaoiro-antigravity";

export interface CustomizationOptions {
  nodePath: string;
  nodeArgs?: readonly string[] | undefined;
  entryPath: string;
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function writeVerified(path: string, content: string): string {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  const actual = digest(readFileSync(path, "utf8"));
  if (actual !== digest(content)) throw new Error(`antigravity customization verification failed: ${path}`);
  return actual;
}

/** The hook registrations `agy -p /hooks` must list for this directory. */
export interface ExpectedHooks {
  source: string;
  command: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks the structured hook list of the launch's own arguments: exactly the
 *  managed PreToolUse and Stop registrations, and no other enabled Stop
 *  action, since `agy` follows another Stop's continue over ours. */
export function checkHookList(value: unknown, expected: ExpectedHooks): { ok: true } | { ok: false; reason: string } {
  const groups: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.source === "string" && Array.isArray(node.actions)) groups.push(node);
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  const managed = groups.filter((group) => group.source === expected.source);
  if (managed.length !== 1 || managed[0]!.enabled === false) return { ok: false, reason: "registration_mismatch" };
  const actions = (managed[0]!.actions as unknown[]).filter(isRecord);
  const pre = actions.filter((action) => action.event === "PreToolUse");
  const stop = actions.filter((action) => action.event === "Stop");
  if (
    actions.length !== 2 ||
    pre.length !== 1 ||
    stop.length !== 1 ||
    pre[0]!.matcher !== "*" ||
    pre[0]!.command !== expected.command ||
    pre[0]!.timeout_seconds !== HOOK_TIMEOUT_SECONDS ||
    stop[0]!.command !== expected.command ||
    stop[0]!.timeout_seconds !== STOP_HOOK_TIMEOUT_SECONDS
  ) {
    return { ok: false, reason: "registration_mismatch" };
  }
  for (const group of groups) {
    if (group === managed[0] || group.enabled === false) continue;
    if ((group.actions as unknown[]).some((action) => isRecord(action) && action.event === "Stop")) {
      return { ok: false, reason: `foreign_stop_hook:${String(group.source)}` };
    }
  }
  return { ok: true };
}

export class CustomizationDir {
  readonly path: string;
  readonly #options: CustomizationOptions;
  readonly #hashes = new Map<string, string>();

  private constructor(path: string, options: CustomizationOptions) {
    this.path = path;
    this.#options = options;
  }

  static create(options: CustomizationOptions): CustomizationDir {
    const path = mkdtempSync(join(tmpdir(), "kaoiro-agy-"));
    chmodSync(path, 0o700);
    writeFileSync(join(path, ".kaoiro-owner.json"), JSON.stringify({
      namespace: CUSTOMIZATION_OWNER_NAMESPACE,
      uid: process.getuid?.(),
      pid: process.pid,
    }), { encoding: "utf8", mode: 0o600 });
    const dir = new CustomizationDir(path, options);
    dir.rewrite();
    return dir;
  }

  rewrite(): void {
    const root = join(this.path, ".agents");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const command = antigravitySubcommandPrefix({
      nodePath: this.#options.nodePath,
      ...(this.#options.nodeArgs === undefined ? {} : { nodeArgs: this.#options.nodeArgs }),
      entryPath: this.#options.entryPath,
      subcommand: "hook",
    });
    const hooks = `${JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] }],
        Stop: [{ type: "command", command, timeout: STOP_HOOK_TIMEOUT_SECONDS }],
      },
    }, null, 2)}\n`;
    const path = join(root, "hooks.json");
    this.#hashes.clear();
    this.#hashes.set(path, writeVerified(path, hooks));
  }

  verify(): boolean {
    try {
      for (const [path, expected] of this.#hashes) {
        if (digest(readFileSync(path, "utf8")) !== expected) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    rmSync(this.path, { recursive: true, force: true });
  }
}

export interface StaleSweepOptions {
  baseDir?: string;
  uid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sweepStaleCustomizationDirs(options: StaleSweepOptions = {}): void {
  const baseDir = options.baseDir ?? tmpdir();
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("kaoiro-agy-")) continue;
    const path = join(baseDir, entry.name);
    try {
      const marker = JSON.parse(readFileSync(join(path, ".kaoiro-owner.json"), "utf8")) as Record<string, unknown>;
      const pid = typeof marker.pid === "number" && Number.isSafeInteger(marker.pid) && marker.pid > 0 ? marker.pid : null;
      if (marker.namespace !== CUSTOMIZATION_OWNER_NAMESPACE || marker.uid !== uid || pid === null) continue;
      if ((options.isProcessAlive ?? processIsAlive)(pid)) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      // A foreign, unreadable, or concurrently removed directory has no deletion permit.
    }
  }
}
