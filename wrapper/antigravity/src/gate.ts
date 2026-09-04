import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PermissionBroker, type PermissionDecision, type WrapperConfig } from "@kaoiro/agent-common";
import { effectiveNetworkAccess } from "./network_access.js";

export type AntigravityLaunchConfig = WrapperConfig & {
  approval?: "untrusted" | "on-request" | "never";
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

export interface HookRequest {
  nonce: string;
  stepIdx: number;
  toolCall: HookToolCall;
}

const classes: Readonly<Record<AntigravityToolClass, readonly string[]>> = {
  read: [
    "view_file", "list_dir", "grep_search", "find_by_name", "command_status",
    "list_permissions", "manage_task", "wait", "wait_5_seconds", "finish",
  ],
  write: [
    "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit",
  ],
  shell: ["run_command", "send_command_input", "notebook_execution"],
  network: [
    "read_url_content", "search_web", "open_browser_url", "generate_image", "read_browser_page",
    "list_browser_pages", "browser_click_element", "browser_drag_pixel_to_pixel", "browser_get_dom",
    "browser_get_network_request", "browser_input", "browser_list_network_requests", "browser_mouse_down",
    "browser_mouse_up", "browser_move_mouse", "browser_press_key", "browser_refresh_page",
    "browser_resize_window", "browser_scroll", "browser_scroll_dom", "browser_select_option",
    "capture_browser_console_logs", "capture_browser_screenshot", "click_browser_pixel",
    "execute_browser_javascript", "browser_subagent",
  ],
  subagent: ["define_subagent", "invoke_subagent", "manage_subagents"],
  "agent-internal": [
    "ask_question", "ask_permission", "ask_custom_permission", "schedule", "send_message",
    "manage_inbox", "delete_knowledge", "call_mcp_tool", "list_resources", "read_resource",
  ],
};

export const MEASURED_HOOK_CLASSES = new Set<AntigravityToolClass>([
  "read", "write", "shell", "network", "subagent",
]);

export const TOOL_CLASS_BY_NAME: ReadonlyMap<string, AntigravityToolClass> = new Map(
  Object.entries(classes).flatMap(([toolClass, names]) =>
    names.map((name) => [name, toolClass as AntigravityToolClass] as const),
  ),
);

const BRIDGE_ARG_KEYS = new Set([
  "CommandLine",
  "Cwd",
  "WaitMsBeforeAsync",
  "toolAction",
  "toolSummary",
]);
const PATH_ARGUMENT_KEYS = new Set(["AbsolutePath", "DirectoryPath", "TargetFile", "Cwd"]);
const MAX_BRIDGE_PAYLOAD_BYTES = 87 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync.native(absolute);
  const parent = dirname(absolute);
  return existsSync(parent) ? join(realpathSync.native(parent), relative(parent, absolute)) : absolute;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function referencesDirectory(args: Record<string, unknown>, directory: string): boolean {
  const root = canonical(directory);
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    if (PATH_ARGUMENT_KEYS.has(key) && isInside(canonical(value), root)) return true;
    if (key === "CommandLine" && value.includes(root)) return true;
  }
  return false;
}

function knownBridgePayload(encoded: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > MAX_BRIDGE_PAYLOAD_BYTES) return false;
  try {
    const json = Buffer.from(encoded, "base64url");
    return json.byteLength <= 64 * 1024 && isRecord(JSON.parse(json.toString("utf8")));
  } catch {
    return false;
  }
}

export interface GatePolicyOptions {
  config: AntigravityLaunchConfig;
  cwd: string;
  customizationDir: string;
  nodePath: string;
  bridgePath: string;
  toolNames: () => ReadonlySet<string>;
  broker: PermissionBroker;
  waitMsBeforeAsyncFloor?: number;
  warn?: (message: string) => void;
  onPermissionRequest?: () => void;
  onPermissionResolved?: () => void;
}

