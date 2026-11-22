import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  PermissionBroker,
  type PermissionDecision,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import { effectiveNetworkAccess } from "./network_access.js";

export type AntigravityLaunchConfig = WrapperConfig & {
  approval?: "untrusted" | "on-request" | "local" | "on-failure" | "never";
};

export type AntigravityToolClass =
  | "read"
  | "write"
  | "shell"
  | "network"
  | "subagent"
  | "agent-internal";

export type GateDecision =
  | { decision: "allow"; reason?: string }
  | { decision: "deny"; reason: string }
  | { decision: "ask" };

export interface HookToolCall {
  name: string;
  args: Record<string, unknown>;
}

const classes: Readonly<Record<AntigravityToolClass, readonly string[]>> = {
  read: [
    "view_file", "read_file", "list_dir", "grep_search", "find_by_name", "command_status",
    "list_permissions", "manage_task", "wait", "wait_5_seconds", "finish",
  ],
  write: [
    "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit",
    "write_file", "edit_file",
  ],
  shell: ["run_command", "send_command_input", "notebook_execution"],
  network: [
    "read_url_content", "search_web", "open_browser_url", "generate_image", "read_browser_page",
    "list_browser_pages", "browser_click_element", "browser_drag_pixel_to_pixel", "browser_get_dom",
    "browser_get_network_request", "browser_input", "browser_list_network_requests", "browser_mouse_down",
    "browser_mouse_up", "browser_move_mouse", "browser_press_key", "browser_refresh_page",
    "browser_resize_window", "browser_scroll", "browser_scroll_dom", "browser_select_option",
    "capture_browser_console_logs", "capture_browser_screenshot", "click_browser_pixel", "search_marketplace",
    "execute_browser_javascript", "browser_subagent",
  ],
  subagent: ["define_subagent", "invoke_subagent", "manage_subagents"],
  "agent-internal": [
    "ask_question", "ask_permission", "ask_custom_permission", "schedule", "send_message",
    "manage_inbox", "delete_knowledge", "call_mcp_tool", "list_resources", "read_resource",
    "list_plugin_accounts", "run_workflow",
  ],
};

export const TOOL_CLASS_BY_NAME: ReadonlyMap<string, AntigravityToolClass> = new Map(
  Object.entries(classes).flatMap(([toolClass, names]) =>
    names.map((name) => [name, toolClass as AntigravityToolClass] as const),
  ),
);

