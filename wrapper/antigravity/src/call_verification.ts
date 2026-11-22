/** Joins each tool call `agy` reports over ACP (C) to the PreToolUse hook
 *  request with the same key (H) for one generation, and reports a gate fault
 *  when a call ran without a decision this host recorded. A hook from another
 *  conversation (a subagent) keeps its record and key, but no C is expected
 *  for it. */

export type HookState = "received" | "allow" | "deny" | "abandoned";

export type VerificationFault =
  | { kind: "duplicate_hook"; conversationId: string; callId: string; name: string }
  | { kind: "unobserved_tool"; callId: string; name: string | undefined; status: CallStatus; hook: HookState | "none" };

export type CallStatus = "open" | "completed" | "failed";

interface HookRecord {
  name: string;
  args: string;
  state: HookState;
}

interface CallRecord {
  name: string | undefined;
  args: string | undefined;
  status: CallStatus;
  /** A stop cause latched, or the connection closed, while the call was open. */
  stoppedWhileOpen: boolean;
  repeatLogged: boolean;
}

export interface CallVerifierOptions {
  /** The generation's attached session ID; calls are joined under it. */
  sessionId: () => string | undefined;
  onFault: (fault: VerificationFault) => void;
  /** A terminal update for a call that already settled; reported once. */
  onRepeat?: (callId: string) => void;
}

/** A stable form of a JSON value: object keys sorted at every level. */
export function canonicalArgs(value: unknown): string {
  const normalize = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(normalize);
    if (typeof node === "object" && node !== null) {
      return Object.fromEntries(
        Object.keys(node).sort().map((key) => [key, normalize((node as Record<string, unknown>)[key])]),
      );
    }
    return node;
  };
  return JSON.stringify(normalize(value)) ?? "undefined";
}

function hookKey(conversationId: string, callId: string): string {
  return `${conversationId}\u0000${callId}`;
}

export class CallVerifier {
  readonly #options: CallVerifierOptions;
  readonly #hooks = new Map<string, HookRecord>();
  readonly #calls = new Map<string, CallRecord>();

  constructor(options: CallVerifierOptions) {
    this.#options = options;
  }

  /** Records H as `received`. A second H with the same key is a fault; the
   *  caller answers that request deny. */
  hookReceived(conversationId: string, callId: string, name: string, args: unknown): boolean {
    const key = hookKey(conversationId, callId);
    if (this.#hooks.has(key)) {
      this.#options.onFault({ kind: "duplicate_hook", conversationId, callId, name });
      return false;
    }
    this.#hooks.set(key, { name, args: canonicalArgs(args), state: "received" });
    return true;
  }

  /** Called only after the decision was written to the hook socket without
   *  error. */
  hookDecided(conversationId: string, callId: string, decision: "allow" | "deny"): void {
    const record = this.#hooks.get(hookKey(conversationId, callId));
    if (record?.state === "received") record.state = decision;
  }

  /** The hook socket closed before a decision was written. */
  hookAbandoned(conversationId: string, callId: string): void {
    const record = this.#hooks.get(hookKey(conversationId, callId));
    if (record?.state === "received") record.state = "abandoned";
  }

  /** A `tool_call` or `tool_call_update` of the generation's own session. The
   *  first update gives the name and arguments; the first terminal status
   *  settles the call and checks it. */
  toolUpdate(callId: string, name: unknown, rawInput: unknown, status: unknown): void {
    let record = this.#calls.get(callId);
    if (record === undefined) {
      record = {
        name: typeof name === "string" ? name : undefined,
        args: rawInput === undefined ? undefined : canonicalArgs(rawInput),
        status: "open",
        stoppedWhileOpen: false,
        repeatLogged: false,
      };
      this.#calls.set(callId, record);
    }
    if (status !== "completed" && status !== "failed") return;
    if (record.status !== "open") {
      if (!record.repeatLogged) {
        record.repeatLogged = true;
        this.#options.onRepeat?.(callId);
      }
      return;
    }
    record.status = status;
    this.#check(callId, record);
    record.name = undefined;
    record.args = undefined;
  }

  /** Marks every call still open; a later `failed`, or an open call at
   *  settlement, then needs no decision. */
  stopLatched(): void {
    for (const record of this.#calls.values()) {
      if (record.status === "open") record.stoppedWhileOpen = true;
    }
  }

  /** Checks every call still open when the prompt settles. */
  settle(): void {
    for (const [callId, record] of this.#calls) {
      if (record.status === "open") this.#check(callId, record);
    }
  }

  knows(callId: string): boolean {
    return this.#calls.has(callId);
  }

  #check(callId: string, call: CallRecord): void {
    const sessionId = this.#options.sessionId();
    const hook = sessionId === undefined ? undefined : this.#hooks.get(hookKey(sessionId, callId));
    const same = hook !== undefined && hook.name === call.name && hook.args === call.args;
    const undecided = hook === undefined || hook.state === "received" || hook.state === "abandoned";
    let ok: boolean;
    if (call.status === "completed") {
      ok = same && hook!.state === "allow";
    } else if (call.status === "failed") {
      ok = (same && (hook!.state === "allow" || hook!.state === "deny")) || (call.stoppedWhileOpen && undecided);
    } else {
      ok = (call.stoppedWhileOpen && undecided) || (same && hook!.state === "allow");
    }
    if (ok) return;
    this.#options.onFault({
      kind: "unobserved_tool",
      callId,
      name: call.name,
      status: call.status,
      hook: hook?.state ?? "none",
    });
  }
}
