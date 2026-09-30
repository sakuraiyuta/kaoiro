import type { PermissionDecideOptions, SettledPermissionDecision } from "@kaoiro/agent-common";
import { rpcObject, SERVER_REQUEST_DISABLED, type AppServerServerRequest, type RpcObject } from "./app_server_rpc.js";

// Approval requests from the app-server (ADR-0064). One record per server
// request, from wire receipt to one final state. Admission reads monotone
// facts (the owner's latches and the rpc failure), so an event that happened
// before a request arrived is a fact the request reads, never a missed row.
// See docs/reference/engines/codex-app-server.md, "Approval requests".

export const APPROVAL_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
] as const;
export type ApprovalMethod = typeof APPROVAL_METHODS[number];

export const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;
export type ApprovalPolicy = typeof APPROVAL_POLICIES[number];

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return typeof value === "string" && (APPROVAL_POLICIES as readonly string[]).includes(value);
}

export const APPROVAL_TOOL_NAMES: Readonly<Record<ApprovalMethod, string>> = {
  "item/commandExecution/requestApproval": "codex:command_execution",
  "item/fileChange/requestApproval": "codex:file_change",
};

/** The transport's turn reservation as the approval layer sees it. Every
 * field only ever moves one way while the owner lives. */
export interface ApprovalOwner {
  readonly threadId: string;
  /** Set by the host before it aborts the turn scope. */
  aborted: boolean;
  /** Set when this owner's own named turn completed (wire or window replay). */
  terminal: boolean;
  start?: { kind: "started"; turnId: string } | { kind: "failed" };
  /** The approvalPolicy this owner's turn/start carried. */
  approvalPolicy?: ApprovalPolicy;
  /** Latest `changes` of each fileChange item, display only. */
  readonly fileChanges: Map<string, unknown>;
}

export function createApprovalOwner(threadId: string): ApprovalOwner {
  return { threadId, aborted: false, terminal: false, fileChanges: new Map() };
}

/** The connection a request arrived on; its answer goes back the same way. */
export interface ApprovalChannel {
  readonly failed: boolean;
  respond(id: string | number, result: RpcObject): boolean;
  respondError(id: string | number, error: { code: number; message: string }): boolean;
}

export interface ParsedApproval {
  method: ApprovalMethod;
  threadId: string;
  turnId: string;
  itemId: string;
  params: RpcObject;
}

const optionalString = (value: unknown) => value === undefined || value === null || typeof value === "string";

/** Null for a method outside the allowlist or params that fail validation. */
export function parseApprovalRequest(method: string, params: unknown): ParsedApproval | null {
  if (!(APPROVAL_METHODS as readonly string[]).includes(method) || !rpcObject(params)) return null;
  const { threadId, turnId, itemId, startedAtMs } = params;
  if (typeof threadId !== "string" || typeof turnId !== "string" || typeof itemId !== "string" ||
      typeof startedAtMs !== "number" || !optionalString(params.reason)) return null;
  if (method === "item/commandExecution/requestApproval") {
    if (params.kind !== undefined && params.kind !== "command" && params.kind !== "writeStdin") return null;
    if (!optionalString(params.command) || !optionalString(params.cwd) || !optionalString(params.approvalId)) return null;
  } else if (!optionalString(params.grantRoot)) return null;
  return { method: method as ApprovalMethod, threadId, turnId, itemId, params };
}

export interface AdmitFacts {
  rpcFailed: boolean;
  boundThreadId: string | undefined;
  /** The owner current at receipt; the record keeps it. */
  owner: ApprovalOwner | undefined;
  /** The persona opt-in, fixed at composition. */
  enabled: boolean;
}

export type Admission =
  | { state: "rejected"; rule: 1 | 3 | 4 | 8 | 9 }
  | { state: "dropped"; rule: 2 | 5 | 6 }
  | { state: "held"; rule: 7 }
  | { state: "pending"; rule: 10 };

/** Closed unless all three hold: the opt-in, a non-`never` policy written
 * into this turn's turn/start, and a routed approval method. */
export function approvalGate(enabled: boolean, policy: ApprovalPolicy | undefined, method: string): boolean {
  return enabled && policy !== undefined && policy !== "never" &&
    (APPROVAL_METHODS as readonly string[]).includes(method);
}

