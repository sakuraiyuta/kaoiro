// Agent host — runs a query() session, derives state from its message stream,
// and routes tool-permission requests through canUseTool so they surface as
// waiting_permission. Streaming input (send) and interrupt are wired here.
// Authentication is inherited from the local Claude Code runtime; no API key is
// required or handled here.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AdapterEvent,
  Envelope,
  KaoiroState,
  WrapperConfig,
} from "./types.js";
import type { MachineState } from "./state.js";
import { initialMachineState, makeStateChange, stepState } from "./state.js";
import { sdkMessageToEvents } from "./adapter.js";

/** Cap on queued user turns; send() throws beyond this (fail fast). */
const MAX_QUEUED_TURNS = 1000;

export interface PermissionDecision {
  allow: boolean;
  /** Reason returned to the agent when denied. */
  message?: string;
}

export interface AgentHostOptions {
  /** Invoked on every state transition with the common envelope. */
  onState: (envelope: Envelope) => void;
  /**
   * Decides a pending tool permission; its awaited duration is the
   * waiting_permission window. Defaults to deny (fail-closed) when omitted.
   */
  decidePermission?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<PermissionDecision> | PermissionDecision;
  /**
   * Extra query options (tools, allowedTools, cwd, model, …). Merged over the
   * defaults; canUseTool is reserved by the host and cannot be overridden.
   */
  queryOptions?: Partial<Options>;
  /** ISO-8601 timestamp source; injectable for tests. */
  now?: () => string;
}

/**
 * Hosts a single agent session. `run` drives the message loop until the input
 * stream is closed; `send` feeds follow-up turns, `interrupt` stops the current
 * one. State derivation is funneled through one synchronous apply step, so the
 * message loop and the permission callback never interleave mid-update.
 */
export class AgentHost {
  readonly #config: WrapperConfig;
  readonly #options: AgentHostOptions;
  readonly #now: () => string;

  readonly #queue: SDKUserMessage[] = [];
  #notify: (() => void) | null = null;
  #closed = false;
  #query: Query | null = null;
  #machine: MachineState = initialMachineState();

  constructor(config: WrapperConfig, options: AgentHostOptions) {
    this.#config = config;
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get state(): KaoiroState {
    return this.#machine.state;
  }

  /** Enqueue a user turn for the streaming input. */
  send(text: string): void {
    if (this.#closed) throw new Error("agent host is closed");
    // Fail fast instead of growing without bound when nothing drains.
    if (this.#queue.length >= MAX_QUEUED_TURNS) {
      throw new Error("agent host input queue is full");
    }
    this.#queue.push({
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: text },
    });
    this.#wake();
  }

  /** Close the input stream; the session ends once the current turn drains. */
  close(): void {
    this.#closed = true;
    this.#wake();
  }

  /** Interrupt the current turn (streaming-input control request). */
  async interrupt(): Promise<void> {
    await this.#query?.interrupt();
  }

  /**
   * Start the session and consume messages until closed. With
   * `initialPrompt` the first turn starts immediately; without it the
   * session idles on the streaming input until `send` delivers the
   * first turn (e.g. an operator instruction relayed by the server).
   */
  async run(initialPrompt?: string): Promise<void> {
    if (initialPrompt !== undefined) this.send(initialPrompt);
    const options: Options = {
      permissionMode: "default",
      systemPrompt: { type: "preset", preset: "claude_code" },
      ...this.#options.queryOptions,
      // Set last so queryOptions can never override the hook that drives
      // waiting_permission.
      canUseTool: (toolName, input) => this.#canUseTool(toolName, input),
    };
    const session = query({ prompt: this.#input(), options });
    this.#query = session;
    for await (const message of session) {
      for (const event of sdkMessageToEvents(message)) this.#apply(event);
    }
  }

  async #canUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    this.#apply({ kind: "permission_request" });
    try {
      const decide = this.#options.decidePermission;
      // Fail closed: deny when no decider is wired.
      const decision = decide
        ? await decide(toolName, input)
        : { allow: false };
      return decision.allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: decision.message ?? "denied" };
    } catch {
      // A throwing decider denies safely rather than crashing the session.
      return { behavior: "deny", message: "permission decision failed" };
    } finally {
      // Always leave waiting_permission, whatever the decider did.
      this.#apply({ kind: "permission_resolved" });
    }
  }

  #apply(event: AdapterEvent): void {
    const { next, emitted } = stepState(this.#machine, event);
    this.#machine = next;
    for (const state of emitted) {
      this.#options.onState(makeStateChange(this.#config, state, this.#now()));
    }
  }

  async *#input(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.#queue.length > 0) {
        yield this.#queue.shift() as SDKUserMessage;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#notify = resolve;
      });
    }
  }

  #wake(): void {
    const notify = this.#notify;
    this.#notify = null;
    notify?.();
  }
}
