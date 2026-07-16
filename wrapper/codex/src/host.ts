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
import type {
  CodexOptions,
  ThreadEvent,
  ThreadOptions,
} from "@openai/codex-sdk";
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
  EffectiveStatusSnapshot,
  EngineAdapter,
  Envelope,
  KaoiroState,
  LogEntry,
  MachineState,
  ModelSource,
  PendingPermissionExt,
  PendingQuestionExt,
  PermissionMode,
  ResolvedSnapshotExt,
  SwitchErrorExt,
  ToolDescriptor,
  WhoamiSnapshot,
  WrapperConfig,
} from "@kaoiro/agent-common";
import {
  clipText,
  computeResumeDrift,
  effectiveStatusEnvelopeFields,
  effectiveStatusWhoamiFields,
  logEntryToPayload,
} from "@kaoiro/agent-common";
import {
  threadEventToEvents,
  threadEventToFinalText,
  threadEventToLogs,
  threadEventToSessionId,
} from "./adapter.js";
import { effortLevelsForModel, resolveCodexCatalog } from "./catalog.js";
import { effectiveNetworkAccess } from "./network_access.js";
import { resolveCodexModel } from "./rollout.js";
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

type CodexCatalog = ReturnType<typeof resolveCodexCatalog>;

function initialStatusExtFromCatalog(
  catalog: CodexCatalog,
  model: string | null,
): Record<string, unknown> {
  return {
    engine: "codex",
    session_capabilities: {
      supports_attachments: false,
      supports_user_input_dialog: true,
      supports_model_switch: catalog.length > 0,
      // Phase-23 dogfood 再回帰対策 (藤 修正版方針 3): exact match の
      // effort_levels 、無ければ catalog intersection (fail-closed) の
      // length で判定。model=null (account default 経路 / 前回セッション
      // が turn 未完了で snapshot 未 stamp) でも catalog に共通 effort
      // levels があれば true を stamp、UI 側 effort switch button が
      // 有効化される (dashboard も同じ helper 相当の 2 段階 fallback)。
      supports_effort_switch:
        effortLevelsForModel(catalog, model).length > 0,
      supports_session_reset: true,
      session_reset_modes: ["new", "clear"],
      // ADR-0040 phase-21: Codex は explicit false を stamp。
      // turn.completed.usage.input_tokens は per-turn 入力のみで compaction
      // で縮み reasoning/output も含まないため context 使用率とは semantics
      // が異なる。max window 取得経路もない (catalog に context_window field
      // なし)。UI は「未対応」表示。upstream で compaction telemetry が
      // 確定するまで estimated 投影も行わない (docs/specs/codex-sdk-events.md)。
      supports_context_usage: false,
    },
    ...(catalog.length > 0 ? { models: catalog } : {}),
  };
}

/** Config-static status fields available before the Codex SDK starts.
 *  Catalog resolution is synchronous and matches the host projection. */