/** The admission decision list, checked top to bottom. */
export function admit(request: ParsedApproval | null, facts: AdmitFacts): Admission {
  if (request === null) return { state: "rejected", rule: 1 };
  if (facts.rpcFailed) return { state: "dropped", rule: 2 };
  if (request.threadId !== facts.boundThreadId) return { state: "rejected", rule: 3 };
  const owner = facts.owner;
  if (owner === undefined) return { state: "rejected", rule: 4 };
  if (owner.aborted) return { state: "dropped", rule: 5 };
  if (owner.terminal) return { state: "dropped", rule: 6 };
  if (owner.start === undefined) return { state: "held", rule: 7 };
  if (owner.start.kind === "failed" || owner.start.turnId !== request.turnId) return { state: "rejected", rule: 8 };
  if (!approvalGate(facts.enabled, owner.approvalPolicy, request.method)) return { state: "rejected", rule: 9 };
  return { state: "pending", rule: 10 };
}

export type ApprovalState = "held" | "pending" | "replied" | "dropped" | "rejected";
/** R receipt; Kn/Ku the owner's start named a turn / ended without one; S
 * serverRequest/resolved; T the owner's terminal; F rpc failure; A host
 * abort; D operator decision; X deadline. */
export type ApprovalEvent = "R" | "Kn" | "Ku" | "S" | "T" | "F" | "A" | "D" | "X";

export interface ApprovalTransition {
  key: string;
  from: ApprovalState | "absent";
  event: ApprovalEvent;
  to: ApprovalState;
  rule?: Admission["rule"];
  write?: "accept" | "decline" | "-32601";
}

export type ApprovalDecide = (
  toolName: string, input: Record<string, unknown>, signal: AbortSignal,
  options: PermissionDecideOptions & { deadlineMs: number | null },
) => Promise<SettledPermissionDecision>;

export interface ApprovalRouterOptions {
  enabled: boolean;
  decide?: ApprovalDecide;
  deadlineMs?: number | null;
  /** Shown in the dialog: an unanswered request ends with the turn when the
   * watchdog interrupts it. */
  inactivityLimitMs?: number;
  onDiagnostic?: (message: string) => void;
  /** Observer for every state change and every ignored event (tests). */
  onTransition?: (transition: ApprovalTransition) => void;
}

interface ApprovalRecord {
  key: string;
  id: string | number;
  channel: ApprovalChannel;
  request: ParsedApproval | null;
  owner: ApprovalOwner | undefined;
  state: ApprovalState;
  abort?: AbortController;
}

const FINAL: ReadonlySet<ApprovalState> = new Set(["replied", "dropped", "rejected"]);
// Display input for the operator dialog; a fileChange item's changes are
// the only data taken from outside the request.
function dialogInput(request: ParsedApproval, owner: ApprovalOwner, inactivityLimitMs: number | undefined): Record<string, unknown> {
  const p = request.params;
  const present = (entries: Array<[string, unknown]>) => Object.fromEntries(
    [...entries, ["inactivity_limit_ms", inactivityLimitMs] as [string, unknown]]
      .filter(([, value]) => value !== undefined && value !== null));
  if (request.method === "item/commandExecution/requestApproval") {
    const network = rpcObject(p.networkApprovalContext) ? p.networkApprovalContext : undefined;
    return present([
      ["command", p.command], ["cwd", p.cwd], ["kind", p.kind ?? "command"], ["reason", p.reason],
      ["command_actions", p.commandActions],
      ["network", network && { host: network.host, protocol: network.protocol }],
      ["approval_id", p.approvalId],
    ]);
  }
  const changes = owner.fileChanges.get(request.itemId);
  return present([
    ["item_id", request.itemId], ["reason", p.reason], ["grant_root", p.grantRoot],
    ["changes", changes], ["changes_unavailable", changes === undefined ? true : undefined],
  ]);
}

export class ApprovalRouter {
  readonly #options: ApprovalRouterOptions;
  // Live records in receipt order, and the state of every key this router
  // has seen. Both are bounded by the rpc's server-request id bound.
  readonly #live = new Map<string, ApprovalRecord>();
  readonly #states = new Map<string, ApprovalState>();

  constructor(options: ApprovalRouterOptions) {
    if (options.enabled && options.decide === undefined) throw new Error("An enabled approval router needs a broker");
    this.#options = options;
  }

