// Minimal demo CLI — runs an agent session and prints color-coded state
// transitions, so you can watch the kaoiro state follow real agent behavior.
//
// Under the server-集約 SoT model (ADR-0029), the wrapper is always
// server-connected: server_url is required at config load, the SDK session
// only opens after the server pushes the personality + common footer over
// the handshake (fail-closed, F3), and the process stays resident to accept
// operator instructions.
//
// Safety: allowedTools defaults to read-only tools; config.allowed_tools
// raises that ceiling per wrapper (local config only). Other tools go to
// the canUseTool ask path (issue #1). Whether that path actually fires
// depends on the agent's permission_mode (ADR-0043 D4 追補): default 系
// mode では canUseTool が発火し PermissionBroker の operator dialog に
// 回る (deny on timeout)、auto 等の自律 mode では SDK が mode の意味論
// として自動承認するため dialog は出ない。厳格な都度承認が必要な agent
// は operator が mode を default 系に設定して gate を回復する。ceiling
// itself (allowedTools) cannot be widened from the server side
// (docs/reference/security/enforcement-boundaries.md).
//
// Usage: node dist/cli.js [configPath] [prompt] [--resume <session_id>]

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exitOnInterAgentQueueRefusal,
  interAgentQueuePolicy,
  loadWrapperBuildInfo,
  parseCliArgs,
} from "@kaoiro/wrapper-core";
import {
  readSessionHistory,
  sessionLogPath,
  sessionSidecarPath,
} from "./history.js";
import { AgentHost, CLAUDE_EFFORT_LEVELS } from "./host.js";
import type {
  SessionLifecycleKind,
  SessionLifecycleTrigger,
} from "./host.js";
import { handleInterAgentMessage } from "./inter_agent_message_handler.js";
import { ClaudeQueueRoot } from "./queue_root.js";
import {
  InterAgentIngressGate,
  InterAgentTurnCoordinator,
  type DispatchedInterAgentBatch,
  type InterAgentTurnSettlement,
} from "./inter_agent_turn_coordinator.js";
import {
  HistoryReplayer,
  createDeliveryAcknowledgementRuntime,
  DeliveryStageReporter,
  IaSidecar,
  InterAgentTool,
  classifyInterAgentError,
  isIngressStamp,
  mergePendingDisplayNameSync,
  flagArgument,
  personaOptInSource,
} from "@kaoiro/agent-common";
import { writeRedactedStderr } from "@kaoiro/agent-common";
import { buildKaoiroMcpServer } from "./inter_agent_sdk.js";
import { READ_ONLY_TOOLS } from "./read_only_tools.js";
import {
  REQUEST_COMPACT_INPUT_SHAPE,
  requestCompactDescriptor,
} from "./request_compact.js";
import {
  REQUEST_SESSION_RESET_INPUT_SHAPE,
  SessionResetCoordinator,
  requestSessionResetDescriptor,
} from "@kaoiro/agent-common";
import { PermissionBroker } from "@kaoiro/agent-common";
import {
  PERMISSION_MODES,
  formatConsumerSettingsLine,
  formatTurnWatchdogLine,
  loadConfig,
} from "@kaoiro/wrapper-core";
import { QuestionBroker } from "@kaoiro/agent-common";
import {
  makeLog,
  makeRefreshModelsResult,
  makeStateChange,
} from "@kaoiro/agent-common";
import { ServerLink } from "@kaoiro/wrapper-core";
import { resolveClaudeSources } from "./source_resolution.js";
import {
  TurnWatchdog,
  resolveTurnWatchdogSettings,
  type TurnWatchdogWarning,
} from "./turn_watchdog.js";
import type {
  Envelope,
  InterAgentMessagePayload,
  KaoiroState,
  ModelSource,
  PermissionMode,
} from "@kaoiro/agent-common";

const COLOR: Record<KaoiroState, string> = {
  idle: "90", // grey
  sending: "93", // bright yellow
  thinking: "36", // cyan
  tool_running: "33", // yellow
  waiting_permission: "35", // magenta
  waiting_question: "95", // bright magenta
  waiting_input: "32", // green
  done: "92", // bright green
  error: "31", // red
};

/** Upper bound on the wait for the server's `persona_prompt` push after
 *  join (ADR-0029 F3, fail-closed). Long enough for a slow initial
 *  handshake; short enough that a misconfigured server is loud. */
const PERSONA_PROMPT_TIMEOUT_MS = 10_000;

type CreateServerLink = (
  ...args: ConstructorParameters<typeof ServerLink>
) => ServerLink;
type CreateAgentHost = (
  ...args: ConstructorParameters<typeof AgentHost>
) => AgentHost;
type ServerLinkOptions = ConstructorParameters<typeof ServerLink>[2];
type AgentHostOptions = ConstructorParameters<typeof AgentHost>[1];

/** Injectable construction seam for the composition root. Production keeps
 * the concrete constructors; regressions capture the actual delivery and
 * whoami composition that this CLI supplies (#237, #244). */
export interface ClaudeCliDependencies {
  parseCliArgs?: typeof parseCliArgs;
  loadConfig?: typeof loadConfig;
  loadWrapperBuildInfo?: typeof loadWrapperBuildInfo;
  createServerLink?: CreateServerLink;
  createHost?: CreateAgentHost;
  buildMcpServer?: typeof buildKaoiroMcpServer;
}

// issue #209 D25: human-facing log lines show `display_name` (the
// mutable, operator-chosen label), never the pack's canonical
// `persona.name` — an agent instance can be renamed without any code
// here changing which field it reads. Correlation-critical output
// (nowhere in this file) would additionally carry `agent_id`; these are
// local terminal echo only, so the display label alone is enough.
function printState(envelope: Envelope): void {
  const color = COLOR[envelope.state];
  const time = envelope.ts.slice(11, 19);
  const name = envelope.display_name;
  process.stdout.write(
    `\x1b[${color}m[${time}] ${name}: ${envelope.state}\x1b[0m\n`,
  );
}

// Echo the reply stream so a local run shows what the agent answered, not
// just its state. tool input/output stay off the terminal (the state line
// already marks tool_running); they ride the envelope to the dashboard.
function printLog(envelope: Envelope): void {
  const time = envelope.ts.slice(11, 19);
  const name = envelope.display_name;
  const payload = envelope.payload;
  if (envelope.type === "result") {
    const text = typeof payload.text === "string" ? payload.text : "(no text)";
    process.stdout.write(`\x1b[37m[${time}] ${name} -> ${text}\x1b[0m\n`);
  } else if (payload.kind === "assistant" && typeof payload.text === "string") {
    process.stdout.write(`\x1b[37m[${time}] ${name}: ${payload.text}\x1b[0m\n`);
  }
}

