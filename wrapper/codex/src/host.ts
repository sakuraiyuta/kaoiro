// CodexHost — owns the real Codex SDK session for one agent: spawns one
// `codex exec` per turn via @openai/codex-sdk (resume for turns 2+), derives
// kaoiro states from the ThreadEvent stream (adapter.ts + the shared state
// machine), and serves the common tools through the MCP bridge
// (docs/specs/codex-sdk-events.md, ADR-0032). The Claude twin is
// @kaoiro/claude-code's AgentHost; both implement EngineAdapter.
//
// Permission model (ADR-0033 F3): the sandbox axis is fixed at launch and
// the approval axis is pinned to "never" — codex exec cannot deliver
// approval requests to the caller, so waiting_permission never occurs here.

import { Codex } from "@openai/codex-sdk";
import type { CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import {
  initialMachineState,
  makeInstructionRejected,
  makeLog,
  makeResult,
  makeStateChange,
  stepState,
} from "@kaoiro/agent-common";
import type {
  AdapterEvent,
  EngineAdapter,
  Envelope,
  KaoiroState,
  LogEntry,
  MachineState,
  PendingPermissionExt,
  PendingQuestionExt,
  PermissionMode,
  ToolDescriptor,
  WrapperConfig,
} from "@kaoiro/agent-common";
import { clipText, logEntryToPayload } from "@kaoiro/agent-common";
import {
  threadEventToEvents,
  threadEventToFinalText,
  threadEventToLogs,
  threadEventToSessionId,
} from "./adapter.js";
import { CODEX_MODELS } from "./catalog.js";
import { ToolHost } from "./toolhost.js";

/** Structural view of the SDK surface the host drives; injectable so tests
 *  script ThreadEvents without a codex binary. */
export interface CodexThreadLike {
  runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}
export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export interface CodexHostOptions {
  /** Invoked on every state transition with the common envelope. */
  onState: (envelope: Envelope) => void;
  /** Invoked per relayable log line (assistant text / tool call / result). */
  onLog?: (envelope: Envelope) => void;
  /** Server-composed personality + common footer (ADR-0029 F5), injected as
   *  a developer-role message via config.developer_instructions (ADR-0032
   *  F3, verified 2026-07-10). */
  appendSystemPrompt: string;
  /** instruction_rejected sink (file-upload spec; codex rejects attachments
   *  wholesale for now). */
  onInstructionRejected?: (envelope: Envelope) => void;
  /** Reports the thread id (kaoiro session_id) once known (ADR-0014). */
  onSessionId?: (sessionId: string) => void;
  /** Common tools served to codex through the MCP bridge (ADR-0032 F5):
   *  inter-agent tools + ask_user_question. Empty/omitted = no bridge. */
  toolDescriptors?: ToolDescriptor[];
  /** Resume pointer: an existing codex thread id (UUIDv7). */
  resumeSessionId?: string;
  /** SDK client factory; injectable for tests. */
  codexFactory?: (options: CodexOptions) => CodexClientLike;
  /** ISO timestamp source; injectable for tests. */
  now?: () => string;
}

/** Bridge entry point, resolved against the built package layout. Works from
 *  dist/ (runtime) and src/ (tsx dev) alike — both point at dist/bridge.js,
 *  so dev spawns need a prior `pnpm build` of @kaoiro/codex. */
const BRIDGE_SCRIPT = new URL("../dist/bridge.js", import.meta.url).pathname;

export class CodexHost implements EngineAdapter {
  readonly #config: WrapperConfig;
  readonly #options: CodexHostOptions;
  readonly #now: () => string;
  #machine: MachineState = initialMachineState();
  #sessionId: string | null = null;
  #model: string | null;
  #effort: string | null;
  readonly #sandbox: NonNullable<WrapperConfig["sandbox"]>;
  readonly #networkAccess: boolean;
  readonly #cwd: string = process.cwd();
  #pendingPermission: PendingPermissionExt | null = null;
  #pendingQuestion: PendingQuestionExt | null = null;
  /** Queued operator instructions; #wake resolves the run loop's wait. */
  readonly #queue: string[] = [];
  #wake: (() => void) | null = null;
  #abort: AbortController | null = null;
  #closed = false;
  /** tool_use_id -> tool_name for tool_result backfill (protocol.md #40). */
  readonly #toolNames = new Map<string, string>();

  constructor(config: WrapperConfig, options: CodexHostOptions) {
    this.#config = config;
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#model = config.model ?? null;
    this.#effort = config.effort ?? null;
    this.#sandbox = config.sandbox ?? "workspace-write";
    this.#networkAccess = config.network_access ?? false;
    this.#sessionId = options.resumeSessionId ?? null;
  }

  get state(): KaoiroState {
    return this.#machine.state;
  }

  /** whoami snapshot (protocol-inter-agent), mirroring AgentHost's shape. */
  statusSnapshot(): {
    agent_id: string;
    persona: WrapperConfig["persona"];
    state: KaoiroState;
    model?: string;
    cwd?: string;
    session_id?: string;
  } {
    const out: ReturnType<CodexHost["statusSnapshot"]> = {
      agent_id: this.#config.agent_id,
      persona: this.#config.persona,
      state: this.#machine.state,
    };
    if (this.#model !== null) out.model = this.#model;
    out.cwd = this.#cwd;
    if (this.#sessionId !== null) out.session_id = this.#sessionId;
    return out;
  }

  async send(text: string, attachmentIds?: string[]): Promise<void> {
    if (attachmentIds !== undefined && attachmentIds.length > 0) {
      // Codex MVP has no attachment rendering path (file-upload spec is
      // Claude-side); reject the whole instruction loudly rather than
      // silently dropping the files.
      this.#options.onInstructionRejected?.(
        makeInstructionRejected(this.#config, this.#machine.state, this.#now(), {
          attachment_ids: attachmentIds,
          reason: "sdk_error",
          detail: "codex adapter does not support attachments yet",
        }),
      );
      return;
    }
    this.#apply({ kind: "user_send" });
    this.#queue.push(text);
    this.#wake?.();
  }

  async interrupt(): Promise<void> {
    this.#abort?.abort();
  }

  close(): void {
    this.#closed = true;
    this.#abort?.abort();
    this.#wake?.();
  }

  async setModel(value: string): Promise<void> {
    // Applies from the next turn: each turn resumes the thread with fresh
    // ThreadOptions, so no live session state needs touching.
    this.#model = value;
    this.#emitState(this.#machine.state);
  }

  async setEffort(level: string): Promise<void> {
    this.#effort = level;
    this.#emitState(this.#machine.state);
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    throw new Error(
      "codex: permission is launch-fixed; mid-session change unsupported (ADR-0033 F3)",
    );
  }

  setPendingPermission(pending: PendingPermissionExt | null): void {
    // Codex never produces permission requests (approval pinned to never);
    // kept for EngineAdapter conformance.
    this.#pendingPermission = pending;
  }

  /** Question twin of setPendingPermission — and, unlike the Claude host,
   *  ALSO the state driver: on codex the ask_user_question tool runs through
   *  the MCP bridge with no canUseTool hook, so the broker's pending change
   *  is the only signal that a question dialog opened/closed. */
  setPendingQuestion(pending: PendingQuestionExt | null): void {
    this.#pendingQuestion = pending;
    this.#apply({
      kind: pending !== null ? "question_request" : "question_resolved",
    });
  }

  async run(initialPrompt?: string): Promise<void> {
    const descriptors = this.#options.toolDescriptors ?? [];
    const toolHost =
      descriptors.length > 0 ? await ToolHost.listen(descriptors) : null;
    const factory =
      this.#options.codexFactory ??
      ((options: CodexOptions) => new Codex(options) as CodexClientLike);
    const codexConfig: Record<string, unknown> = {
      developer_instructions: this.#options.appendSystemPrompt,
    };
    if (toolHost !== null) {
      codexConfig.mcp_servers = {
        kaoiro: {
          command: process.execPath,
          args: [BRIDGE_SCRIPT],
          env: { KAOIRO_BRIDGE_SOCKET: toolHost.socketPath },
        },
      };
    }
    const codex = factory({
      config: codexConfig as NonNullable<CodexOptions["config"]>,
    });

    if (initialPrompt !== undefined) {
      this.#apply({ kind: "user_send" });
      this.#queue.push(initialPrompt);
    }

    try {
      while (!this.#closed) {
        const text = this.#queue.shift();
        if (text === undefined) {
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
          this.#wake = null;
          continue;
        }
        await this.#runTurn(codex, text);
      }
    } finally {
      toolHost?.close();
    }
  }

  #threadOptions(): ThreadOptions {
    const options: ThreadOptions = {
      sandboxMode: this.#sandbox,
      workingDirectory: this.#cwd,
      skipGitRepoCheck: true,
    };
    if (this.#model !== null) options.model = this.#model;
    if (this.#effort !== null) {
      options.modelReasoningEffort = this.#effort as NonNullable<
        ThreadOptions["modelReasoningEffort"]
      >;
    }
    if (this.#sandbox === "workspace-write") {
      options.networkAccessEnabled = this.#networkAccess;
    }
    return options;
  }

  async #runTurn(codex: CodexClientLike, text: string): Promise<void> {
    const thread =
      this.#sessionId !== null
        ? codex.resumeThread(this.#sessionId, this.#threadOptions())
        : codex.startThread(this.#threadOptions());
    this.#abort = new AbortController();
    let finalText: string | null = null;
    let sawResult = false;
    try {
      const { events } = await thread.runStreamed(text, {
        signal: this.#abort.signal,
      });
      for await (const event of events) {
        const sessionId = threadEventToSessionId(event);
        if (sessionId !== null && sessionId !== this.#sessionId) {
          this.#sessionId = sessionId;
          this.#options.onSessionId?.(sessionId);
        }
        for (const entry of threadEventToLogs(event)) {
          this.#emitLog(entry);
        }
        const last = threadEventToFinalText(event);
        if (last !== null) finalText = last;
        if (event.type === "turn.completed") {
          sawResult = true;
          this.#emitResult({
            ...(finalText !== null ? { text: finalText } : {}),
          });
        } else if (event.type === "turn.failed") {
          sawResult = true;
          this.#emitResult({ is_error: true });
        }
        for (const adapterEvent of threadEventToEvents(event)) {
          this.#apply(adapterEvent);
        }
      }
      if (!sawResult) {
        // Stream ended without a terminal turn event (abort, stream error
        // event, or process death): fold into the error path so the agent
        // never wedges in thinking/tool_running.
        this.#emitResult({ is_error: true });
        this.#apply({ kind: "result", subtype: "error_during_execution" });
      }
    } catch (err) {
      // runStreamed rejection or mid-stream throw (exec exited non-zero).
      if (!sawResult) {
        this.#emitResult({ is_error: true });
        this.#apply({ kind: "result", subtype: "error_during_execution" });
      }
      if (!this.#closed) {
        process.stderr.write(`codex turn failed: ${String(err)}\n`);
      }
    } finally {
      this.#abort = null;
    }
  }

  #apply(event: AdapterEvent): void {
    const { next, emitted } = stepState(this.#machine, event);
    this.#machine = next;
    for (const state of emitted) {
      this.#emitState(state);
    }
  }

  #emitState(state: KaoiroState): void {
    this.#options.onState(
      makeStateChange(this.#config, state, this.#now(), {}, this.#statusExt()),
    );
  }

  #statusExt(): Record<string, unknown> {
    const ext: Record<string, unknown> = {};
    ext.engine = "codex";
    if (this.#model !== null) ext.model = this.#model;
    ext.cwd = this.#cwd;
    ext.models = CODEX_MODELS;
    // Launch-fixed two-axis posture (ADR-0033 F1/F3). No permission_mode
    // twin: that field is the Claude-mode legacy and never applied here.
    ext.permission = { sandbox: this.#sandbox, approval: "never" };
    if (this.#pendingPermission !== null) {
      ext.pending_permission = this.#pendingPermission;
    }
    if (this.#pendingQuestion !== null) {
      ext.pending_question = this.#pendingQuestion;
    }
    return ext;
  }

  #emitLog(entry: LogEntry): void {
    if (this.#options.onLog === undefined) return;
    // logEntryToPayload owns clipping and the tool_use -> tool_result name
    // backfill via the shared map (protocol.md #40).
    const payload = logEntryToPayload(entry, this.#toolNames);
    this.#options.onLog(
      makeLog(this.#config, this.#machine.state, this.#now(), payload),
    );
  }

  #emitResult(payload: { text?: string; is_error?: boolean }): void {
    const clipped: { text?: string; is_error?: boolean } = { ...payload };
    if (clipped.text !== undefined) {
      const { text, truncated } = clipText(clipped.text);
      clipped.text = text;
      if (truncated) {
        // Match the log-payload truncation convention: clip, no marker field
        // on result (protocol.md result payload has no truncated flag).
      }
    }
    this.#options.onLog?.(
      makeResult(this.#config, this.#now(), clipped, this.#statusExt()),
    );
  }
}