export class AntigravityGate {
  readonly #cwd: string;
  readonly #customizationDir: string;
  readonly #nodePath: string;
  readonly #bridgePath: string;
  readonly #toolNames: () => ReadonlySet<string>;
  readonly #broker: PermissionBroker;
  readonly #sandbox: NonNullable<WrapperConfig["sandbox"]>;
  readonly #approval: NonNullable<AntigravityLaunchConfig["approval"]>;
  readonly #networkAccess: boolean;
  readonly #waitMsBeforeAsyncFloor: number;
  readonly #warn: (message: string) => void;
  readonly #onPermissionRequest: (() => void) | undefined;
  readonly #onPermissionResolved: (() => void) | undefined;
  readonly #observedSteps = new Set<number>();

  constructor(options: GatePolicyOptions) {
    this.#cwd = canonical(options.cwd);
    this.#customizationDir = canonical(options.customizationDir);
    this.#nodePath = canonical(options.nodePath);
    this.#bridgePath = canonical(options.bridgePath);
    this.#toolNames = options.toolNames;
    this.#broker = options.broker;
    this.#sandbox = options.config.sandbox ?? "workspace-write";
    this.#approval = options.config.approval ?? "on-request";
    this.#networkAccess = effectiveNetworkAccess(this.#sandbox, options.config.network_access ?? false);
    this.#waitMsBeforeAsyncFloor = options.waitMsBeforeAsyncFloor ?? 5_000;
    this.#warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
    this.#onPermissionRequest = options.onPermissionRequest;
    this.#onPermissionResolved = options.onPermissionResolved;
  }

  inspectToolInventory(tools: readonly unknown[]): void {
    for (const tool of tools) {
      if (typeof tool === "string" && !TOOL_CLASS_BY_NAME.has(tool)) {
        this.#warn(`antigravity: unknown init tool: ${tool}`);
      }
    }
  }

  observeGateRequest(stepIdx: number): void {
    this.#observedSteps.add(stepIdx);
  }

  observeCompletedTool(stepIdx: number, toolName: string): boolean {
    const toolClass = TOOL_CLASS_BY_NAME.get(toolName);
    if (toolClass === undefined) {
      this.#warn(`antigravity: unclassified completed tool: ${toolName}`);
      return true;
    }
    if (!MEASURED_HOOK_CLASSES.has(toolClass)) return true;
    return this.#observedSteps.delete(stepIdx);
  }

  evaluate(toolCall: HookToolCall): GateDecision {
    const toolClass = TOOL_CLASS_BY_NAME.get(toolCall.name);
    if (toolClass === undefined) return this.#approval === "never"
      ? { decision: "deny", reason: "kaoiro: unclassified tool denied" }
      : { decision: "ask" };
    if (toolClass === "agent-internal") {
      return { decision: "deny", reason: "kaoiro: tool requires the Antigravity TUI" };
    }
    if (toolClass === "network" && !this.#networkAccess) {
      return { decision: "deny", reason: "kaoiro: network access is disabled" };
    }
    if ((toolClass === "write" || toolClass === "shell") && referencesDirectory(toolCall.args, this.#customizationDir)) {
      return { decision: "deny", reason: "kaoiro: customization directory is protected" };
    }
    if (toolCall.name === "run_command" && this.#isBridgeCall(toolCall.args)) {
      return { decision: "allow" };
    }
    if (toolCall.name === "run_command" && typeof toolCall.args.Cwd === "string" && canonical(toolCall.args.Cwd) !== this.#cwd) {
      return { decision: "ask" };
    }
    const policyClass = toolClass === "network" ? "shell" : toolClass;
    if (policyClass === "read") return { decision: "allow" };
    if (policyClass === "write") {
      const target = this.#pathTarget(toolCall.args);
      if (this.#sandbox === "read-only" || (target !== null && !isInside(target, this.#cwd))) {
        return { decision: "deny", reason: "kaoiro: write is outside the permitted workspace" };
      }
      return this.#sandbox === "workspace-write" && this.#approval !== "untrusted"
        ? { decision: "allow" }
        : { decision: "ask" };
    }
    if (this.#sandbox === "read-only") {
      return { decision: "deny", reason: "kaoiro: read-only sandbox" };
    }
    return this.#approval === "never" ? { decision: "allow" } : { decision: "ask" };
  }

  async decide(toolCall: HookToolCall): Promise<{ decision: "allow" | "deny"; reason?: string }> {
    const policy = this.evaluate(toolCall);
    if (policy.decision !== "ask") return policy;
    this.#onPermissionRequest?.();
    try {
      const result: PermissionDecision = await this.#broker.decide(toolCall.name, toolCall.args);
      return result.allow
        ? { decision: "allow" }
        : { decision: "deny", reason: result.message ?? "kaoiro: operator rejected" };
    } finally {
      this.#onPermissionResolved?.();
    }
  }

  #pathTarget(args: Record<string, unknown>): string | null {
    for (const key of ["AbsolutePath", "DirectoryPath", "TargetFile"]) {
      const value = args[key];
      if (typeof value === "string") return canonical(value);
    }
    return null;
  }

