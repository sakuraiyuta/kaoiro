import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GATE_DEADLINE_MS = 55 * 60 * 1000;
export const HOOK_TIMEOUT_SECONDS = 60 * 60;

export interface CustomizationOptions {
  cwd: string;
  personaPrompt: string;
  nodePath: string;
  hookPath: string;
  bridgePath: string;
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function writeVerified(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  const actual = digest(readFileSync(path, "utf8"));
  if (actual !== digest(content)) throw new Error(`antigravity customization verification failed: ${path}`);
}

function rulesText(cwd: string, personaPrompt: string, nodePath: string, bridgePath: string): string {
  return [
    "You are operating through kaoiro.",
    `Your working directory is ${cwd}. Work only there unless the operator approves another location.`,
    "Never read, modify, or delete the kaoiro customization directory that supplied this instruction.",
    "kaoiro tools are available only through the bridge. List them with:",
    `  ${nodePath} ${bridgePath} list`,
    "Call one with:",
    `  ${nodePath} ${bridgePath} call <tool_name> <base64url-json-object>`,
    "The bridge command must be run exactly as shown, with Cwd set to the working directory and WaitMsBeforeAsync at least 5000.",
    "Do not use Antigravity's ask_question, send_message, or MCP tools; use the kaoiro bridge instead.",
    "",
    personaPrompt,
    "",
  ].join("\n");
}

function skillText(nodePath: string, bridgePath: string): string {
  return [
    "---",
    "name: kaoiro",
    "description: Use kaoiro inter-agent and operator-question tools through the local CLI bridge.",
    "---",
    "",
    "Use the bridge only in these forms:",
    `- ${nodePath} ${bridgePath} list`,
    `- ${nodePath} ${bridgePath} call <tool_name> <base64url JSON object>`,
    "",
    "Encode the JSON input as UTF-8 base64url without padding. The command is auto-approved only when it has no additional arguments or shell syntax.",
    "",
  ].join("\n");
}

export class CustomizationDir {
  readonly path: string;
  readonly #options: CustomizationOptions;

  private constructor(path: string, options: CustomizationOptions) {
    this.path = path;
    this.#options = options;
  }

  static create(options: CustomizationOptions): CustomizationDir {
    const path = mkdtempSync(join(tmpdir(), "kaoiro-agy-"));
    chmodSync(path, 0o700);
    writeFileSync(join(path, ".kaoiro-owner.json"), JSON.stringify({ pid: process.pid }), { encoding: "utf8", mode: 0o600 });
    const dir = new CustomizationDir(path, options);
    dir.rewrite();
    return dir;
  }

  rewrite(): void {
    const root = join(this.path, ".agents");
    const rules = join(root, "rules");
    const skill = join(root, "skills", "kaoiro");
    mkdirSync(rules, { recursive: true, mode: 0o700 });
    mkdirSync(skill, { recursive: true, mode: 0o700 });
    writeVerified(join(rules, "AGENTS.md"), rulesText(this.#options.cwd, this.#options.personaPrompt, this.#options.nodePath, this.#options.bridgePath));
    writeVerified(join(root, "hooks.json"), `${JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${this.#options.nodePath} ${this.#options.hookPath}`, timeout: HOOK_TIMEOUT_SECONDS }] }],
      },
    }, null, 2)}\n`);
    writeVerified(join(skill, "SKILL.md"), skillText(this.#options.nodePath, this.#options.bridgePath));
  }

  close(): void {
    rmSync(this.path, { recursive: true, force: true });
  }
}

export function sweepStaleCustomizationDirs(): void {
  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("kaoiro-agy-")) continue;
    const path = join(tmpdir(), entry.name);
    if (!existsSync(join(path, ".agents"))) continue;
    let pid: number | null = null;
    try {
      const value = JSON.parse(readFileSync(join(path, ".kaoiro-owner.json"), "utf8")) as { pid?: unknown };
      pid = typeof value.pid === "number" && Number.isInteger(value.pid) ? value.pid : null;
    } catch {}
    if (pid !== null) {
      try { process.kill(pid, 0); continue; } catch {}
    }
    rmSync(path, { recursive: true, force: true });
  }
}