const PATH_ARGUMENT_KEYS = new Set(["AbsolutePath", "DirectoryPath", "TargetFile", "Cwd", "Path"]);
const READ_FILE_ARGUMENT_KEYS = new Set(["Path", "StartLine", "EndLine", "ByteOffset"]);
const WRITE_TARGET_KEYS: Readonly<Record<string, readonly string[]>> = {
  write_to_file: ["TargetFile", "AbsolutePath"],
  replace_file_content: ["TargetFile", "AbsolutePath"],
  multi_replace_file_content: ["TargetFile", "AbsolutePath"],
  sed_file: ["TargetFile", "AbsolutePath"],
  notebook_edit: ["TargetFile", "AbsolutePath"],
  write_file: ["Path"],
  edit_file: ["Path"],
};
const LOCAL_COMMAND_TOKEN = /^[A-Za-z0-9_./:@%+=,~-]+$/;
const REMOTE_GIT_SUBCOMMANDS = new Set([
  "clone", "fetch", "ls-remote", "pull", "push", "remote", "submodule",
]);
const DESTRUCTIVE_OR_COMMAND_GIT_SUBCOMMANDS = new Set([
  "checkout", "clean", "commit", "config", "filter-branch", "gc", "merge",
  "prune", "rebase", "reflog", "replace", "reset", "restore", "switch",
  "update-ref",
]);
const LOCAL_GIT_SUBCOMMANDS = new Set([
  "add", "branch", "cat-file", "commit", "describe", "diff", "log", "ls-files",
  "ls-tree", "merge", "rev-parse", "show", "status", "tag", "worktree",
  ...REMOTE_GIT_SUBCOMMANDS,
  ...DESTRUCTIVE_OR_COMMAND_GIT_SUBCOMMANDS,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validReadFileArguments(args: unknown): boolean {
  if (!isRecord(args)) return false;
  if (Object.keys(args).some((key) => !READ_FILE_ARGUMENT_KEYS.has(key))) return false;
  if (typeof args.Path !== "string" || args.Path.length === 0) return false;
  if (args.StartLine !== undefined && (typeof args.StartLine !== "number" || !Number.isInteger(args.StartLine))) return false;
  if (args.EndLine !== undefined && (typeof args.EndLine !== "number" || !Number.isInteger(args.EndLine))) return false;
  return args.ByteOffset === undefined ||
    (typeof args.ByteOffset === "number" && Number.isInteger(args.ByteOffset) && args.ByteOffset >= 0);
}

function canonical(path: string): string | null {
  try {
    if (path.includes("\0")) return null;
    const absolute = resolve(path);
    const tail: string[] = [];
    let ancestor = absolute;
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return absolute;
      tail.unshift(basename(ancestor));
      ancestor = parent;
    }
    return join(realpathSync.native(ancestor), ...tail);
  } catch {
    return null;
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function localPathOperand(path: string, cwd: string): boolean {
  if (path === "-" || path.startsWith("~")) return false;
  const resolved = canonical(isAbsolute(path) ? path : join(cwd, path));
  return resolved !== null && isInside(resolved, cwd);
}

function pathspecMagic(path: string): boolean {
  return path.startsWith(":");
}

function revisionAtom(value: string): boolean {
  if (/^HEAD(?:~\d+)?$/.test(value)) return true;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith(".") &&
    !value.endsWith("/");
}

function observedGitOperandAllowed(operand: string, cwd: string): boolean {
  if (pathspecMagic(operand)) return false;
  const revisionPath = /^([^:]+):(.*)$/.exec(operand);
  if (revisionPath !== null) {
    const [, revision, path] = revisionPath;
    return revision !== undefined && path !== undefined && path !== "" &&
      revisionAtom(revision) && localPathOperand(path, cwd);
  }
  if (operand.includes("..")) {
    const range = /^(.+?)(\.\.\.?)(.+)$/.exec(operand);
    if (range === null || !revisionAtom(range[1]!) || !revisionAtom(range[3]!)) {
      return false;
    }
  } else if (operand.includes("~") && !revisionAtom(operand)) {
    return false;
  }
  return localPathOperand(operand, cwd);
}

function gitMetadataPath(path: string, cwd: string): boolean {
  const metadataRoot = canonical(join(cwd, ".git"));
  return metadataRoot === null || isInside(path, metadataRoot);
}

function splitLocalCommand(command: string): string[][] | null {
  const normalized = command.replace(/^[ \t]+|[ \t]+$/g, "");
  if (
    normalized === "" ||
    /[\0\r\n'"\\`$;<>()[\]{}*?!]/.test(command) ||
    /\|\||(^|[^&])&([^&]|$)/.test(command)
  ) {
    return null;
  }
  const segments = normalized.split(/[ \t]*(?:&&|\|)[ \t]*/);
  if (segments.some((segment) => segment === "")) return null;
  const tokenized = segments.map((segment) =>
    segment.replace(/^[ \t]+|[ \t]+$/g, "").split(/[ \t]+/)
  );
  return tokenized.every((tokens) => tokens.every((token) => LOCAL_COMMAND_TOKEN.test(token)))
    ? tokenized
    : null;
}

function readCommandAllowed(tokens: readonly string[], cwd: string): boolean {
  const [command, ...args] = tokens;
  if (command === "pwd") return args.length === 0;
  const simpleFlags: Readonly<Record<string, RegExp>> = {
    ls: /^(?:-[1AaCdFghilnqRrSstUuvX]+|--(?:all|almost-all|directory|human-readable|inode|numeric-uid-gid|recursive))$/,
    cat: /^(?:-[AbEnsTtv]+|--(?:number|number-nonblank|show-all|show-ends|show-tabs|squeeze-blank))$/,
    wc: /^(?:-[clmwL]+|--(?:bytes|chars|lines|max-line-length|words))$/,
    stat: /^(?:-L|--dereference)$/,
    file: /^(?:-[bL]+|--(?:brief|dereference))$/,
  };
  if (command === "head" || command === "tail") {
    const paths: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "-n" || arg === "-c" || arg === "--lines" || arg === "--bytes") {
        const count = args[index + 1];
        if (count === undefined || !/^\d+$/.test(count)) return false;
        index += 1;
      } else if (/^-(?:n|c)\d+$/.test(arg)) {
        continue;
      } else if (arg.startsWith("-")) {
        return false;
      } else {
        paths.push(arg);
      }
    }
    return paths.length > 0 && paths.every((path) => localPathOperand(path, cwd));
  }
  const flagPattern = command === undefined ? undefined : simpleFlags[command];
  if (flagPattern === undefined) return false;
  const paths: string[] = [];
  let afterOptions = false;
  for (const arg of args) {
    if (!afterOptions && arg === "--") {
      afterOptions = true;
    } else if (!afterOptions && arg.startsWith("-")) {
      if (!flagPattern.test(arg)) return false;
    } else {
      paths.push(arg);
    }
  }
  if (command !== "ls" && paths.length === 0) return false;
  return paths.every((path) => localPathOperand(path, cwd));
}

function addPathsStayLocal(args: readonly string[], cwd: string): boolean {
  const flags = new Set([
    "-A", "--all", "-u", "--update", "-p", "--patch", "-N", "--intent-to-add",
    "-v", "--verbose", "-f", "--force", "--ignore-errors", "--ignore-missing",
    "--renormalize", "--refresh",
  ]);
  let afterOptions = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (!afterOptions && arg === "--") {
      afterOptions = true;
    } else if (!afterOptions && arg.startsWith("-")) {
      if (!flags.has(arg)) return false;
    } else {
      if (pathspecMagic(arg)) return false;
      paths.push(arg);
    }
  }
  return args.length > 0 &&
    paths.every((path) => localPathOperand(path, cwd));
}

const OBSERVED_GIT_FLAGS = new Set([
  "--cached", "--decorate", "--graph", "--ignore-all-space", "--name-only", "--name-status",
  "--no-patch", "--numstat", "--oneline", "--patch", "--shortstat", "--staged", "--stat",
  "--unified", "-C", "-M", "-p", "-w",
]);
const OBSERVED_GIT_VALUE_OPTIONS = new Set([
  "--author", "--grep", "--max-count", "--since", "--until", "-n",
]);

function observedGitPathsStayLocal(args: readonly string[], cwd: string): boolean {
  let afterOptions = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!afterOptions && arg === "--") {
      afterOptions = true;
    } else if (!afterOptions && arg.startsWith("-")) {
      if (OBSERVED_GIT_FLAGS.has(arg)) continue;
      if (/^-(?:n?\d+|U\d+)$/.test(arg) ||
          /^--(?:max-count|unified)=\d+$/.test(arg)) continue;
      if (/^--(?:author|grep|since|until)=.+$/.test(arg)) continue;
      if (!OBSERVED_GIT_VALUE_OPTIONS.has(arg)) return false;
      const value = args[index + 1];
      if (value === undefined || value === "" ||
          ((arg === "-n" || arg === "--max-count") && !/^\d+$/.test(value))) {
        return false;
      }
      index += 1;
    } else if (!observedGitOperandAllowed(arg, cwd)) {
      return false;
    }
  }
  return true;
}

