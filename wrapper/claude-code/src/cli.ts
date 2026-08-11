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
// (specs/threat-model.md).
//
// Usage: node dist/cli.js [configPath] [prompt] [--resume <session_id>]

import { randomUUID } from "node:crypto";
import { parseCliArgs } from "@kaoiro/wrapper-core";
import { readSessionHistory, sessionSidecarPath } from "./history.js";
import { AgentHost, CLAUDE_EFFORT_LEVELS } from "./host.js";
import {
  HistoryReplayer,
  IaSidecar,
  InterAgentTool,
  classifyInterAgentError,
  formatInboundMessage,
  isIngressStamp,
} from "@kaoiro/agent-common";
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
} from "./request_session_reset.js";
import { PermissionBroker } from "@kaoiro/agent-common";
import { PERMISSION_MODES, loadConfig } from "@kaoiro/wrapper-core";
import { QuestionBroker } from "@kaoiro/agent-common";
import {
  makeLog,
  makeRefreshModelsResult,
  makeStateChange,
} from "@kaoiro/agent-common";
import { ServerLink } from "@kaoiro/wrapper-core";
import { resolveClaudeSources } from "./source_resolution.js";
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

function printState(envelope: Envelope): void {
  const color = COLOR[envelope.state];
  const time = envelope.ts.slice(11, 19);
  const name = envelope.persona.name;
  process.stdout.write(
    `\x1b[${color}m[${time}] ${name}: ${envelope.state}\x1b[0m\n`,
  );
}

// Echo the reply stream so a local run shows what the agent answered, not
// just its state. tool input/output stay off the terminal (the state line
// already marks tool_running); they ride the envelope to the dashboard.
function printLog(envelope: Envelope): void {
  const time = envelope.ts.slice(11, 19);
  const name = envelope.persona.name;
  const payload = envelope.payload;
  if (envelope.type === "result") {
    const text = typeof payload.text === "string" ? payload.text : "(no text)";
    process.stdout.write(`\x1b[37m[${time}] ${name} -> ${text}\x1b[0m\n`);
  } else if (payload.kind === "assistant" && typeof payload.text === "string") {
    process.stdout.write(`\x1b[37m[${time}] ${name}: ${payload.text}\x1b[0m\n`);
  }
}