  #isBridgeCall(args: Record<string, unknown>): boolean {
    if (Object.keys(args).some((key) => !BRIDGE_ARG_KEYS.has(key))) return false;
    if (canonical(String(args.Cwd ?? "")) !== this.#cwd) return false;
    if (typeof args.WaitMsBeforeAsync !== "number" || args.WaitMsBeforeAsync < this.#waitMsBeforeAsyncFloor) return false;
    if (typeof args.CommandLine !== "string") return false;
    const escapedNode = this.#nodePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedBridge = this.#bridgePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^${escapedNode} ${escapedBridge} (?:list|call ([a-z_]{1,64}) ([A-Za-z0-9_-]{1,${MAX_BRIDGE_PAYLOAD_BYTES}}))$`).exec(args.CommandLine);
    if (match === null) return false;
    if (match[1] === undefined) return true;
    return this.#toolNames().has(match[1]) && knownBridgePayload(match[2]!);
  }
}

export interface GateServerOptions {
  nonce?: string;
  gate: AntigravityGate;
  onSocketClose?: () => void;
}

export class GateServer {
  readonly #server: Server;
  readonly #dir: string;
  readonly nonce: string;
  readonly socketPath: string;
  readonly #gate: AntigravityGate;
  readonly #onSocketClose: (() => void) | undefined;

  private constructor(server: Server, dir: string, nonce: string, gate: AntigravityGate, onSocketClose?: () => void) {
    this.#server = server;
    this.#dir = dir;
    this.nonce = nonce;
    this.socketPath = join(dir, "gate.sock");
    this.#gate = gate;
    this.#onSocketClose = onSocketClose;
  }

  static async listen(options: GateServerOptions): Promise<GateServer> {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-agy-gate-"));
    const server = createServer();
    const gate = new GateServer(server, dir, options.nonce ?? randomUUID(), options.gate, options.onSocketClose);
    server.on("connection", (socket) => gate.#serve(socket));
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(gate.socketPath, () => {
        server.removeListener("error", reject);
        resolveListen();
      });
    });
    return gate;
  }

  close(): void {
    this.#server.close();
    rmSync(this.#dir, { recursive: true, force: true });
  }

  #serve(socket: Socket): void {
    let buffer = "";
    let replied = false;
    socket.setEncoding("utf8");
    socket.on("close", () => {
      if (!replied) this.#onSocketClose?.();
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1 || replied) return;
      const line = buffer.slice(0, newline);
      void this.#handleLine(socket, line, () => { replied = true; });
    });
  }

  async #handleLine(socket: Socket, line: string, markReplied: () => void): Promise<void> {
    const deny = (reason: string): void => {
      markReplied();
      socket.end(`${JSON.stringify({ decision: "deny", reason })}\n`);
    };
    let request: unknown;
    try { request = JSON.parse(line); } catch { deny("kaoiro: malformed hook payload"); return; }
    if (!isRecord(request) || request.nonce !== this.nonce || typeof request.stepIdx !== "number" || !isRecord(request.toolCall) || typeof request.toolCall.name !== "string" || !isRecord(request.toolCall.args)) {
      deny("kaoiro: invalid gate request");
      return;
    }
    this.#gate.observeGateRequest(request.stepIdx);
    const decision = await this.#gate.decide({ name: request.toolCall.name, args: request.toolCall.args });
    markReplied();
    if (!socket.destroyed) socket.end(`${JSON.stringify(decision)}\n`);
  }
}