export async function runClaudeCli(dependencies: ClaudeCliDependencies = {}): Promise<void> {
  const parseArgs = dependencies.parseCliArgs ?? parseCliArgs;
  const readConfig = dependencies.loadConfig ?? loadConfig;
  const createServerLink =
    dependencies.createServerLink ?? ((...args) => new ServerLink(...args));
  const createHost =
    dependencies.createHost ?? ((...args) => new AgentHost(...args));
  const readBuildInfo = dependencies.loadWrapperBuildInfo ?? loadWrapperBuildInfo;
  let link: ServerLink | null = null;
  const buildMcpServer = dependencies.buildMcpServer ?? buildKaoiroMcpServer;
  const { configPath, prompt: promptArg, resume: resumeSessionId } =
    parseArgs(process.argv.slice(2));
  const config = readConfig(configPath);
  // Read once here for the claim path below. The consumer line prints
  // yieldClaimTimeoutMs from this constant (cli.ts is its only consumer) and
  // the pending-receipt value from the host that receives it.
  const yieldClaimTimeoutMs = config.yield_claim_timeout_ms ?? 2_000;
  const pendingReceiptRootTimeoutMs = config.pending_receipt_root_timeout_ms ?? 2_000;
  const phase2Source = personaOptInSource(
    config.persona.id,
    flagArgument(process.env.KAOIRO_CLAUDE_PHASE2_DELIVERY, config.phase2_delivery),
    process.env.KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS,
  );
  const phase2Delivery = phase2Source !== "off";
  writeRedactedStderr(`[claude phase2 delivery] source=${phase2Source}\n`);
  const earlyNegotiated = (): boolean => phase2Delivery && link?.deliveryModes()?.early === "fold";
  const yieldNegotiated = (): boolean => phase2Delivery && link?.deliveryModes()?.yield === "tool_boundary";
  const buildInfo = readBuildInfo(
    fileURLToPath(new URL("../dist/build-info.json", import.meta.url)),
  );
  // Operational safety valve, deliberately wrapper-local rather than a
  // dashboard/server/runner configuration surface (issue #238).
  const resolvedWatchdog = resolveTurnWatchdogSettings(
    process.env,
    (message) => writeRedactedStderr(message),
    config,
  );
  const turnWatchdogSettings = resolvedWatchdog.settings;
  writeRedactedStderr(
    formatTurnWatchdogLine(
      "claude",
      process.pid,
      resolvedWatchdog,
      config.permission_timeout_ms,
    ),
  );

  // Engine-split default-model env (ADR-0032 F4bc addendum, phase-15 D1).
  const envDefaultModel = process.env.KAOIRO_CLAUDE_CODE_DEFAULT_MODEL;

  // Source vocabulary for ext.model_source (ADR-0032 F4bc addendum,
  // phase-15 15-4 + phase-23 P1 pair-aware apply). Priority, effort catalog
  // filter, and pair drop semantics are pinned in `resolveClaudeSources`
  // unit tests (source_resolution.test.ts); CLI just consumes + emits.
  const sources = resolveClaudeSources(
    config,
    envDefaultModel,
    CLAUDE_EFFORT_LEVELS,
  );
  const resolvedModelSource = sources.modelSource;
  const resolvedEffort = sources.effort as
    | (typeof CLAUDE_EFFORT_LEVELS)[number]
    | undefined;
  const resolvedEffortSource = sources.effortSource;
  for (const w of sources.warnings) writeRedactedStderr(w);

  // Engine-mismatch config warns (phase-15 15-7). Codex-only fields
  // (sandbox, network_access) surface loudly instead of being silently
  // ignored when written into a Claude config, so operator settings never
  // disappear into a black hole (D3 rationale).
  if (config.sandbox !== undefined) {
    writeRedactedStderr(
      "config warn: sandbox is codex-only, ignored on claude-code\n",
    );
  }
  if (config.network_access !== undefined) {
    writeRedactedStderr(
      "config warn: network_access is codex-only, ignored on claude-code\n",
    );
  }

  // Startup resolved-config summary (phase-15 15-5): one stderr line with
  // the engine-relevant fields and their source tags. The runner tee path
  // surfaces this in operator logs. Format follows the plan's Acceptance
  // Criteria. ignored-flags mark codex-only fields when they were supplied.
  {
    const resolvedModel = config.model ?? envDefaultModel ?? "<default>";
    const resolvedModelTag =
      resolvedModelSource !== undefined
        ? `(source=${resolvedModelSource})`
        : "(source=default)";
    const permissionModeSource: string =
      config.permission_mode !== undefined ? "config" : "default";
    const allowedToolsCount = config.allowed_tools?.length ?? 0;
    const effortPart =
      resolvedEffort === undefined
        ? ""
        : `effort=${resolvedEffort}(source=${resolvedEffortSource}) `;
    const sandboxPart =
      config.sandbox !== undefined
        ? ` sandbox=${config.sandbox}(ignored)`
        : "";
    const networkAccessPart =
      config.network_access !== undefined
        ? ` network_access=${config.network_access}(ignored)`
        : "";
    writeRedactedStderr(
      `[wrapper resolved] engine=claude-code ` +
        `model=${resolvedModel}${resolvedModelTag} ` +
        `${effortPart}` +
        `permission_mode=${config.permission_mode ?? "default"}(source=${permissionModeSource}) ` +
        `allowed_tools=${allowedToolsCount}` +
        `${sandboxPart}${networkAccessPart} ` +
        `persona=${config.persona.id}\n`,
    );
  }

  // No prompt argument: server-connected wrappers start idle and wait for
  // the first operator instruction. A prompt argument still works for
  // one-off dogfooding but the process remains resident (server-connected
  // wrappers never fall back to local 1-shot mode under ADR-0029 F10).
  const prompt = promptArg;

  let host: AgentHost;
  const pendingWorkNotices: string[] = [];
  let broker: PermissionBroker | null = null;
  let questionBroker: QuestionBroker | null = null;
  let interAgent: InterAgentTool | null = null;
  let replyBasisMode: "v1" | "legacy" | "pending" = "pending";
  // The server's after_join pushes persona_prompt then set_permission_mode
  // (WrapperChannel.handle_info(:after_join)); both frames can be dispatched
  // by the Phoenix socket in the same event-loop tick before the
  // await-personaPromptPromise below has a chance to resume and construct
  // `host`. Buffer the persisted mode instead of touching `host` here; the
  // buffered value is applied after AgentHost is constructed, before
  // host.run(), so host.ts's "setPermissionMode before run() sets initial
  // mode" contract still holds (host.ts #58 source order).
  let pendingPermissionMode: PermissionMode | undefined;
  // Same race as pendingPermissionMode (issue #187 段階3, renamed issue
  // #209 D19/D23): the after_join display_name sync push
  // (WrapperChannel.after_join_handshake, pushed after
  // set_permission_mode) can also arrive before `host` exists. Buffer it
  // and apply after construction, same discipline as
  // pendingPermissionMode above.
  let pendingDisplayNameSync: { displayName: string; revision: number } | undefined;
  // host.send is async now (the PDF fit-to-SDK path awaits pdf-lib). Chain
  // operator instructions through one Promise so a slow render (e.g. a big
  // PDF) does not let the next instruction's queue.push run first, which
  // would reorder turns on the SDK input stream.
  let instructionChain: Promise<void> = Promise.resolve();
  /** The single tail of that chain. Everything that puts a turn on the SDK
   *  input stream — operator instructions, inter-agent deliveries, the B2
   *  `/compact`, the B1 threshold notice (phase-28 BR MF2) — goes through
   *  here, so ordering is decided in one place. The returned promise settles
   *  with `task`, letting a caller surface its own failure, while the chain
   *  itself always continues. */
  const enqueueInstruction = (task: () => Promise<void>): Promise<void> => {
    const queued = instructionChain.then(task);
    instructionChain = queued.catch(() => {});
    return queued;
  };

  /**
   * issue #236: a CID is payload for peer_error fan-out, never the identity
   * of an SDK turn. The coordinator owns same-peer batching by opaque token;
   * its production implementation is unit-tested directly rather than being
   * copied into a CLI-only harness.
   */
  let interAgentTurns!: InterAgentTurnCoordinator;
  const foldCandidates = new Map<string, DispatchedInterAgentBatch>();
  const yieldCandidates = new Map<string, DispatchedInterAgentBatch>();
  const pushedBatches = new Map<readonly Envelope[], {
    batch: DispatchedInterAgentBatch;
    ownerToken: string;
    ticketLease: { activate: () => boolean; discard: () => void };
  }>();
  const foldedBatchTokensByOwner = new Map<string, string[]>();
  const foldedEnvelopes = new WeakSet<Envelope>();
  const ticketEnvelopes = new Map<string, readonly Envelope[]>();
  const ticketOwners = new Map<string, string>();
  let attemptFoldCandidates = (): void => {};
  let attemptYieldCandidates = (): void => {};
  // A watchdog or an unattributable notification result freezes this host
  // generation; no later callback may reopen dispatch (issue #238, #422).
  let admissionFailStopped = false;
  // Transport deliberately does not await onInterAgentMessage. Register a
  // lease before receiveInbound() can await InterAgentTool's pending-done
  // gate, so host terminal teardown can stop a late handler before it enters
  // turn ownership (issue #236).
  const interAgentIngress = new InterAgentIngressGate();
  // Root input from the server-owned queue (credit-v1). The legacy push path
  // above stays as it is for input the server still pushes.
  const queueRoot = new ClaudeQueueRoot({
    lease: () => link?.queueLease?.() ?? null,
    ready: () => link?.queueReady?.() ?? Promise.resolve(),
    isIdle: () => host !== undefined && host.isIdleForInput() && !admissionFailStopped,
    enqueue: (task) => enqueueInstruction(task),
    send: (text, conversationIds, turnToken, envelopes) =>
      host.send(text, undefined, conversationIds, turnToken, { source: "peer", urgent: false, envelopes }),
    preparePending: (turnToken, envelopes) => {
      for (const envelope of envelopes) interAgent?.notePendingInjection(envelope, turnToken);
      interAgent?.prepareReplyInput(turnToken, envelopes);
    },
    classify: (envelope) => interAgent!.receiveInbound(envelope),
    reclassify: (envelope, mode) => interAgent?.queuedInboundMode(envelope, mode) ?? mode,
    sendNotice: (notice) => interAgent?.sendInternalNotice(notice),
    log: (line) => writeRedactedStderr(line),
  });

  const resolveInterAgentConversationIds = (
    turnToken: string,
    conversationIds: readonly string[],
    error?: { reason?: string; detail?: string },
  ): void => {
    const classified = error ? classifyInterAgentError(error) : undefined;
    for (const envelope of interAgent?.resolveTurnEnd(
      turnToken,
      conversationIds,
      classified,
    ) ?? []) {
      interAgent?.sendInternalNotice(envelope);
    }
  };

  const resolveInterAgentTurn = (
    settlement: InterAgentTurnSettlement,
    error?: { reason?: string; detail?: string },
    options: { dispatchNext?: boolean } = {},
  ): void => {
    if (settlement.kind === "untracked") {
      resolveInterAgentConversationIds(
        settlement.turnToken,
        interAgent?.pendingConversationIdsForTurn(settlement.turnToken) ?? [],
        error,
      );
      return;
    }
    if (settlement.kind === "stale") {
      writeRedactedStderr(
        `[kaoiro] stale inter-agent turn settlement ignored: token=${settlement.turnToken}\n`,
      );
      return;
    }
    resolveInterAgentConversationIds(
      settlement.batch.turnToken,
      [...new Set([
        ...settlement.batch.conversationIds,
        ...(interAgent?.pendingConversationIdsForTurn(settlement.batch.turnToken) ?? []),
      ])],
      error,
    );
    // Resolve the old generation before starting a same-CID successor:
    // InterAgentTool's pending map is intentionally one record per CID.
    if (options.dispatchNext !== false) {
      interAgentTurns.dispatchNextForPeer(settlement.batch.peer);
    }
  };

  let foldRecoveryEvictions = 0;
  interAgentTurns = new InterAgentTurnCoordinator({
    onFoldRecoveryEvicted: reason => {
      foldRecoveryEvictions += 1;
      writeRedactedStderr(`[kaoiro][claude-code-receipt] ${JSON.stringify({ event: "fold_recovery_evicted", reason, count: foldRecoveryEvictions })}\n`);
    },
    reclassifyQueued: (item) =>
      interAgent?.queuedInboundMode(item.envelope, item.mode) ?? item.mode,
    onTerminalQueued: (item) => {
      const payload = item.envelope.payload as Partial<InterAgentMessagePayload>;
      writeRedactedStderr(
        `[kaoiro] queued inter-agent turn skipped: conversation_id=${String(payload.conversation_id)} ` +
        `turn_number=${String(payload.turn_number)} mode=${item.mode}->terminal\n`,
      );
      deliveryAcknowledgementRuntime.acknowledgeDelivery(item.envelope);
      deliveryStages?.settleEnvelope(item.envelope, "terminal_skip");
    },
    onDispatch: (batch) => {
      writeDeliveryLifecycle("dispatch_queued", batch.turnToken);
      const early = earlyNegotiated() && batch.items.every(item =>
        (item.envelope.payload as Partial<InterAgentMessagePayload>).delivery_authority?.granted === "early");
      const yieldInput = yieldNegotiated() && batch.items.length === 1 &&
        (batch.items[0]!.envelope.payload as Partial<InterAgentMessagePayload>).delivery_authority?.granted === "yield";
      void enqueueInstruction(() =>
        host
          .send(
            batch.text,
            undefined,
            batch.conversationIds,
            batch.turnToken,
            { source: "peer", urgent: early || yieldInput, envelopes: batch.items.map(item => item.envelope) },
          )
          .then(() => {
            if (early && host.hasQueuedInput(batch.turnToken)) {
              foldCandidates.set(batch.turnToken, batch);
              attemptFoldCandidates();
            }
            if (yieldInput && host.hasQueuedInput(batch.turnToken)) {
              yieldCandidates.set(batch.turnToken, batch);
              attemptYieldCandidates();
            }
          })
          .catch((err: unknown) => {
            foldCandidates.delete(batch.turnToken);
            yieldCandidates.delete(batch.turnToken);
            writeRedactedStderr(`inter-agent inject failed: ${String(err)}\n`);
            // failStop already terminally froze unstarted coordinator work;
            // an instructionChain task that resumes afterwards is a retired
            // no-op, not a fresh error to settle against the unknown active
            // generation.
            if (admissionFailStopped) return;
            for (const item of batch.items) interAgent?.notePendingInjection(item.envelope, batch.turnToken);
            // A rejected input never reaches the SDK, so it has no terminal
            // callback. Settle this exact token and let the coordinator, not
            // a CID lookup, decide whether its peer may advance.
            resolveInterAgentTurn(
              interAgentTurns.settle(batch.turnToken),
              { detail: String(err) },
            );
          }),
      );
    },
  });

  const writeDeliveryLifecycle = (
    event: "dispatch_queued" | "turn_start" | "delivery_ack",
    turnToken?: string,
    seq?: number,
  ): void => {
    try {
      const sequences = turnToken === undefined
        ? []
        : interAgentTurns.deliverySequencesForTurn(turnToken);
      writeRedactedStderr(`[kaoiro][claude-code-lifecycle] ${JSON.stringify({
        at: new Date().toISOString(),
        agent_id: config.agent_id,
        event,
        ...(turnToken === undefined ? {} : { turn_token: turnToken }),
        ...(sequences.length === 0 ? {} : {
          seq_first: Math.min(...sequences),
          seq_last: Math.max(...sequences),
        }),
        ...(seq === undefined ? {} : { seq, phase: "send_attempt" }),
      })}\n`);
    } catch {
      // Diagnostic output must not interrupt dispatch or acknowledgement.
    }
  };

  const onState = (envelope: Envelope): void => {
    printState(envelope);
    link?.send(envelope);
  };

  const onLog = (envelope: Envelope): void => {
    printLog(envelope);
    link?.send(envelope);
  };

  /** Relays child-task lifecycle and own-tasklist envelopes to the server.
   *  Both are aggregation data, not this agent's console transcript. */
  const onTask = (envelope: Envelope): void => {
    link?.send(envelope);
  };

  /** Reports one `session_lifecycle` event (ADR-0055, phase-33 Stage B).
   *  Recording only — no console echo, no reply expected, same
   *  fire-and-forget shape as `delivery_ack`. */
  const onSessionLifecycle = (
    kind: SessionLifecycleKind,
    trigger: SessionLifecycleTrigger | undefined,
    at: string,
  ): void => {
    link?.reportSessionLifecycle(kind, trigger, at);
  };

  /** Wrapper-authored operator line (phase-28 A1's `system` log kind). */
  const emitSystemLog = (text: string): void => {
    onLog(
      makeLog(config, host?.state ?? "idle", new Date().toISOString(), {
        kind: "system",
        text,
      }),
    );
  };

  const describeTurnWatchdogWarning = (warning: TurnWatchdogWarning): string => {
    switch (warning.kind) {
      case "inactivity_timeout":
        return (
          `[kaoiro] turn watchdog inactivity timeout: token=${warning.turnToken} ` +
          `idle=${warning.idleMs}ms threshold=${warning.inactivityMs}ms; ` +
          "requesting SDK interrupt"
        );
      case "abort_grace_expired":
        return (
          `[kaoiro] turn watchdog interrupt grace expired: token=${warning.turnToken} ` +
          `grace=${warning.abortGraceMs}ms; stopping host admission and requiring operator recovery`
        );
      case "interrupt_unavailable":
        return (
          `[kaoiro] turn watchdog interrupt unavailable: token=${warning.turnToken}; ` +
          "closing host admission through unattributed fail-stop"
        );
      case "fail_stop_unavailable":
        return (
          `[kaoiro] turn watchdog exact fail-stop unavailable: token=${warning.turnToken}; ` +
          "closing host admission through unattributed fail-stop"
        );
      case "start_conflict":
        return (
          `[kaoiro] turn watchdog start attribution conflict: watched=${warning.watchedTurnToken} ` +
          `started=${warning.startedTurnToken}; closing host admission through unattributed fail-stop`
        );
    }
  };

  // The watchdog begins only from AgentHost#onTurnStart below. Its callbacks
  // close over `host`, but no timer can fire before construction completes.
  const turnWatchdog = new TurnWatchdog({
    settings: turnWatchdogSettings,
    onWarning: (warning) => {
      const text = describeTurnWatchdogWarning(warning);
      writeRedactedStderr(`${text}\n`);
      emitSystemLog(text);
    },
    requestInterrupt: (turnToken) => host.requestInterruptForTurn(turnToken),
    failStop: (turnToken) => host.failStopTurnForWatchdog(turnToken),
    failStopUnattributed: () => {
      host.failStopForWatchdogAttributionUnknown();
    },
  });

  // phase-28 C2: holds an operator-approved reset until the turn boundary,
  // then asks the server. Failures are loud — one retry, then the agent is
  // told in a turn of its own so it never proceeds believing it reset.
  const sessionReset = new SessionResetCoordinator({
    request: (mode, reason) => {
      if (!link) return Promise.reject(new Error("server link unavailable"));
      return link.requestSessionReset(mode, reason);
    },
    notify: (text) => enqueueInstruction(() => host.send(text)),
    log: emitSystemLog,
  });

  // Await the server-pushed personality + common footer (ADR-0029 F5)
  // before opening the SDK session. Fail-closed on no push within the
  // timeout window (F3, F10).
  let resolvePersonaPrompt!: (prompt: string) => void;
  let rejectPersonaPrompt!: (reason: Error) => void;
  const personaPromptPromise = new Promise<string>((resolve, reject) => {
    resolvePersonaPrompt = resolve;
    rejectPersonaPrompt = reject;
  });

  broker = new PermissionBroker({
    config,
    send: (envelope) => link?.send(envelope),
    // Stamp ext.pending_permission onto the host so the next
    // state_change envelope carries it (ADR-0022). Captured-by-closure
    // host is assigned just below, before any tool ever fires.
    onPendingChange: (pending) => host?.setPendingPermission(pending),
  });
  questionBroker = new QuestionBroker({
    config,
    send: (envelope) => link?.send(envelope),
    // Question twin of the broker above: stamp ext.pending_question so the
    // waiting_question state_change carries it (ADR-0027).
    onPendingChange: (pending) => host?.setPendingQuestion(pending),
  });
  let replySessionId: string | undefined;
  const workTools = {
    workControlSupported: () => typeof link?.workControlSupported === "function" && link.workControlSupported(),
    deliveryModesSupported: () => typeof link?.deliveryModes === "function" && link.deliveryModes() !== null,
    deliveryModes: () => typeof link?.deliveryModesState === "function" ? link.deliveryModesState() : "pending",
    workStatus: (input: { work_id?: string | undefined }) => link
      ? link.requestWorkStatus(input.work_id === undefined ? {} : { work_id: input.work_id })
      : Promise.reject(new Error("work_control_unavailable")),
    workCheck: (input: { work_id: string; action: "start" | "land"; expected_revision: number; subject_hash?: string | undefined }) => link
      ? link.requestWorkCheck({ work_id: input.work_id, action: input.action, expected_revision: input.expected_revision, ...(input.subject_hash === undefined ? {} : { subject_hash: input.subject_hash }) })
      : Promise.reject(new Error("work_control_unavailable")),
    workTransferAck: (input: { work_id: string; transfer_id: string }) => link
      ? link.acknowledgeWorkTransfer(input)
      : Promise.reject(new Error("work_control_unavailable")),
    workOpResult: (input: { operation_id: string }) => link
      ? link.requestWorkOpResult(input)
      : Promise.reject(new Error("work_control_unavailable")),
    deliveryStatus: (input: { conversation_id?: string | undefined; turn_number?: number | undefined }) => link
      ? link.requestDeliveryStatus(input.conversation_id === undefined || input.turn_number === undefined ? {} : { conversation_id: input.conversation_id, turn_number: input.turn_number })
      : Promise.reject(new Error("work_control_unavailable")),
  };
  interAgent = new InterAgentTool({
    workTools,
    noticeAttributionMode: () => link?.noticeAttributionMode?.() ?? "pending",
    replyBasisMode: () => replyBasisMode,
    canSendInterAgent: () => !admissionFailStopped,
    replyBasisGeneration: () => link?.replyBasisGeneration?.(),
    waitReplyBasisMode: signal => link?.waitForReplyBasisMode?.(signal) ?? Promise.resolve(replyBasisMode),
    unreadCount: () => interAgentTurns.unreadCount(host.activeInterAgentTurnToken?.() ?? null),
    returnInput: (envelope, mode) => interAgentTurns.receive(envelope, mode),
    onReplyDiagnostic: event => writeRedactedStderr(`${JSON.stringify(event)}\n`),
    onInputHandoff: (envelopes, turnToken) => {
      queueRoot.inputHandoff(envelopes);
      for (const envelope of envelopes) deliveryAcknowledgementRuntime.acknowledgeDelivery(envelope);
      deliveryStages.submittedEnvelopes(turnToken, envelopes, "tool_result");
    },
    onTicketPrepared: (ticket, turnToken, envelopes) => {
      ticketEnvelopes.set(ticket, envelopes);
      ticketOwners.set(ticket, turnToken);
    },
    onTicketUsed: (ticket, turnToken) => {
      const envelopes = ticketEnvelopes.get(ticket)?.filter(envelope => foldedEnvelopes.has(envelope)) ?? [];
      ticketEnvelopes.delete(ticket);
      ticketOwners.delete(ticket);
      if (envelopes.length === 0) return;
      interAgent?.creditFoldedInput(turnToken, envelopes);
      interAgentTurns.creditFolded(envelopes);
      deliveryStages.includedEnvelopes(envelopes);
    },
    claimRecovery: (cid, peer, fit, expectedTurn) =>
      interAgentTurns.claimRecovery(cid, peer, host.activeInterAgentTurnToken?.() ?? null, fit, expectedTurn),
    config,
    getState: () => host.state,
    getActiveInterAgentTurnToken: () =>
      host?.activeInterAgentTurnToken() ?? null,
    send: (envelope) => link?.send(envelope),
    // ADR-0051 D3-2: `send_to_agent`'s result is the server's acceptance
    // ack, not the local push. No link yet means no server took it.
    sendInterAgent: (envelope, generation) =>
      link?.sendInterAgent(envelope, generation) ??
      Promise.resolve({ kind: "unknown" as const, reason: "not_connected" }),
    // Wired below once host + link are constructed; until then the tools
    // return error/fallback results, which is correct because the SDK
    // session has not opened yet either.
    requestDirectory: () =>
      link?.requestDirectory() ?? Promise.resolve({ agents: [], users: [] }),
    requestInterAgentDeliveryStatus: () =>
      link?.requestInterAgentDeliveryStatus() ?? Promise.resolve(null),
    getWhoami: () => ({
      ...host.statusSnapshot(),
      build: {
        revision: buildInfo.revision,
        dirty: buildInfo.dirty,
        version: buildInfo.version,
        channel: buildInfo.channel,
      },
    }),
  });
  // ADR-0051 D3-2 / D3-5: the host-local record of this agent's
  // inter-agent messages. Namespaced by the launch transition so a relaunch
  // (or a rollback) cannot append into the previous generation's pending
  // journal; a per-process id when the runner supplied none.
  const sidecar = new IaSidecar({
    agentId: config.agent_id,
    generation: config.transition_id ?? randomUUID(),
    resolveSessionPath: (sessionId) =>
      sessionSidecarPath(process.cwd(), sessionId),
  });

  /** A delivered IA carries the server's ingress stamp; record it before
   *  the SDK sees it (D3-2 receive side). Without a stamp the row cannot be
   *  placed against a clear watermark on replay, so it is dropped rather
   *  than stored with a wrapper clock. */
  const recordInboundIa = (envelope: Envelope): void => {
    const stamp = (envelope as { ingress_stamp?: unknown }).ingress_stamp;
    if (!isIngressStamp(stamp)) {
      writeRedactedStderr(
        "inter_agent_message without ingress_stamp; not recorded\n",
      );
      return;
    }
    sidecar.append({ ingress_stamp: stamp, envelope });
  };

  // ADR-0051 D2. Constructed BEFORE the link: the join reply (and with it
  // the hydration verdict) can land before `host` exists, so the replayer
  // has to be there to hold the verdict until `markReady()`.
  const replayer = new HistoryReplayer({
    seedState: () =>
      link?.send(
        makeStateChange(
          config,
          host?.state ?? "idle",
          new Date().toISOString(),
          {},
          host?.statusExtSnapshot() ?? {},
        ),
      ),
    sessionId: () => link?.currentSessionId() ?? null,
    readTranscript: (sessionId) =>
      readSessionHistory(process.cwd(), sessionId, config),
    readSidecar: () => sidecar.read(),
    sendHistoryReset: (replayId) => link?.sendHistoryReset(replayId),
    sendEnvelope: (envelope) => link?.send(envelope),
    sendReplayIa: (replayId, items) => link?.sendReplayIa(replayId, items),
    sendHistoryReplayComplete: (replayId) =>
      link?.sendHistoryReplayComplete(replayId),
    ...(resumeSessionId !== undefined
      ? { legacyResumeSessionId: resumeSessionId }
      : {}),
  });

  const deliveryIdentity = () => {
    if (link === null || typeof link.deliveryIncarnation !== "function" || typeof link.deliveryGeneration !== "function") return null;
    const incarnation = link.deliveryIncarnation();
    return incarnation === null ? null : { incarnation, generation: link.deliveryGeneration() };
  };
  const deliveryAcknowledgementRuntime = createDeliveryAcknowledgementRuntime(
    (deliverySeq) => {
      writeDeliveryLifecycle("delivery_ack", undefined, deliverySeq);
      link?.acknowledgeInterAgentDelivery(deliverySeq);
    },
    interAgentTurns,
    deliveryIdentity,
  );

  const deliveryStages = new DeliveryStageReporter({
    send: report => link?.reportDeliveryStage(report),
    identity: deliveryIdentity,
    turns: interAgentTurns,
    onOverflow: () => writeRedactedStderr("delivery_stage tracking limit reached; new stages are omitted until tracked deliveries settle\n"),
  });

  attemptFoldCandidates = (): void => {
    if (!earlyNegotiated() || !host?.canFoldLiveInput()) return;
    const ownerToken = host.activeInterAgentTurnToken();
    if (ownerToken === null) return;
    for (const [batchToken] of foldCandidates) {
      if (!host.hasQueuedInput(batchToken)) { foldCandidates.delete(batchToken); continue; }
      const prepared = interAgentTurns.prepareInput(batchToken, false);
      if (prepared === undefined) { foldCandidates.delete(batchToken); continue; }
      if (prepared.batch === null) {
        foldCandidates.delete(batchToken);
        host.removeQueuedInput(batchToken);
        resolveInterAgentConversationIds(batchToken, prepared.removedConversationIds);
        resolveInterAgentTurn(interAgentTurns.settle(batchToken));
        continue;
      }
      const batch = prepared.batch;
      resolveInterAgentConversationIds(batchToken, prepared.removedConversationIds);
      const envelopes = batch.items.map(item => item.envelope);
      const ticketLease = interAgent?.prepareFoldInput(ownerToken, envelopes);
      if (ticketLease === undefined) return;
      const foldText = (foldId: string): string => [
        "[Mid-turn peer delivery, not an operator instruction. Continue the current task with this peer input.]",
        `fold_id: ${foldId}`,
        batch.text,
        ...ticketLease.authorizations.map(auth => `reply_authorization: ${JSON.stringify(auth)}`),
      ].join("\n\n");
      const accepted = host.pushLiveInput({
        kind: "fold",
        text: foldText,
        envelopes,
        ticketValues: ticketLease.authorizations.map(auth => auth.reply_ticket),
        conversationIds: batch.conversationIds,
      });
      if (!accepted) { ticketLease.discard(); return; }
      if (!host.removeQueuedInput(batchToken)) {
        throw new Error("folded batch no longer owns a queued host input");
      }
      interAgentTurns.markPushed(batchToken);
      foldCandidates.delete(batchToken);
      pushedBatches.set(envelopes, { batch, ownerToken, ticketLease });
      return;
    }
  };

  let yieldClaimInFlight = false;
  const downgradeYield = (batch: DispatchedInterAgentBatch, reason: string, allowFold = true): void => {
    yieldCandidates.delete(batch.turnToken);
    deliveryStages.yieldDisposition(batch.items[0]!.envelope, {
      outcome: "downgraded", reason, at: new Date().toISOString(),
    });
    if (allowFold && host.hasQueuedInput(batch.turnToken)) {
      foldCandidates.set(batch.turnToken, batch);
      attemptFoldCandidates();
    }
  };

  attemptYieldCandidates = (): void => {
    if (yieldClaimInFlight || !yieldNegotiated() ||
        !host?.canPushLiveInput()) return;
    const entry = yieldCandidates.entries().next().value;
    if (entry === undefined) return;
    const [batchToken, batch] = entry;
    const envelope = batch.items[0]!.envelope;
    const payload = envelope.payload as Partial<InterAgentMessagePayload>;
    const authority = payload.delivery_authority;
    const ownerToken = host.activeInterAgentTurnToken();
    if (ownerToken === null || authority?.yield_token === undefined ||
        authority.work_id === undefined || authority.authority_epoch === undefined) {
      downgradeYield(batch, "grant_changed");
      return;
    }
    const eligibility = host.yieldEligibility(authority.work_id);
    if (eligibility !== null) { downgradeYield(batch, eligibility); return; }
    if (!host.canReserveYieldOvertake()) { downgradeYield(batch, "overtake_budget"); return; }
    const cutContext = host.captureLiveInputContext(ownerToken);
    if (cutContext === null) { downgradeYield(batch, "eligibility_changed"); return; }
    const identity = deliveryIdentity();
    if (identity === null || typeof payload.conversation_id !== "string" ||
        typeof payload.turn_number !== "number") {
      downgradeYield(batch, "claim_timeout");
      return;
    }
    const preparedBeforeClaim = interAgentTurns.prepareInput(batchToken, false);
    if (preparedBeforeClaim?.batch === null || preparedBeforeClaim === undefined) {
      downgradeYield(batch, "eligibility_changed");
      return;
    }
    resolveInterAgentConversationIds(batchToken, preparedBeforeClaim.removedConversationIds);
    // A receipt identifier is always 16 random bytes in hex. Check the exact
    // text shape before spending the server's single-use claim token.
    const cutText = (foldId: string, text: string): string =>
      `[Director yield after the running tool]\nfold_id: ${foldId}\n\n${text}`;
    const preclaimBatch = preparedBeforeClaim.batch;
    if (!host.pushedInputFits(cutText("0".repeat(32), preclaimBatch.text), preclaimBatch.items.length)) {
      downgradeYield(batch, "oversized_input", false);
      return;
    }
    yieldClaimInFlight = true;
    void (async () => {
      let reason: string | undefined;
      let granted = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          link!.requestYieldClaim({
            incarnation: identity.incarnation,
            generation: identity.generation,
            yield_token: authority.yield_token!,
            conversation_id: payload.conversation_id!,
            turn_number: payload.turn_number!,
            work_id: authority.work_id!,
            authority_epoch: authority.authority_epoch!,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("claim_timeout")), yieldClaimTimeoutMs);
          }),
        ]);
        granted = result.granted;
        if (!result.granted) reason = result.reason;
      } catch {
        reason = "claim_timeout";
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (!yieldCandidates.has(batchToken)) {
        yieldClaimInFlight = false;
        attemptYieldCandidates();
        return;
      }
      if (!granted) {
        yieldClaimInFlight = false;
        downgradeYield(batch, reason ?? "claim_timeout");
        attemptYieldCandidates();
        return;
      }
      const receiptDeadline = performance.now() + pendingReceiptRootTimeoutMs;
      while (true) {
        if (!yieldCandidates.has(batchToken)) {
          yieldClaimInFlight = false;
          attemptYieldCandidates();
          return;
        }
        if (!host.matchesLiveInputContext(ownerToken, cutContext) ||
            host.yieldEligibility(authority.work_id!) !== null ||
            !host.canReserveYieldOvertake() || !host.hasQueuedInput(batchToken)) {
          yieldClaimInFlight = false;
          downgradeYield(batch, "eligibility_changed");
          attemptYieldCandidates();
          return;
        }
        if (performance.now() >= receiptDeadline) {
          yieldClaimInFlight = false;
          downgradeYield(batch, "receipt_wait_timeout");
          attemptYieldCandidates();
          return;
        }
        if (!host.hasPendingPushedReceipt()) {
          if (host.canPushLiveInput()) break;
          yieldClaimInFlight = false;
          downgradeYield(batch, "eligibility_changed");
          attemptYieldCandidates();
          return;
        }
        const remaining = receiptDeadline - performance.now();
        if (remaining <= 0 || !await host.waitForPushedReceipt(ownerToken, remaining)) {
          const waitReason = host.matchesLiveInputContext(ownerToken, cutContext) &&
            host.hasPendingPushedReceipt() ? "receipt_wait_timeout" : "eligibility_changed";
          yieldClaimInFlight = false;
          downgradeYield(batch, waitReason);
          attemptYieldCandidates();
          return;
        }
      }
      const prepared = interAgentTurns.prepareInput(batchToken, false);
      if (prepared?.batch === null || prepared === undefined) {
        yieldClaimInFlight = false;
        downgradeYield(batch, "eligibility_changed");
        attemptYieldCandidates();
        return;
      }
      resolveInterAgentConversationIds(batchToken, prepared.removedConversationIds);
      if (prepared.batch.text !== preclaimBatch.text ||
          prepared.batch.items.length !== preclaimBatch.items.length ||
          prepared.batch.items.some((item, index) => item.envelope !== preclaimBatch.items[index]?.envelope)) {
        yieldClaimInFlight = false;
        downgradeYield(batch, "eligibility_changed");
        attemptYieldCandidates();
        return;
      }
      const envelopes = prepared.batch.items.map(item => item.envelope);
      const pushed = host.pushLiveInput({
        kind: "cut",
        text: foldId => cutText(foldId, preclaimBatch.text),
        envelopes,
        conversationIds: prepared.batch.conversationIds,
      });
      if (!pushed || !host.removeQueuedInput(batchToken)) {
        yieldClaimInFlight = false;
        downgradeYield(batch, "eligibility_changed");
        attemptYieldCandidates();
        return;
      }
      interAgentTurns.markPushed(batchToken);
      yieldCandidates.delete(batchToken);
      yieldClaimInFlight = false;
      pushedBatches.set(envelopes, { batch: prepared.batch, ownerToken,
        ticketLease: { activate: () => true, discard: () => {} } });
      deliveryStages.yieldDisposition(envelope, { outcome: "cut", at: new Date().toISOString() });
      attemptYieldCandidates();
    })();
  };

  const serverLinkOptions = deliveryAcknowledgementRuntime.withServerLinkOptions<
    Omit<ServerLinkOptions, "onInterAgentDeliveryStatus">
  >({
    interAgentQueuePolicy: interAgentQueuePolicy(config),
    onInterAgentQueueRefused: exitOnInterAgentQueueRefusal,
    onQueueOffer: (offer) => void queueRoot.onOffer(offer),
    onQueueRejoined: () => queueRoot.rejoined(),
    interAgentReplyBasis: "v1",
    noticeAttribution: "v1",
    interAgentDeliveryModes: {
      version: "v1",
      early: phase2Delivery ? "fold" : "none",
      yield: phase2Delivery ? "tool_boundary" : "none",
      stage_reports: true,
    },
    workControl: "v1",
    onReplyBasisMode: mode => { replyBasisMode = mode; },
    personaId: config.persona.id,
    buildInfo,
    onWorkNotice: notice => {
      const text = `Work notice: ${JSON.stringify(notice)}`;
      if (typeof host === "undefined") pendingWorkNotices.push(text);
      else instructionChain = instructionChain.then(() => host.send(text)).catch(() => {});
    },
    ...(config.transition_id === undefined
      ? {}
      : { transitionId: config.transition_id }),
    ...(config.server_token === undefined
      ? {}
      : { token: config.server_token }),
    onPersonaPrompt: (received) => resolvePersonaPrompt(received),
    onHydration: (verdict) => replayer.onVerdict(verdict),
    onInterAgentAck: (envelope, stamp) =>
      sidecar.append({ ingress_stamp: stamp, envelope }),
    // #248: acceptance of request_session_reset only means the server took
    // the lock. If this old wrapper survives the runner's termination path,
    // correlate the terminal failure and inject the fixed failure notice into
    // the still-live SDK session rather than leaving the agent believing it
    // was reset.
    onSessionResetFailed: ({ requestId, reason }) =>
      sessionReset.onResetFailed(requestId, reason),
    onInstruction: (text, attachmentIds, deliveryIntent) => {
      const tag = attachmentIds && attachmentIds.length > 0
        ? `instruction(+${attachmentIds.length})`
        : "instruction";
      process.stdout.write(`  ${tag}: ${text}\n`);
      // Echo the operator's instruction into the reply transcript (#31)
      // before queueing it: a user-kind log rides the same operator-only,
      // history-backed path as the agent's replies. Emitted first so it
      // precedes the response it triggers.
      onLog(
        makeLog(config, host.state, new Date().toISOString(), {
          kind: "user",
          text,
        }),
      );
      // Serialise async sends so render cost (PDF fit, etc.) cannot
      // reorder instructions on the SDK queue. swallow per-call failures
      // so one bad turn does not break the chain.
      void enqueueInstruction(() =>
        (async () => {
          if (earlyNegotiated() && deliveryIntent === "early" &&
                     attachmentIds?.length === undefined &&
                     link?.deliveryModes()?.early === "fold" && host.canFoldLiveInput()) {
            const pushed = host.pushLiveInput({
              kind: "fold",
              text: foldId => `[Mid-turn operator instruction]\nfold_id: ${foldId}\n\n${text}`,
              envelopes: [],
              conversationIds: [],
              operatorInput: true,
            });
            if (pushed) return;
          }
          await host.send(text, attachmentIds, undefined, undefined, {
            source: "operator",
            urgent: earlyNegotiated() && deliveryIntent === "early",
          });
        })().catch((err: unknown) => {
          writeRedactedStderr(`send failed: ${String(err)}\n`);
        }),
      );
    },
    onPermissionDecision: (decision) => broker?.resolve(decision),
    onQuestionResponse: (response) => questionBroker?.resolve(response),
    onInterrupt: () => {
      // protocol.md (#51): graceful stop of the current turn. SDK returns
      // an `error_*` SDKResultMessage which the adapter folds into the
      // existing error -> waiting_input path; no extra state to emit.
      process.stdout.write("  interrupt\n");
      void host.interrupt().catch(() => {});
    },
    onSetModel: (value) => {
      // protocol.md (#54): apply the operator's model choice to subsequent
      // turns; a bad alias surfaces as a rejected control request, swallowed
      // like the other best-effort controls.
      process.stdout.write(`  set_model: ${value}\n`);
      void host.setModel(value).catch(() => {});
    },
    onSetEffort: (level) => {
      process.stdout.write(`  set_effort: ${level}\n`);
      void host.setEffort(level).catch(() => {});
    },
    onSetPermission: (selection) => {
      void host.setPermission(selection).catch((error: unknown) => {
        writeRedactedStderr(`set_permission failed: ${String(error)}\n`);
      });
    },
    onRefreshModels: (payload) => {
      // protocol.md (ADR-0037 F6, phase-18-5) + ADR-0039 F9 v2 = 藤 review
      // D2a: manual refresh. When the server relays `request_id` we run
      // host.refreshCatalogFor() (awaited) and emit refresh_models_result
      // so AgentDetail's loading spinner can pair with the actual outcome.
      // Bare payload (older client / test) still supports fire-and-forget
      // via retrySupportedModels() for backwards compat.
      if (payload?.request_id !== undefined) {
        const rid = payload.request_id;
        process.stdout.write(`  refresh_models (request_id=${rid})\n`);
        // 藤 review turn-10 must-fix 2: even though refreshCatalogFor() is
        // documented as never-reject, keep a defensive .catch backstop so
        // a future refactor that accidentally throws still produces a
        // paired result envelope. The client spinner MUST always settle.
        void host
          .refreshCatalogFor()
          .catch(
            (err): {
              ok: false;
              reason: "cli_error";
              models_count?: number;
            } => {
              writeRedactedStderr(
                `refresh_models handler unexpectedly threw: ${
                  err instanceof Error ? err.message : String(err)
                }\n`,
              );
              return { ok: false, reason: "cli_error" };
            },
          )
          .then((outcome) => {
            const env = makeRefreshModelsResult(
              config,
              host.state,
              new Date().toISOString(),
              {
                request_id: rid,
                ok: outcome.ok,
                ...(outcome.reason ? { reason: outcome.reason } : {}),
                ...(outcome.models_count !== undefined
                  ? { models_count: outcome.models_count }
                  : {}),
              },
            );
            link?.send(env);
          });
      } else {
        process.stdout.write("  refresh_models (legacy no request_id)\n");
        host.retrySupportedModels();
      }
    },
    onSetPermissionMode: (mode) => {
      // protocol.md (#58): operator pick OR server after-join push of the
      // last persisted choice. Validate against the closed enum so a
      // malformed server payload never reaches the SDK; setPermissionMode
      // swallows SDK errors (e.g. bypass requested when the session was
      // not opened with allowDangerouslySkipPermissions) like the other
      // controls. The after_join push can arrive before `host` is
      // constructed (see pendingPermissionMode comment above); buffer in
      // that window so the persisted mode still lands as the initial mode.
      if (!(PERMISSION_MODES as readonly string[]).includes(mode)) {
        process.stdout.write(
          `  set_permission_mode: ignored unknown value '${mode}'\n`,
        );
        return;
      }
      process.stdout.write(`  set_permission_mode: ${mode}\n`);
      if (host === undefined) {
        pendingPermissionMode = mode as PermissionMode;
        return;
      }
      void host.setPermissionMode(mode as PermissionMode).catch(() => {});
    },
    onRenameDisplayName: (displayName, revision) => {
      // protocol.md (issue #187 段階3, renamed issue #209 D19/D23):
      // authoritative display_name from the server — fresh-join /
      // reconnect sync OR a live `rename_agent` relay, delivered via
      // EITHER `persona_sync` (legacy) or `display_name_sync` (new,
      // D22 dual-emit). Structural validation already happened in
      // transport.ts; the revision-freshness check happens inside
      // host.renameDisplayName itself (D15, and makes applying both
      // dual-emitted events idempotent). Buffer if `host` is not yet
      // constructed, same discipline as onSetPermissionMode above.
      process.stdout.write(`  display_name_sync: ${displayName} (revision=${revision})\n`);
      if (host === undefined) {
        // D15 review follow-up: a plain overwrite here would let a
        // lower-revision push win the pre-host race against a
        // higher-revision one (see mergePendingDisplayNameSync's doc).
        pendingDisplayNameSync = mergePendingDisplayNameSync(
          pendingDisplayNameSync,
          displayName,
          revision,
        );
        return;
      }
      host.renameDisplayName(displayName, revision);
    },
    // File-upload wire (file-upload spec / ADR-0025). attach_* events
    // feed pending_uploads on the host; the host's validation emits
    // attach_rejected / instruction_rejected straight back to the server.
    onAttachOpen: (msg) => {
      process.stdout.write(
        `  attach_open: ${msg.upload_id} (${msg.mime}, ${msg.size}B, ${msg.chunks} chunks)\n`,
      );
      host.attachOpen(msg);
    },
    onAttachChunk: (payload) => host.attachChunk(payload),
    onAttachClose: (uploadId) => {
      process.stdout.write(`  attach_close: ${uploadId}\n`);
      host.attachClose(uploadId);
    },
    onInterAgentMessage: (envelope) =>
      handleInterAgentMessage(
        deliveryAcknowledgementRuntime.withInboundContext({
          interAgent,
          ingress: interAgentIngress,
          recordInboundIa: envelope => {
            deliveryAcknowledgementRuntime.captureDelivery(envelope);
            deliveryStages.capture(envelope);
            recordInboundIa(envelope);
          },
          retireDelivery: (envelope: Envelope) => link?.retireInterAgentDeliveries?.([envelope]) ?? false,
          reportQueued: envelope => deliveryStages.queued(envelope),
          settleStage: (envelope, reason) => deliveryStages.settleEnvelope(envelope, reason),
          send: (notice) => interAgent?.sendInternalNotice(notice),
          inject: (inbound, mode) => {
            const granted = (inbound.payload as Partial<InterAgentMessagePayload>).delivery_authority?.granted;
            interAgentTurns.receive(inbound, mode,
              (earlyNegotiated() && granted === "early") ||
              (yieldNegotiated() && granted === "yield"));
          },
          log: (line) => process.stdout.write(line),
        }),
        envelope,
      ),
  });
  link = createServerLink(config.server_url, config.agent_id, serverLinkOptions);

  // fail-closed: the wrapper cannot open its SDK session without the
  // server-pushed personality prompt. A timeout here is loud on purpose so
  // a missing / misconfigured server does not silently boot with the SDK's
  // default persona (ADR-0029 F3).
  const timeoutHandle = setTimeout(() => {
    rejectPersonaPrompt(
      new Error(
        `timed out waiting for persona_prompt from ${config.server_url} ` +
          `after ${PERSONA_PROMPT_TIMEOUT_MS}ms (ADR-0029 fail-closed)`,
      ),
    );
  }, PERSONA_PROMPT_TIMEOUT_MS);

  let appendSystemPrompt: string;
  let disconnectReason: "stop" | "crash" = "stop";
  try {
    appendSystemPrompt = await personaPromptPromise;
  } catch (err) {
    // Cleanup path (ADR-0029 F3 fail-loud): the SDK session never opened,
    // so the outer try/finally around `host.run` (which normally owns
    // link/broker teardown) is unreachable. The ServerLink's Phoenix
    // Socket is already connected here (heartbeat/reconnect timers
    // active, not `.unref()`'d), so without an explicit close the
    // process would hang instead of exiting loudly. Close everything
    // we constructed, then rethrow so main().catch surfaces the error.
    try {
      await link?.reportDisconnectIntent?.("crash");
    } finally {
      link?.close();
      broker?.close();
      questionBroker?.close();
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  const freezeInterAgentAdmission = (turnToken: string | undefined, attribution: string, reason: string): void => {
    admissionFailStopped = true;
    const pendingIngress = interAgentIngress.close((envelopes) => link?.retireInterAgentDeliveries?.(envelopes));
    const frozen = interAgentTurns.freezeForWatchdogFailStop(turnToken, (envelopes) => link?.retireInterAgentDeliveries?.(envelopes));
    writeRedactedStderr(
      `[kaoiro] ${reason}: token=${turnToken ?? "<unknown>"} ` +
        `attribution=${attribution}; ` +
        `closed ingress=${pendingIngress}, discarded unstarted ` +
        `dispatched=${frozen.droppedDispatched}, pending=${frozen.droppedPending}. ` +
        "Do not reuse this host. In the dashboard, terminate this wrapper, wait for disconnected, then restore it; see docs/reference/engines/claude-events.md#recovering-a-fail-stopped-claude-wrapper.\n",
    );
  };

  const hostOptions = deliveryAcknowledgementRuntime.withHostOptions<
    Omit<AgentHostOptions, "onTurnStart">
  >({
    onState,
    pendingReceiptRootTimeoutMs,
    phase2RootScheduling: () => earlyNegotiated() || yieldNegotiated(),
    onLog,
    onTask,
    onSessionLifecycle,
    prepareInput: (turnToken) => {
      foldCandidates.delete(turnToken);
      const pendingYield = yieldCandidates.get(turnToken);
      if (pendingYield !== undefined) {
        yieldCandidates.delete(turnToken);
        deliveryStages.yieldDisposition(pendingYield.items[0]!.envelope, {
          outcome: "downgraded", reason: "no_work_input", at: new Date().toISOString(),
        });
      }
      const queued = queueRoot.prepareInput(turnToken);
      if (queued !== undefined) return queued;
      const prepared = interAgentTurns.prepareInput(turnToken);
      if (prepared === undefined) return undefined;
      resolveInterAgentConversationIds(turnToken, prepared.removedConversationIds);
      if (prepared.batch !== null) {
        for (const item of prepared.batch.items) interAgent?.notePendingInjection(item.envelope, turnToken);
        interAgent?.prepareReplyInput(turnToken, prepared.batch.items.map(item => item.envelope));
      }
      if (prepared.batch !== null) return {
        text: prepared.batch.text,
        conversationIds: prepared.batch.conversationIds,
      };
      resolveInterAgentTurn(interAgentTurns.settle(turnToken));
      return null;
    },
    // phase-28 BR MF2: the B1 threshold notice is an injection like any
    // other, so it queues on the one chain instead of racing it.
    enqueueInjection: enqueueInstruction,
    onTurnProgress: ({ turnToken }) => {
      turnWatchdog.progress(turnToken);
    },
    onPromptAdmitted: (turnToken) => {
      queueRoot.promptAdmitted(turnToken);
      deliveryStages.submitted(turnToken, "prompt_hook");
      interAgent?.confirmReplyInput(turnToken);
      interAgentTurns.retireFoldedBeforeConfirmed(interAgentTurns.deliveryEnvelopesForTurn(turnToken));
      attemptFoldCandidates();
      attemptYieldCandidates();
    },
    onPushedInputDecision: decision => {
      const pushed = pushedBatches.get(decision.envelopes);
      if (pushed === undefined) return;
      pushedBatches.delete(decision.envelopes);
      const { batch, ticketLease } = pushed;
      if (decision.kind === "fold" && decision.turnToken !== undefined && ticketLease.activate()) {
        interAgentTurns.retainFolded(decision.envelopes, decision.turnToken);
        for (const envelope of decision.envelopes) {
          foldedEnvelopes.add(envelope);
          interAgent?.notePendingInjection(envelope, decision.turnToken);
          deliveryAcknowledgementRuntime.acknowledgeDelivery(envelope);
        }
        deliveryStages.submittedEnvelopes(decision.turnToken, decision.envelopes, "fold_hook");
        const owned = foldedBatchTokensByOwner.get(decision.turnToken) ?? [];
        owned.push(batch.turnToken);
        foldedBatchTokensByOwner.set(decision.turnToken, owned);
      } else if (decision.kind === "root" && decision.turnToken !== undefined) {
        ticketLease.discard();
        const rootBatch = interAgentTurns.adoptPushedRoot(batch.turnToken, decision.turnToken);
        if (rootBatch === undefined) {
          freezeInterAgentAdmission(decision.turnToken, "unattributed", "pushed root ownership unavailable");
          return;
        }
        interAgent?.prepareReplyInput(decision.turnToken, decision.envelopes);
        for (const envelope of decision.envelopes) {
          interAgent?.notePendingInjection(envelope, decision.turnToken);
          deliveryAcknowledgementRuntime.acknowledgeDelivery(envelope);
        }
        deliveryStages.submittedEnvelopes(decision.turnToken, decision.envelopes, "prompt_hook");
        interAgentTurns.retireFoldedBeforeConfirmed(decision.envelopes);
      } else {
        ticketLease.discard();
        deliveryStages.unknownEnvelopes(decision.envelopes, decision.reason ?? "fold_authorization_unavailable");
        resolveInterAgentTurn(interAgentTurns.settle(batch.turnToken),
          { detail: decision.reason ?? "fold_authorization_unavailable" },
          { dispatchNext: decision.reason !== "root_hook_timeout" });
      }
      attemptFoldCandidates();
      attemptYieldCandidates();
    },
    // issue #236: settle by the immutable opaque generation token. CIDs are
    // intentionally ignored for ownership: they remain only the payload sent
    // to resolveTurnEnd once that exact token has been found.
    onTurnEnd: ({ turnToken, kind, error, cancellation }) => {
      queueRoot.turnEnded(turnToken, cancellation?.started !== false);
      if (turnToken !== undefined && cancellation?.started === false) {
        for (const envelope of interAgentTurns.deliveryEnvelopesForTurn(turnToken)) {
          interAgent?.notePendingInjection(envelope, turnToken);
        }
      }
      if (turnToken !== undefined) {
        foldCandidates.delete(turnToken);
        yieldCandidates.delete(turnToken);
      }
      if (turnToken !== undefined) deliveryStages.settled(turnToken);
      if (turnToken !== undefined) {
        for (const [ticket, owner] of ticketOwners) if (owner === turnToken) {
          ticketOwners.delete(ticket);
          ticketEnvelopes.delete(ticket);
        }
      }
      if (kind === "sdk_notification" && turnToken !== undefined) {
        resolveInterAgentConversationIds(turnToken, interAgent?.pendingConversationIdsForTurn(turnToken) ?? [], error);
        interAgent?.endReplyInput(turnToken);
        turnWatchdog.end(turnToken);
        if (cancellation === undefined && !admissionFailStopped) sessionReset.onTurnEnd();
        return;
      }
      if (turnToken) interAgent?.endReplyInput(turnToken);
      turnWatchdog.end(turnToken);
      if (turnToken !== undefined) {
        const settlement = interAgentTurns.settle(turnToken);
        // EOF cancellation must settle the exact token but must not free its
        // peer to dispatch a successor into a terminal host. onHostEnd drains
        // the coordinator's remaining batches and enqueues their notices
        // before link.close (transport acceptance is not awaited).
        const peersToDispatch = new Set<string>();
        if (settlement.kind === "settled") peersToDispatch.add(settlement.batch.peer);
        resolveInterAgentTurn(settlement, error, { dispatchNext: false });
        for (const batchToken of foldedBatchTokensByOwner.get(turnToken) ?? []) {
          const folded = interAgentTurns.settle(batchToken);
          if (folded.kind === "settled") peersToDispatch.add(folded.batch.peer);
          resolveInterAgentTurn(folded, error, { dispatchNext: false });
        }
        foldedBatchTokensByOwner.delete(turnToken);
        if (cancellation === undefined && !admissionFailStopped) {
          for (const peer of peersToDispatch) interAgentTurns.dispatchNextForPeer(peer);
        }
      }
      if (cancellation === undefined && !admissionFailStopped) {
        // phase-28 C2 / ADR-0043 D3: a real ResultMessage is the wrapper's
        // turn boundary. A never-started queue cancellation is settlement,
        // not permission to relaunch a session.
        sessionReset.onTurnEnd();
      }
    },
    onWatchdogFailStop: ({ turnToken, attribution }) => {
      freezeInterAgentAdmission(turnToken, attribution, "turn watchdog fail-stop");
    },
    onAdmissionFailStop: ({ turnToken }) => {
      freezeInterAgentAdmission(turnToken, "unattributed", "notification result fail-stop");
    },
    onHostEnd: ({ error }) => {
      turnWatchdog.dispose();
      const pendingIngress = interAgentIngress.close((envelopes) => link?.retireInterAgentDeliveries?.(envelopes));
      if (pendingIngress > 0) {
        process.stdout.write(
          `  inter_agent_message terminal ingress gate closed: pending=${pendingIngress}\n`,
        );
      }
      // Host-owned turns have already settled through onTurnEnd. What remains
      // here is outside AgentHost's queue: an instructionChain/send await or
      // a peer's not-yet-dispatched pending batch. Do not await the evolving
      // instruction chain; drain the coordinator's authoritative ownership
      // synchronously while the ServerLink is still open. ServerLink#send()
      // only enqueues the notice; it does not await Phoenix acceptance. If
      // the link closes before delivery, the server's disconnected notice is
      // the fail-visible fallback (issue #236).
      for (const batch of interAgentTurns.closeAndDrain()) {
        link?.retireInterAgentDeliveries?.(batch.items.map((item) => item.envelope));
        for (const item of batch.items) {
          interAgent?.notePendingInjection(item.envelope, batch.turnToken);
        }
        resolveInterAgentConversationIds(
          batch.turnToken,
          batch.conversationIds,
          error,
        );
      }
    },
    appendSystemPrompt,
    // Keep Query unconstructed during fresh idle so AgentDetail model /
    // effort picks become the first turn's Options, not initialization-bound
    // SDK control requests (#107).
    deferQueryUntilFirstInput: prompt === undefined,
    // attach_rejected / instruction_rejected ride the same envelope path
    // as state/log — the link relays them to the server (file-upload spec).
    onAttachRejected: (envelope) => link?.send(envelope),
    onInstructionRejected: (envelope) => link?.send(envelope),
    onSessionId: (id) => {
      if (replySessionId !== undefined && replySessionId !== id) {
        interAgent?.resetReplyInput();
        interAgentTurns.resetFoldedRecovery();
        ticketEnvelopes.clear();
        ticketOwners.clear();
      }
      replySessionId = id;
      link?.setSessionId(id);
      // Binds (or re-binds) the sidecar to this session's file, carrying
      // whatever the pending journal already holds (ADR-0051 D3-5).
      sidecar.bind(id);
      // issue #352: the runner inherits this process's stdout into its own
      // (systemd) journal, so one line here is the operator's only way to
      // find this agent's engine-side transcript after the fact.
      process.stdout.write(
        `[kaoiro] transcript: agent=${config.agent_id} engine=claude-code ` +
          `session=${id} path=${sessionLogPath(process.cwd(), id)}\n`,
      );
    },
    decidePermission: (toolName, input) => broker!.decide(toolName, input),
    // AskUserQuestion path (ADR-0027): server-connected wrappers always
    // have a question broker, so route through it directly.
    decideQuestion: (questions) => questionBroker!.decide(questions),
    // issue #285: the host abandoned this wait, so consume the broker's
    // registry entry with the same deny it handed the SDK. Leaving the id
    // answerable would let a late decision clear a LATER request's
    // authoritative pending record (ADR-0022) — and leak the entry.
    cancelDecision: (kind, requestId) => {
      if (kind === "permission") {
        broker?.resolve({
          request_id: requestId,
          allow: false,
          message: "kaoiro: this request was cancelled before it was answered",
        });
      } else {
        questionBroker?.resolve({
          request_id: requestId,
          answers: {},
          cancelled: true,
        });
      }
    },
    // issue #165 (ADR-0044 F2 追補): conversation-unit send_to_agent
    // auto-allow — InterAgentTool owns the per-(conversation_id, to)
    // flag (issue #165 review, ふじ M2).
    interAgentAutoAllow: (conversationId, to) =>
      interAgent!.isConversationAutoAllowed(conversationId, to),
    // Origin of the resolved startup model (phase-15 15-4). Undefined when
    // no explicit pick was made; the host stamps "default" on the first
    // init report in that case.
    ...(resolvedModelSource !== undefined
      ? { modelSource: resolvedModelSource }
      : {}),
    ...(resolvedEffortSource !== undefined
      ? { effortSource: resolvedEffortSource }
      : {}),
    // Resume snapshot relayed by the runner on a resume launch (ADR-0014
    // F1 追補, phase-15 D8). Undefined on a fresh spawn.
    ...(config.resume_snapshot !== undefined
      ? { resumeSnapshot: config.resume_snapshot }
      : {}),
    queryOptions: {
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: config.allowed_tools ?? [...READ_ONLY_TOOLS],
      cwd: process.cwd(),
      // Startup model precedence (ADR-0032 F4bc addendum, phase-15 15-2):
      // launch (config.model, SpawnMessage relay) > env > config > SDK
      // default, via the engine-split env KAOIRO_CLAUDE_CODE_DEFAULT_MODEL
      // (the legacy shared env was removed in issue #100). Dashboard
      // controls can still override model / effort at runtime.
      ...(config.model !== undefined
        ? { model: config.model }
        : envDefaultModel !== undefined
          ? { model: envDefaultModel }
          : {}),
      ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
      // The kaoiro in-process MCP server is always registered under the
      // server-connected model (phase-8). send_to_agent surfaces as
      // mcp__kaoiro__send_to_agent and is NOT in the read-only default
      // allowedTools, so it routes through canUseTool. Whether the broker
      // then runs the per-call operator dialog is permission_mode 従属
      // (ADR-0043 D4 追補): default 系 mode でのみ dialog が出る (auto 等
      // の自律 mode では SDK 側で自動承認され dialog は発火しない)。
      // request_compact (phase-28 B2) と request_session_reset (C2) も
      // 同じ扱いで、READ_ONLY_TOOLS (read_only_tools.ts) に登録しない
      // ことで canUseTool 経路に乗せる — mode 従属の gate を効かせる
      // ため、これらを READ_ONLY_TOOLS に足してはいけない。
      mcpServers: {
        kaoiro: buildMcpServer(interAgent!, [
          {
            descriptor: requestCompactDescriptor({
              // Ride the same chain operator instructions use, so an approved
              // /compact cannot overtake an instruction still rendering its
              // attachments. Awaiting the queued promise lets the tool report
              // a closed or full queue instead of claiming a reservation it
              // never made.
              send: (text) => enqueueInstruction(() => host.send(text)),
              // ADR-0055 phase-33 Stage A: `host` is not constructed yet at
              // this point (same deferred-closure reason `send` above uses
              // `enqueueInstruction`, not `host.send`, directly) — this
              // closure is only ever CALLED after `createHost` below returns.
              reserveResume: (prompt) => host.reserveResume(prompt),
            }),
            inputShape: REQUEST_COMPACT_INPUT_SHAPE,
          },
          {
            descriptor: requestSessionResetDescriptor({
              reserve: (mode, reason) => sessionReset.reserve(mode, reason),
            }),
            inputShape: REQUEST_SESSION_RESET_INPUT_SHAPE,
          },
        ], id => host.toolOrigins.resolveBound(id)),
      },
      ...(resumeSessionId !== undefined ? { resume: resumeSessionId } : {}),
    },
  }, (turnToken, kind) => {
    if (kind === "sdk_notification") interAgent?.beginNotificationReplyInput(turnToken);
    else {
      interAgent?.beginReplyInput(turnToken, undefined, true);
      writeDeliveryLifecycle("turn_start", turnToken);
    }
    // Dispatch may have happened long before this point; only this host
    // input-yield boundary is an actual SDK turn start (issue #238).
    turnWatchdog.start(turnToken);
  });
  host = createHost(config, hostOptions);
  writeRedactedStderr(
    formatConsumerSettingsLine("claude", process.pid, [
      ["yield_claim_timeout_ms", yieldClaimTimeoutMs],
      ["pending_receipt_root_timeout_ms", host.pendingReceiptRootTimeoutMs],
      ["urgent_overtake_limit", host.urgentOvertakeLimit],
      ["folds_per_turn", host.foldsPerTurn],
      ["turn_watchdog_inactivity_ms", turnWatchdog.settings.inactivityMs],
      ["turn_watchdog_abort_grace_ms", turnWatchdog.settings.abortGraceMs],
      ["permission_broker_timeout_ms", broker.timeoutMs],
    ]),
  );
  for (const notice of pendingWorkNotices.splice(0)) {
    instructionChain = instructionChain.then(() => host.send(notice)).catch(() => {});
  }

  // Apply the after_join set_permission_mode that arrived before host was
  // constructed. host.ts (#58) uses `#permissionMode` set before run() as
  // the initial mode, so this call — synchronous pre-run (no SDK query
  // yet) — restores the persisted mode as if it had been applied inline.
  if (pendingPermissionMode !== undefined) {
    void host.setPermissionMode(pendingPermissionMode).catch(() => {});
  }

  // Apply the after_join display_name sync that arrived before host was
  // constructed (issue #187 段階3, renamed issue #209 D19/D23), same
  // reasoning as pendingPermissionMode above.
  if (pendingDisplayNameSync !== undefined) {
    host.renameDisplayName(
      pendingDisplayNameSync.displayName,
      pendingDisplayNameSync.revision,
    );
  }

  process.on("SIGINT", () => {
    void host
      .interrupt()
      .catch(() => {})
      .finally(() => host.close());
  });
  // issue #391 (parity with issue #379's antigravity fix): without a
  // handler, Node's default SIGTERM behavior kills this process immediately
  // -- no close(), no SDK-side child cleanup -- and the runner's stop /
  // delete / restart / reset paths all rely on exactly that signal.
  // close() (not interrupt()) directly: SIGTERM is an external "stop now",
  // not an operator action, so it should not manufacture an
  // interrupt_requested/interrupted settlement for what the operator never
  // asked to interrupt. Registering this handler also suppresses Node's
  // default immediate-exit behavior, so the process naturally stays alive
  // until the SDK's own escalation (see host.ts's `#abort`) finishes the
  // child -- no explicit process.exit() here.
  const onSigterm = (): void => {
    host.close();
  };
  process.on("SIGTERM", onSigterm);

  try {
    // Idle-wait start: the SDK emits nothing until the first turn, so
    // announce idle ourselves — an agent absent from the dashboard
    // cannot receive the instruction that would start that turn.
    if (prompt === undefined) {
      const idle = makeStateChange(
        config, "idle", new Date().toISOString(), {}, host.statusExtSnapshot(),
      );
      printState(idle);
      link?.send(idle);
      void host.probeRateLimits?.();
    }
    // Resume: stamp the session so both the replayed lines and the
    // subsequent live ones group under it, and point the sidecar at that
    // session's file.
    if (resumeSessionId !== undefined) {
      link.setSessionId(resumeSessionId);
      sidecar.bind(resumeSessionId);
    }
    // ADR-0051 D2: the replay itself is server-driven now. The join
    // verdict decides whether one runs at all, on startup AND on every
    // later reconnect (a restarted server asks again); this only says the
    // wrapper is ready to serve one. A legacy server without a verdict
    // falls back to the pre-ADR-0051 startup replay inside the replayer.
    replayer.markReady();
    queueRoot.checkReadiness();
    await host.run(prompt);
  } catch (error) {
    disconnectReason = "crash";
    throw error;
  } finally {
    // issue #391: this process only ever runs one runClaudeCli() in
    // production, but leaving the listener registered would accumulate a
    // stale one per invocation for any caller (tests included) that runs it
    // more than once in the same process, each closing over an
    // already-finished host (issue #379's listener-accumulation lesson).
    process.off("SIGTERM", onSigterm);
    // Deny in-flight permission requests, then release the socket so the
    // process can exit.
    try {
      await link?.flushInterAgentRetirements?.();
    } finally {
      broker?.close();
      questionBroker?.close();
      try {
        await link?.reportDisconnectIntent?.(disconnectReason);
      } finally {
        link?.close();
      }
    }
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runClaudeCli().catch((error: unknown) => {
    writeRedactedStderr(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