function gitListCommandAllowed(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  if (args[0] !== "--list" && args[0] !== "-l") return false;
  return args.slice(1).every((arg) => !arg.startsWith("-") && !pathspecMagic(arg));
}

function gitCommandAllowed(tokens: readonly string[], cwd: string): boolean {
  let index = 1;
  if (tokens[index] === "--no-pager") index += 1;
  const subcommand = tokens[index];
  if (subcommand === undefined || subcommand.startsWith("-")) return false;
  if (!LOCAL_GIT_SUBCOMMANDS.has(subcommand)) return false;
  if (REMOTE_GIT_SUBCOMMANDS.has(subcommand)) return false;
  if (DESTRUCTIVE_OR_COMMAND_GIT_SUBCOMMANDS.has(subcommand)) return false;
  const args = tokens.slice(index + 1);
  if (
    (subcommand === "diff" || subcommand === "log" || subcommand === "show") &&
    !observedGitPathsStayLocal(args, cwd)
  ) {
    return false;
  }
  if (subcommand === "worktree") {
    return args[0] === "list" && args.slice(1).every((arg) => ["--porcelain", "-z", "-v"].includes(arg));
  }
  if (subcommand === "branch" || subcommand === "tag") {
    return gitListCommandAllowed(args);
  }
  if (subcommand === "add") return addPathsStayLocal(args, cwd);
  return true;
}