async function main(): Promise<void> {
  const { configPath, prompt: promptArg, resume: resumeSessionId } =
    parseCliArgs(process.argv.slice(2));
  const config = loadConfig(configPath);

  // Engine-split default-model env (ADR-0032 F4bc addendum, phase-15 D1).
  // TODO(#103): drop the legacy KAOIRO_WRAPPER_DEFAULT_MODEL read and its
  // deprecation warn one release after the engine-split env ships.
  const envDefaultModel =
    process.env.KAOIRO_CLAUDE_CODE_DEFAULT_MODEL ??
    process.env.KAOIRO_WRAPPER_DEFAULT_MODEL;
  if (
    process.env.KAOIRO_CLAUDE_CODE_DEFAULT_MODEL === undefined &&
    process.env.KAOIRO_WRAPPER_DEFAULT_MODEL !== undefined
  ) {
    process.stderr.write(
      "deprecation warn: KAOIRO_WRAPPER_DEFAULT_MODEL is deprecated; " +
        "use KAOIRO_CLAUDE_CODE_DEFAULT_MODEL instead (removal: #103)\n",
    );
  }

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
  for (const w of sources.warnings) process.stderr.write(w);

  // Engine-mismatch config warns (phase-15 15-7). Codex-only fields
  // (sandbox, network_access) surface loudly instead of being silently
  // ignored when written into a Claude config, so operator settings never
  // disappear into a black hole (D3 rationale).
  if (config.sandbox !== undefined) {
    process.stderr.write(
      "config warn: sandbox is codex-only, ignored on claude-code\n",
    );
  }
  if (config.network_access !== undefined) {
    process.stderr.write(
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
    process.stderr.write(
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
  let link: ServerLink | null = null;
  let broker: PermissionBroker | null = null;
  let questionBroker: QuestionBroker | null = null;
  let interAgent: InterAgentTool | null = null;
  // The server's after_join pushes persona_prompt then set_permission_mode
  // (WrapperChannel.handle_info(:after_join)); both frames can be dispatched
  // by the Phoenix socket in the same event-loop tick before the
  // await-personaPromptPromise below has a chance to resume and construct
  // `host`. Buffer the persisted mode instead of touching `host` here; the
  // buffered value is applied after AgentHost is constructed, before
  // host.run(), so host.ts's "setPermissionMode before run() sets initial
  // mode" contract still holds (host.ts #58 source order).
  let pendingPermissionMode: PermissionMode | undefined;
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

  /** Wrapper-authored operator line (phase-28 A1's `system` log kind). */
  const emitSystemLog = (text: string): void => {
    onLog(
      makeLog(config, host?.state ?? "idle", new Date().toISOString(), {
        kind: "system",
        text,
      }),
    );
  };

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
  interAgent = new InterAgentTool({
    config,
    getState: () => host.state,
    send: (envelope) => link?.send(envelope),
    // ADR-0051 D3-2: `send_to_agent`'s result is the server's acceptance
    // ack, not the local push. No link yet means no server took it.
    sendInterAgent: (envelope) =>
      link?.sendInterAgent(envelope) ??
      Promise.resolve({ kind: "unknown" as const, reason: "not_connected" }),
    // Wired below once host + link are constructed; until then the tools
    // return error/fallback results, which is correct because the SDK
    // session has not opened yet either.
    requestDirectory: () => link?.requestDirectory() ?? Promise.resolve([]),
    getWhoami: () => host.statusSnapshot(),
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
      process.stderr.write(
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

  link = new ServerLink(config.server_url, config.agent_id, {
    personaId: config.persona.id,
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
    onInstruction: (text, attachmentIds) => {
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
        host.send(text, attachmentIds).catch((err: unknown) => {
          process.stderr.write(`send failed: ${String(err)}\n`);
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
              process.stderr.write(
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
    // issue #177 review round 2 (ふじ差し戻し): async — receiveInbound() may
    // gate briefly on a concurrently in-flight done=true send_to_agent for
    // the same conversation_id, so it must be awaited before this handler
    // acts on the disposition (host.send / notePendingInjection). The
    // caller (transport.ts) does not await onInterAgentMessage — an async
    // handler here is still fire-and-forget from its perspective, exactly
    // as the previous synchronous one was.
    onInterAgentMessage: async (envelope) => {
      // Record BEFORE anything consumes the envelope (ADR-0051 D3-2): the
      // sidecar documents what the server delivered, so a later injection
      // failure leaving only the record is the correct outcome, not a bug.
      recordInboundIa(envelope);
      const disposition = (await interAgent?.receiveInbound(envelope)) ?? {
        consumed: false,
        inject: true,
        mode: "reply-owed" as const,
      };
      if (disposition.consumed) {
        process.stdout.write(`  inter_agent_message reply consumed: ${envelope.agent_id}\n`);
        return;
      }
      // issue #177 AC9: a late/stale/duplicate turn_number is neither a
      // fresh reply nor owed one — drop it without touching the SDK queue.
      if (!disposition.inject) {
        process.stdout.write(
          `  inter_agent_message stale/duplicate turn dropped: ${envelope.agent_id}\n`,
        );
        return;
      }
      // Server routed an inter_agent_message to this wrapper (peer reply or
      // synthesized escalate-to-user). Track the inbound turn_number so our
      // next outbound send_to_agent stays monotonic, then inject the
      // formatted text as a new SDK turn (protocol-inter-agent spec
      // 「受信側の挙動」). The host serialises through instructionChain so a
      // mid-PDF render cannot reorder this against an operator instruction.
      const text = formatInboundMessage(envelope, { mode: disposition.mode });
      process.stdout.write(`  inter_agent_message: ${envelope.agent_id}\n`);
      // issue #131: this wrapper now owes a reply on the conversation. Tag
      // the queued turn with the conversation_id (must-fix 1: turn-scoped
      // resolution) so onTurnEnd below resolves exactly THIS turn, not
      // whatever else happens to be pending — send() ties the tag to this
      // specific queue slot, not to "the next turn" in general.
      const conversationId = (
        envelope.payload as Partial<InterAgentMessagePayload>
      ).conversation_id;
      // issue #177 AC8: a terminal (both-done) message owes no reply, so it
      // must not be tracked as a pending injection — that would make a
      // silent (correctly unanswered) turn look like a failure to
      // resolveTurnEnd() and produce a spurious error notice.
      if (disposition.mode !== "terminal") {
        interAgent?.notePendingInjection(envelope);
      }
      void enqueueInstruction(() =>
        host.send(text, undefined, conversationId).catch((err: unknown) => {
          process.stderr.write(`inter-agent inject failed: ${String(err)}\n`);
          // issue #136: host.send() rejecting here (e.g. MAX_QUEUED_TURNS
          // overflow) means the injection never reached the SDK queue, so
          // no turn will ever run for this conversation_id and onTurnEnd's
          // resolveTurnEnd() below never fires for it either — the entry
          // notePendingInjection just set would otherwise stay in the
          // pending map forever. Resolve it here the same way a turn that
          // ran and errored is resolved, so the peer gets a peer_error
          // notice instead of silence.
          const classified = classifyInterAgentError({ detail: String(err) });
          for (const notice of interAgent?.resolveTurnEnd(
            conversationId ?? null,
            classified,
          ) ?? []) {
            link?.send(notice);
          }
        }),
      );
    },
  });

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
    link?.close();
    broker?.close();
    questionBroker?.close();
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  host = new AgentHost(config, {
    onState,
    onLog,
    onTask,
    // phase-28 BR MF2: the B1 threshold notice is an injection like any
    // other, so it queues on the one chain instead of racing it.
    enqueueInjection: enqueueInstruction,
    // issue #131: resolve exactly the conversation this turn was tagged
    // with (must-fix 1 — turn-scoped, never a sweep of everything pending).
    // On error, classify what the SDK reported and push the resulting
    // notice envelope straight through ServerLink — this bypasses the
    // model/tool path entirely since the model just failed to produce a
    // turn at all, so no broker approval applies.
    onTurnEnd: ({ conversationId, error }) => {
      const classified = error ? classifyInterAgentError(error) : undefined;
      for (const envelope of interAgent?.resolveTurnEnd(
        conversationId,
        classified,
      ) ?? []) {
        link?.send(envelope);
      }
      // phase-28 C2 / ADR-0043 D3: this is the wrapper's own turn boundary —
      // the result has been processed and nothing is mid-flight. An approved
      // session reset fires here and nowhere else, so a relaunch can never
      // cut a turn in half.
      sessionReset.onTurnEnd();
    },
    appendSystemPrompt,
    // Keep Query unconstructed during fresh idle so AgentDetail model /
    // effort picks become the first turn's Options, not initialization-bound
    // SDK control requests (#110).
    deferQueryUntilFirstInput: prompt === undefined,
    // attach_rejected / instruction_rejected ride the same envelope path
    // as state/log — the link relays them to the server (file-upload spec).
    onAttachRejected: (envelope) => link?.send(envelope),
    onInstructionRejected: (envelope) => link?.send(envelope),
    onSessionId: (id) => {
      link?.setSessionId(id);
      // Binds (or re-binds) the sidecar to this session's file, carrying
      // whatever the pending journal already holds (ADR-0051 D3-5).
      sidecar.bind(id);
    },
    decidePermission: (toolName, input) => broker!.decide(toolName, input),
    // AskUserQuestion path (ADR-0027): server-connected wrappers always
    // have a question broker, so route through it directly.
    decideQuestion: (questions) => questionBroker!.decide(questions),
    // issue #175 (ADR-0044 F2 追補): conversation-unit send_to_agent
    // auto-allow — InterAgentTool owns the per-(conversation_id, to)
    // flag (issue #175 review, ふじ M2).
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
      // default. The engine-split env KAOIRO_CLAUDE_CODE_DEFAULT_MODEL is
      // primary; legacy KAOIRO_WRAPPER_DEFAULT_MODEL still resolves for
      // one release window with a deprecation warn (tracked in issue
      // #103, removed next release). Dashboard controls can still override
      // model / effort at runtime.
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
        kaoiro: buildKaoiroMcpServer(interAgent!, [
          {
            descriptor: requestCompactDescriptor({
              // Ride the same chain operator instructions use, so an approved
              // /compact cannot overtake an instruction still rendering its
              // attachments. Awaiting the queued promise lets the tool report
              // a closed or full queue instead of claiming a reservation it
              // never made.
              send: (text) => enqueueInstruction(() => host.send(text)),
            }),
            inputShape: REQUEST_COMPACT_INPUT_SHAPE,
          },
          {
            descriptor: requestSessionResetDescriptor({
              reserve: (mode, reason) => sessionReset.reserve(mode, reason),
            }),
            inputShape: REQUEST_SESSION_RESET_INPUT_SHAPE,
          },
        ]),
      },
      ...(resumeSessionId !== undefined ? { resume: resumeSessionId } : {}),
    },
  });

  // Apply the after_join set_permission_mode that arrived before host was
  // constructed. host.ts (#58) uses `#permissionMode` set before run() as
  // the initial mode, so this call — synchronous pre-run (no SDK query
  // yet) — restores the persisted mode as if it had been applied inline.
  if (pendingPermissionMode !== undefined) {
    void host.setPermissionMode(pendingPermissionMode).catch(() => {});
  }

  process.on("SIGINT", () => {
    void host
      .interrupt()
      .catch(() => {})
      .finally(() => host.close());
  });

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
    await host.run(prompt);
  } finally {
    // Deny in-flight permission requests, then release the socket so the
    // process can exit.
    broker?.close();
    questionBroker?.close();
    link?.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