  get enabled(): boolean { return this.#options.enabled; }

  /** Wire receipt of a request with a fresh id. */
  receive(request: AppServerServerRequest, channel: ApprovalChannel, facts: Omit<AdmitFacts, "rpcFailed" | "enabled">): void {
    const parsed = parseApprovalRequest(request.method, request.params);
    const record: ApprovalRecord = { key: request.key, id: request.id, channel, request: parsed, owner: facts.owner, state: "held" };
    if (parsed === null) this.#options.onDiagnostic?.(`codex: app-server request ${request.method} rejected\n`);
    this.#apply(record, "absent", "R", admit(parsed, { ...facts, rpcFailed: channel.failed, enabled: this.#options.enabled }));
  }

  /** The owner's start is set: re-admits its held records in receipt order. */
  start(owner: ApprovalOwner, boundThreadId: string | undefined): void {
    const event = owner.start?.kind === "started" ? "Kn" : "Ku";
    for (const record of [...this.#live.values()]) {
      if (record.owner !== owner || record.state !== "held") continue;
      this.#apply(record, "held", event, admit(record.request, {
        rpcFailed: record.channel.failed, boundThreadId, owner, enabled: this.#options.enabled,
      }));
    }
  }

  resolved(key: string): void {
    const record = this.#live.get(key);
    if (record === undefined) {
      const state = this.#states.get(key);
      if (state !== undefined) this.#options.onTransition?.({ key, from: state, event: "S", to: state });
      return;
    }
    this.#drop(record, "S");
  }

  terminal(owner: ApprovalOwner): void { this.#dropWhere(record => record.owner === owner, "T"); }
  abort(owner: ApprovalOwner): void { this.#dropWhere(record => record.owner === owner, "A"); }
  /** The channel failed, or the owner's window ended with the connection. */
  fail(match: { channel?: ApprovalChannel; owner?: ApprovalOwner } = {}): void {
    this.#dropWhere(record => (match.channel === undefined || record.channel === match.channel) &&
      (match.owner === undefined || record.owner === match.owner), "F");
  }

  #dropWhere(match: (record: ApprovalRecord) => boolean, event: "T" | "A" | "F"): void {
    for (const record of [...this.#live.values()]) if (match(record)) this.#drop(record, event);
  }

  #drop(record: ApprovalRecord, event: ApprovalEvent): void {
    this.#transition(record, event, "dropped");
    // After the record is final, so the broker's "aborted" settle is ignored.
    record.abort?.abort();
  }

  #apply(record: ApprovalRecord, from: ApprovalState | "absent", event: ApprovalEvent, admission: Admission): void {
    const { state, rule } = admission;
    if (state === "held") {
      this.#transition(record, event, "held", { rule, from });
      return;
    }
    if (state === "rejected") {
      const wrote = record.channel.respondError(record.id, SERVER_REQUEST_DISABLED);
      this.#transition(record, event, "rejected", { rule, from, ...(wrote ? { write: "-32601" as const } : {}) });
      return;
    }
    if (state === "dropped") {
      this.#transition(record, event, "dropped", { rule, from });
      return;
    }
    this.#transition(record, event, "pending", { rule, from });
    this.#show(record);
  }

  #show(record: ApprovalRecord): void {
    const request = record.request!;
    const abort = new AbortController();
    record.abort = abort;
    void this.#options.decide!(APPROVAL_TOOL_NAMES[request.method], dialogInput(request, record.owner!, this.#options.inactivityLimitMs), abort.signal, {
      deadlineMs: this.#options.deadlineMs ?? null,
      onSettled: decision => {
        if (decision.cause === "operator") this.#answer(record, "D", decision.allow ? "accept" : "decline");
        else if (decision.cause === "timeout") this.#answer(record, "X", "decline");
      },
    }).catch(error => this.#options.onDiagnostic?.(`codex: approval broker failed: ${String(error)}\n`));
  }

  #answer(record: ApprovalRecord, event: "D" | "X", decision: "accept" | "decline"): void {
    if (record.state !== "pending") {
      this.#options.onTransition?.({ key: record.key, from: record.state, event, to: record.state });
      return;
    }
    const wrote = record.channel.respond(record.id, { decision });
    this.#transition(record, event, wrote ? "replied" : "dropped", wrote ? { write: decision } : {});
  }

  #transition(
    record: ApprovalRecord, event: ApprovalEvent, to: ApprovalState,
    extra: { rule?: Admission["rule"]; from?: ApprovalState | "absent"; write?: ApprovalTransition["write"] } = {},
  ): void {
    const from = extra.from ?? record.state;
    record.state = to;
    this.#states.set(record.key, to);
    if (FINAL.has(to)) this.#live.delete(record.key);
    else this.#live.set(record.key, record);
    this.#options.onTransition?.({
      key: record.key, from, event, to,
      ...(extra.rule === undefined ? {} : { rule: extra.rule }),
      ...(extra.write === undefined ? {} : { write: extra.write }),
    });
  }
}