function localCommandAllowed(command: string, cwd: string): boolean {
  const segments = splitLocalCommand(command);
  return segments !== null && segments.every((tokens) =>
    tokens[0] === "git" ? gitCommandAllowed(tokens, cwd) : readCommandAllowed(tokens, cwd)
  );
}

function referencesDirectory(args: Record<string, unknown>, directory: string): boolean {
  const root = canonical(directory);
  if (root === null) return true;
  for (const [key, value] of Object.entries(args)) {
    if (!PATH_ARGUMENT_KEYS.has(key)) continue;
    if (typeof value !== "string") return true;
    const path = canonical(value);
    if (path === null || isInside(path, root)) return true;
  }
  return false;
}

function commandReferencesDirectory(args: Record<string, unknown>, directory: string): boolean {
  const root = canonical(directory);
  return root !== null && typeof args.CommandLine === "string" && args.CommandLine.includes(root);
}

interface PathArguments {
  all: string[];
  targets: string[];
  valid: boolean;
}

function pathArguments(toolName: string, args: Record<string, unknown>): PathArguments {
  const all: string[] = [];
  const targets: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (!PATH_ARGUMENT_KEYS.has(key)) continue;
    if (typeof value !== "string" || value.length === 0) return { all, targets, valid: false };
    const path = canonical(value);
    if (path === null) return { all, targets, valid: false };
    all.push(path);
    if (WRITE_TARGET_KEYS[toolName]?.includes(key) === true) targets.push(path);
  }
  return { all, targets, valid: true };
}

const KAOIRO_MCP_PREFIX = "mcp_kaoiro_";

const allowed: GateDecision = { decision: "allow" };
const asked: GateDecision = { decision: "ask" };

function denied(reason: string): GateDecision {
  return { decision: "deny", reason };
}

export interface AcpToolPolicyOptions {
  config: AntigravityLaunchConfig;
  cwd: string;
  customizationDir: string;
  /** Names of the registered kaoiro tools, without the MCP prefix. */
  kaoiroToolNames: () => ReadonlySet<string>;
  broker: PermissionBroker;
  onPermissionRequest?: () => void;
  onPermissionResolved?: () => void;
}

/** Decides a PreToolUse hook request when `agy` runs over ACP with its own
 *  permission prompts off, so this hook is the only check. The evaluation
 *  order runs first and the first match decides; then the cell of the tool's
 *  class. A command's `Cwd` is not read: under `--sandbox` the shell tools are
 *  decided per command, not by where they run. */
export class AcpToolPolicy {
  readonly #cwd: string;
  readonly #customizationDir: string;
  readonly #kaoiroToolNames: () => ReadonlySet<string>;
  readonly #broker: PermissionBroker;
  readonly #sandbox: NonNullable<WrapperConfig["sandbox"]>;
  readonly #approval: NonNullable<AntigravityLaunchConfig["approval"]>;
  readonly #networkAccess: boolean;
  readonly #onPermissionRequest: (() => void) | undefined;
  readonly #onPermissionResolved: (() => void) | undefined;

  constructor(options: AcpToolPolicyOptions) {
    this.#cwd = canonical(options.cwd) ?? resolve(options.cwd);
    this.#customizationDir = canonical(options.customizationDir) ?? resolve(options.customizationDir);
    this.#kaoiroToolNames = options.kaoiroToolNames;
    this.#broker = options.broker;
    this.#sandbox = options.config.sandbox ?? "workspace-write";
    this.#approval = options.config.approval ?? "on-request";
    this.#networkAccess = effectiveNetworkAccess(this.#sandbox, options.config.network_access ?? false);
    this.#onPermissionRequest = options.onPermissionRequest;
    this.#onPermissionResolved = options.onPermissionResolved;
  }