export function initialStatusExt(
  config: WrapperConfig,
): Record<string, unknown> {
  const catalog = resolveCodexCatalog(
    config.codex_auth_mode ?? "unknown",
    config.codex_chatgpt_plan,
  );
  return initialStatusExtFromCatalog(catalog, config.model ?? null);
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
  /** Origin of the model resolved by the CLI at startup (ADR-0032 F4bc
   *  addendum, phase-15). "launch" / "env" / "config" means the wrapper
   *  received an explicit pick and stays with that source; leave undefined
   *  when config.model is unset so account default applies. */
  modelSource?: ModelSource;
  /** Origin of the effort resolved by the CLI at startup. Same semantics
   *  as modelSource; undefined when config.effort is unset. */
  effortSource?: ModelSource;
  /** Resume pointer: an existing codex thread id (UUIDv7). */
  resumeSessionId?: string;
  /** Resume snapshot from the server (ADR-0014 F1 追補, phase-15 D8):
   *  the "last effective" resolved values captured before this relaunch.
   *  Only set on a resume launch; absent on a fresh spawn. When set, the
   *  host stamps ext.resume_snapshot and ext.resume_drift on every
   *  state_change alongside ext.effective. */
  resumeSnapshot?: ResolvedSnapshotExt;
  /** SDK client factory; injectable for tests. */
  codexFactory?: (options: CodexOptions) => CodexClientLike;
  /** Resolves the server-selected model from the Codex rollout. */
  modelResolver?: (sessionId: string) => Promise<string | null>;
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
  #modelPending: string | null = null;
  #modelLastGood: string | null = null;
  #modelLastGoodSource: ModelSource | null = null;
  #modelRollbackPinned = false;
  #modelSource: ModelSource | null;
  #effort: string | null;
  #effortPending: string | null = null;
  #effortLastGood: string | null = null;
  #effortLastGoodSource: ModelSource | null = null;
  #effortResetPending = false;
  #effortResetOnce = false;
  #switchErrorOnce: SwitchErrorExt | null = null;
  readonly #operatorSwitchedFields = new Set<keyof ResolvedSnapshotExt>();
  #effortSource: ModelSource | null;
  readonly #resumeSnapshot: ResolvedSnapshotExt | null;
  readonly #sandbox: NonNullable<WrapperConfig["sandbox"]>;
  readonly #networkAccess: boolean;
  readonly #cwd: string = process.cwd();
  readonly #catalog: CodexCatalog;
  #pendingPermission: PendingPermissionExt | null = null;
  #pendingQuestion: PendingQuestionExt | null = null;
  /** Queued operator instructions; #wake resolves the run loop's wait. */
  readonly #queue: string[] = [];
  #wake: (() => void) | null = null;
  #abort: AbortController | null = null;
  #closed = false;
  /** Invalidates an older turn's asynchronous account-default refresh. */
  #modelResolutionGeneration = 0;
  /** tool_use_id -> tool_name for tool_result backfill (protocol.md #40). */
  readonly #toolNames = new Map<string, string>();

  constructor(config: WrapperConfig, options: CodexHostOptions) {
    this.#config = config;
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#model = config.model ?? null;
    this.#modelSource = options.modelSource ?? null;
    this.#effort = config.effort ?? null;
    this.#effortSource = options.effortSource ?? null;
    this.#resumeSnapshot = options.resumeSnapshot ?? null;
    // Phase-23 dogfood 回帰対策 (ADR-0014 F1 追補 P1「launch pin vs display
    // hint」): runner の 5-case pair rule Case 2 (source=default) は
    // config.model / config.effort を unset するので、SDK には「委任」の
    // semantics で pin されない。しかし wrapper の display / catalog resolve
    // には前回セッションの value が必要 — resume_snapshot の (value,
    // source="default") ペアを display hint として復元し、`this.#model` /
    // `this.#effort` に反映する。config/option の explicit 値が既に set の
    // 場合はそちらが優先 (fallback は absent 時のみ)。pair 整合 pin: value
    // と source が両方揃った "default" ペアのみを対象にし、source-only や
    // explicit source pair は runner apply の管轄外なのでここでは扱わない。
    if (this.#resumeSnapshot !== null) {
      if (
        this.#model === null &&
        this.#resumeSnapshot.model !== undefined &&
        this.#resumeSnapshot.model_source === "default"
      ) {
        this.#model = this.#resumeSnapshot.model;
        this.#modelSource = "default";
      }
      if (
        this.#effort === null &&
        this.#resumeSnapshot.effort !== undefined &&
        this.#resumeSnapshot.effort_source === "default"
      ) {
        this.#effort = this.#resumeSnapshot.effort;
        this.#effortSource = "default";
      }
    }
    this.#sandbox = config.sandbox ?? "workspace-write";
    this.#networkAccess = config.network_access ?? false;
    this.#catalog = resolveCodexCatalog(
      config.codex_auth_mode ?? "unknown",
      config.codex_chatgpt_plan,
    );
    this.#sessionId = options.resumeSessionId ?? null;
    // Phase-23 (ADR-0014 F1 追補 P1): a resume snapshot can restore both
    // model and effort into config even when the model has since been
    // catalogue-updated so effort_levels no longer include the persisted
    // effort. Mirror the setModel() code path: clear #effortPending and
    // route through the existing #effortResetPending / #effortResetOnce
    // one-shot so #finishTurn resets effort to the model's default_effort
    // on turn success and stamps ext.effort_reset once for UI feedback.
    //
    // Scope: RESUME PATH ONLY (`#resumeSnapshot !== null`). Fresh spawn
    // must retain the pre-Phase-23 behaviour — an operator-picked
    // incompatible effort passes through to the SDK unchanged, and the
    // SDK's own error / the existing switch_error rollback in
    // `#finishTurn` handles the mismatch. Widening the reset to fresh
    // spawn would silently override a launch-time choice that the
    // dashboard never explicitly asked to reset (藤 R1 must-fix).
    // Model absence / catalog entry without effort_levels → SDK 委任
    // (unchanged): the SDK's own error path handles a genuine mismatch,
    // covered by the existing switch_error rollback in #finishTurn.
    if (
      this.#resumeSnapshot !== null &&
      this.#model !== null &&
      this.#effort !== null
    ) {
      const modelInfo = this.#catalog.find(
        (entry) => entry.value === this.#model,
      );
      if (
        modelInfo?.effort_levels !== undefined &&
        !modelInfo.effort_levels.includes(this.#effort)
      ) {
        this.#effortPending = null;
        this.#effortResetPending = true;
        this.#effortResetOnce = true;
      }
    }
  }

  get state(): KaoiroState {
    return this.#machine.state;
  }

  /** whoami snapshot (protocol-inter-agent), mirroring AgentHost's shape. */
  statusSnapshot(): WhoamiSnapshot {
    const out: WhoamiSnapshot = {
      agent_id: this.#config.agent_id,
      persona: this.#config.persona,
      state: this.#machine.state,
      ...effectiveStatusWhoamiFields(this.#effectiveStatusSnapshot()),
    };
    out.cwd = this.#cwd;
    if (this.#sessionId !== null) out.session_id = this.#sessionId;
    return out;
  }

  /** Single engine-neutral SoT for both state_change.ext and whoami (#113). */
  #effectiveStatusSnapshot(): EffectiveStatusSnapshot {
    const permission = { sandbox: this.#sandbox, approval: "never" } as const;
    return {
      engine: "codex",
      resolved: {
        ...(this.#model !== null ? { model: this.#model } : {}),
        ...(this.#modelSource !== null
          ? { model_source: this.#modelSource }
          : {}),
        ...(this.#effort !== null ? { effort: this.#effort } : {}),
        ...(this.#effortSource !== null
          ? { effort_source: this.#effortSource }
          : {}),
        sandbox: this.#sandbox,
        network_access: effectiveNetworkAccess(
          this.#sandbox,
          this.#networkAccess,
        ),
      },
      permission,
    };
  }

  async send(text: string, attachmentIds?: string[]): Promise<void> {
    if (attachmentIds !== undefined && attachmentIds.length > 0) {
      // Codex MVP has no attachment rendering path (file-upload spec is
      // Claude-side); reject the whole instruction loudly rather than
      // silently dropping the files.
      this.#options.onInstructionRejected?.(
        makeInstructionRejected(
          this.#config,
          this.#machine.state,
          this.#now(),
          {
            attachment_ids: attachmentIds,
            reason: "sdk_error",
            detail: "codex adapter does not support attachments yet",
          },
        ),
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
    this.#modelPending = value;
    this.#effortResetPending = false;
    const model = this.#catalog.find((entry) => entry.value === value);
    const effort = this.#effortPending ?? this.#effort;
    if (
      effort !== null &&
      model?.effort_levels !== undefined &&
      !model.effort_levels.includes(effort)
    ) {
      this.#effortPending = null;
      this.#effortResetPending = true;
      this.#effortResetOnce = true;
    }
    this.#emitState(this.#machine.state);
  }

  async setEffort(level: string): Promise<void> {
    this.#effortPending = level;
    this.#effortResetPending = false;
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
    // Runner config is authoritative over any user-global Codex config
    // (ADR-0038 F2): always inject the effective toggle so a positive
    // `internal_subagents: true` force-enables and `false` disables. Absent
    // resolves to the effective default (true), injected explicitly.
    codexConfig.features = {
      multi_agent: this.#config.codex_internal_subagents ?? true,
    };
    if (toolHost !== null) {
      codexConfig.mcp_servers = {
        kaoiro: {
          command: process.execPath,
          args: [BRIDGE_SCRIPT],
          env: { KAOIRO_BRIDGE_SOCKET: toolHost.socketPath },
          // `codex exec` forces approval_policy=never, which otherwise
          // auto-cancels every MCP tool call ("user cancelled MCP tool
          // call"). "approve" auto-approves the kaoiro tools so they run
          // (verified 2026-07-11; the other accepted values auto/prompt/
          // writes all leave the call cancelled). These tools are
          // wrapper-provided and gated by the operator elsewhere
          // (send_to_agent per-call on Claude; ask_user_question IS the
          // operator prompt), so auto-approving them is safe.
          default_tools_approval_mode: "approve",
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

  #threadOptions(
    modelPending: string | null,
    effortPending: string | null,
    effortReset: boolean,
  ): ThreadOptions {
    const options: ThreadOptions = {
      sandboxMode: this.#sandbox,
      workingDirectory: this.#cwd,
      skipGitRepoCheck: true,
    };
    // A model observed from turn_context is display metadata, not an explicit
    // operator choice. Passing it back would silently pin later turns and
    // change the semantics of the account default.
    const model = modelPending ?? this.#model;
    if (
      model !== null &&
      (modelPending !== null ||
        this.#modelSource !== "default" ||
        this.#modelRollbackPinned)
    ) {
      options.model = model;
    }
    // Phase-23 dogfood 回帰対策: model 側の既存 gate (L446-454) と対称に、
    // effortSource="default" は SDK 委任継続で non-pin。display hint 復元で
    // this.#effort が set されていても、次 turn の SDK には渡さない。
    // operator setEffort は #effortSource="config" に上書きするため gate 通過。
    const effort = effortPending ?? this.#effort;
    if (
      !effortReset &&
      effort !== null &&
      (effortPending !== null || this.#effortSource !== "default")
    ) {
      options.modelReasoningEffort = effort as NonNullable<
        ThreadOptions["modelReasoningEffort"]
      >;
    }
    if (this.#sandbox === "workspace-write") {
      options.networkAccessEnabled = this.#networkAccess;
    }
    return options;
  }

  async #runTurn(codex: CodexClientLike, text: string): Promise<void> {
    const resolutionGeneration = ++this.#modelResolutionGeneration;
    const attempted = {
      model: this.#modelPending,
      effort: this.#effortPending,
      effortReset: this.#effortResetPending,
      accountDefault:
        this.#modelPending === null &&
        (this.#model === null || this.#modelSource === "default"),
      resolutionGeneration,
    };
    const thread =
      this.#sessionId !== null
        ? codex.resumeThread(
            this.#sessionId,
            this.#threadOptions(
              attempted.model,
              attempted.effort,
              attempted.effortReset,
            ),
          )
        : codex.startThread(
            this.#threadOptions(
              attempted.model,
              attempted.effort,
              attempted.effortReset,
            ),
          );
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
          this.#finishTurn(true, attempted);
          this.#emitResult({
            ...(finalText !== null ? { text: finalText } : {}),
          });
          // Resolve only after the terminal event: at turn.started an existing
          // rollout can still expose the previous turn_context and look
          // spuriously "resolved". Keep this background so filesystem timing
          // never holds terminal delivery or the next instruction.
          if (attempted.accountDefault && this.#sessionId !== null) {
            void this.#refreshAccountDefaultModel(
              this.#sessionId,
              attempted.resolutionGeneration,
            );
          }
        } else if (event.type === "turn.failed") {
          sawResult = true;
          this.#finishTurn(false, attempted);
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
        this.#finishTurn(false, attempted);
        this.#emitResult({ is_error: true });
        this.#apply({ kind: "result", subtype: "error_during_execution" });
      }
    } catch (err) {
      // runStreamed rejection or mid-stream throw (exec exited non-zero).
      if (!sawResult) {
        this.#finishTurn(false, attempted);
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

  #finishTurn(
    success: boolean,
    attempted: {
      model: string | null;
      effort: string | null;
      effortReset: boolean;
      accountDefault: boolean;
      resolutionGeneration: number;
    },
  ): void {
    if (success) {
      if (attempted.model !== null) {
        this.#model = attempted.model;
        this.#modelSource = "config";
        this.#operatorSwitchedFields.add("model");
        this.#operatorSwitchedFields.add("model_source");
      } else if (attempted.accountDefault) {
        // Never retain the previous turn's account-default model when this
        // turn could not be resolved. Absence is the explicit "unknown"
        // state consumed by whoami and AgentDetail's 確認待ち transition.
        this.#model = null;
        this.#modelSource = null;
      }
      if (attempted.effort !== null) {
        this.#effort = attempted.effort;
        this.#effortSource = "config";
        this.#operatorSwitchedFields.add("effort");
        this.#operatorSwitchedFields.add("effort_source");
      } else if (attempted.effortReset) {
        const model = attempted.model ?? this.#model;
        this.#effort =
          this.#catalog.find((entry) => entry.value === model)
            ?.default_effort ?? null;
        this.#effortSource = "default";
        this.#operatorSwitchedFields.add("effort");
        this.#operatorSwitchedFields.add("effort_source");
      }
      this.#modelLastGood = this.#model;
      this.#modelLastGoodSource = this.#modelSource;
      this.#effortLastGood = this.#effort;
      this.#effortLastGoodSource = this.#effortSource;
      if (attempted.model !== null) this.#modelRollbackPinned = false;
      if (this.#modelPending === attempted.model) this.#modelPending = null;
      if (this.#effortPending === attempted.effort) this.#effortPending = null;
      if (this.#effortResetPending === attempted.effortReset) {
        this.#effortResetPending = false;
      }
      this.#switchErrorOnce = null;
      return;
    }

    const kind = attempted.model !== null ? "model" : "effort";
    const requested = attempted.model ?? attempted.effort;
    if (requested !== null) {
      const rolledBackTo =
        kind === "model" ? this.#modelLastGood : this.#effortLastGood;
      this.#switchErrorOnce = {
        kind,
        requested,
        reason: "turn_failed",
        ...(rolledBackTo === null ? {} : { rolled_back_to: rolledBackTo }),
      };
    }
    if (requested !== null) {
      this.#model = this.#modelLastGood;
      this.#modelSource = this.#modelLastGoodSource;
      this.#effort = this.#effortLastGood;
      this.#effortSource = this.#effortLastGoodSource;
      if (attempted.model !== null && this.#modelLastGood !== null) {
        this.#modelRollbackPinned = true;
      }
    }
    if (this.#modelPending === attempted.model) this.#modelPending = null;
    if (this.#effortPending === attempted.effort) this.#effortPending = null;
    if (this.#effortResetPending === attempted.effortReset) {
      this.#effortResetPending = false;
    }
  }

  async #refreshAccountDefaultModel(
    sessionId: string,
    generation: number,
  ): Promise<void> {
    const resolver = this.#options.modelResolver ?? resolveCodexModel;
    let model: string | null = null;
    for (let attempt = 0; attempt < 2 && model === null; attempt += 1) {
      try {
        model = await resolver(sessionId);
      } catch {
        // Unknown was already stamped at terminal delivery. A resolver
        // failure must not become an unhandled rejection or disturb the next
        // turn. Retry once; the default resolver also handles its inner
        // filesystem write race.
        model = null;
      }
      if (model === null && attempt === 0) await Promise.resolve();
    }
    if (
      model === null ||
      this.#closed ||
      generation !== this.#modelResolutionGeneration
    ) {
      return;
    }
    this.#model = model;
    this.#modelSource = "default";
    this.#modelLastGood = model;
    this.#modelLastGoodSource = "default";
    this.#emitState(this.#machine.state);
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
      makeStateChange(
        this.#config,
        state,
        this.#now(),
        {},
        this.#statusExt(true),
      ),
    );
  }

  /** Non-consuming ext snapshot for the CLI's synthetic initial idle. */
  statusExtSnapshot(): Record<string, unknown> {
    return this.#statusExt(false);
  }

  #statusExt(consumeOneShot = false): Record<string, unknown> {
    const effectiveStatus = this.#effectiveStatusSnapshot();
    const ext: Record<string, unknown> = {
      ...initialStatusExtFromCatalog(this.#catalog, this.#model),
      ...effectiveStatusEnvelopeFields(effectiveStatus),
    };
    // Effective resolved settings this run (ADR-0014 F1 追補, phase-15 D8).
    // Rides every state_change so the D8 drift audit and any downstream
    // consumer sees "what am I enforcing right now". resume_snapshot /
    // resume_drift only appear when a resume relayed a snapshot.
    if (this.#resumeSnapshot !== null) {
      ext.resume_snapshot = this.#resumeSnapshot;
      ext.resume_drift = computeResumeDrift(
        this.#resumeSnapshot,
        effectiveStatus.resolved,
      ).filter((entry) => !this.#operatorSwitchedFields.has(entry.field));
    }
    // Session capabilities (ADR-0034 F1/F4, phase-15 15-14): advertised
    // from the first state_change onward (adapter-static values, no
    // thread.started await — that event fires only once a turn runs,
    // so an idle-wait agent would stay "not yet reported"). Codex
    // wholesale-rejects attach_open today (see cli.ts onAttachOpen);
    // the MCP bridge exposes ask_user_question. supports_model_switch /
    // supports_effort_switch are reserved for phase-16 (ADR-0035 F4).
    // supports_session_reset (ADR-0036 F5, phase-17 17-6 flip): the
    // Codex adapter now supports the F2 fresh-relaunch handshake, which
    // uses `startThread()` (not `resumeThread()`) after the runner's
    // kill + fresh spawn. Both modes ride the same runner path — the
    // display projection differences (`new` keeps log / `clear` resets)
    // are the server's AgentStates concern (chunk δ 17-7), not the
    // adapter's. Codex's thread ID is lazy: the fresh session's ID is
    // not established at `startThread()` time, so the runner reports
    // `to_session_id=null` and the server's `session_reset_completed`
    // broadcast rides that null; the ordinary envelope ingest path
    // stamps the pointer once the first turn produces one.
    if (this.#modelPending !== null) {
      ext.pending_model = this.#modelPending;
    }
    if (this.#effortPending !== null) {
      ext.pending_effort = this.#effortPending;
    }
    if (this.#effortResetOnce) {
      ext.effort_reset = true;
      if (consumeOneShot) this.#effortResetOnce = false;
    }
    if (this.#switchErrorOnce !== null) {
      ext.switch_error = this.#switchErrorOnce;
      if (consumeOneShot) this.#switchErrorOnce = null;
    }
    ext.cwd = this.#cwd;
    // Only publish a model catalog when one exists (currently empty for
    // codex — the account default is used, see catalog.ts).
    if (this.#catalog.length > 0) ext.models = this.#catalog;
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