  evaluate(toolCall: HookToolCall): GateDecision {
    const toolClass = TOOL_CLASS_BY_NAME.get(toolCall.name);
    if (toolCall.name === "read_file" && !validReadFileArguments(toolCall.args)) {
      return denied("kaoiro: read_file argument is missing or malformed");
    }
    let paths: PathArguments | undefined;
    if (toolClass === "write") {
      paths = pathArguments(toolCall.name, toolCall.args);
      if (!paths.valid || paths.targets.length === 0) {
        return denied("kaoiro: write target is missing or malformed");
      }
    }
    // Any path argument counts, a command's Cwd included: the hooks.json
    // there decides every later call.
    if (
      referencesDirectory(toolCall.args, this.#customizationDir) ||
      commandReferencesDirectory(toolCall.args, this.#customizationDir)
    ) {
      return denied("kaoiro: customization directory is protected");
    }
    if (toolClass === "agent-internal") {
      return denied("kaoiro: tool is not available through kaoiro");
    }
    if (
      toolCall.name.startsWith(KAOIRO_MCP_PREFIX) &&
      this.#kaoiroToolNames().has(toolCall.name.slice(KAOIRO_MCP_PREFIX.length))
    ) {
      return allowed;
    }
    if (toolClass === "network" && !this.#networkAccess) {
      return denied("kaoiro: network access is disabled");
    }
    return this.#cell(toolClass, toolCall, paths);
  }

  async decide(
    toolCall: HookToolCall,
    signal?: AbortSignal,
  ): Promise<{ decision: "allow" | "deny"; reason?: string }> {
    const policy = this.evaluate(toolCall);
    if (policy.decision !== "ask") return policy;
    this.#onPermissionRequest?.();
    try {
      const result: PermissionDecision = await this.#broker.decide(toolCall.name, toolCall.args, signal);
      return result.allow
        ? { decision: "allow" }
        : { decision: "deny", reason: result.message ?? "kaoiro: operator rejected" };
    } finally {
      this.#onPermissionResolved?.();
    }
  }

  #cell(
    toolClass: AntigravityToolClass | undefined,
    toolCall: HookToolCall,
    paths: PathArguments | undefined,
  ): GateDecision {
    if (this.#sandbox === "read-only") {
      if (toolClass === "read") return allowed;
      return denied(toolClass === undefined ? "kaoiro: unclassified tool denied" : "kaoiro: read-only sandbox");
    }
    if (toolClass === "read") return allowed;
    if (toolClass === "write") {
      const targets = paths!;
      if (this.#sandbox === "workspace-write" && targets.all.some((path) => !isInside(path, this.#cwd))) {
        return denied("kaoiro: write is outside the permitted workspace");
      }
      if (this.#approval === "untrusted") return asked;
      if (this.#approval === "local" && targets.targets.some((path) => gitMetadataPath(path, this.#cwd))) {
        return asked;
      }
      return allowed;
    }
    if (toolClass === undefined) {
      return this.#approval === "never" ? denied("kaoiro: unclassified tool denied") : asked;
    }
    return this.#shellColumn(toolCall);
  }

  /** Shell tools, and the network and subagent classes that use their column. */
  #shellColumn(toolCall: HookToolCall): GateDecision {
    if (this.#sandbox === "workspace-write") {
      if (!this.#networkAccess) return denied("kaoiro: this tool needs network access in workspace-write");
      return this.#approval === "never" ? denied("kaoiro: approval policy never denies this tool") : asked;
    }
    if (this.#approval === "never") return allowed;
    if (
      this.#approval === "local" &&
      toolCall.name === "run_command" &&
      typeof toolCall.args.CommandLine === "string" &&
      localCommandAllowed(toolCall.args.CommandLine, this.#cwd)
    ) {
      return allowed;
    }
    return asked;
  }
}
