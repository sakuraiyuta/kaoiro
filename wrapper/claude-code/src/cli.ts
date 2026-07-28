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
// the canUseTool ask path — when that path fires (issue #1), the decision
// comes from the server's approval flow (PermissionBroker), defaulting to
// deny on timeout. The ceiling cannot be widened from the server side
// (specs/threat-model.md).
//
// Usage: node dist/cli.js [configPath] [prompt] [--resume <session_id>]

import { parseCliArgs } from "@kaoiro/wrapper-core";
import { readSessionHistory } from "./history.js";
import { AgentHost, CLAUDE_EFFORT_LEVELS } from "./host.js";
import {
  InterAgentTool,
  classifyInterAgentError,
  formatInboundMessage,
} from "@kaoiro/agent-common";
import { buildKaoiroMcpServer } from "./inter_agent_sdk.js";
import { READ_ONLY_TOOLS } from "./read_only_tools.js";
import { requestCompactDescriptor } from "./request_compact.js";
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
    // Wired below once host + link are constructed; until then the tools
    // return error/fallback results, which is correct because the SDK
    // session has not opened yet either.
    requestDirectory: () => link?.requestDirectory() ?? Promise.resolve([]),
    getWhoami: () => host.statusSnapshot(),
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
    onInterAgentMessage: (envelope) => {
      if (interAgent?.receiveInbound(envelope)) {
        process.stdout.write(`  inter_agent_message reply consumed: ${envelope.agent_id}\n`);
        return;
      }
      // Server routed an inter_agent_message to this wrapper (peer reply or
      // synthesized escalate-to-user). Track the inbound turn_number so our
      // next outbound send_to_agent stays monotonic, then inject the
      // formatted text as a new SDK turn (protocol-inter-agent spec
      // 「受信側の挙動」). The host serialises through instructionChain so a
      // mid-PDF render cannot reorder this against an operator instruction.
      const text = formatInboundMessage(envelope);
      process.stdout.write(`  inter_agent_message: ${envelope.agent_id}\n`);
      // issue #131: this wrapper now owes a reply on the conversation. Tag
      // the queued turn with the conversation_id (must-fix 1: turn-scoped
      // resolution) so onTurnEnd below resolves exactly THIS turn, not
      // whatever else happens to be pending — send() ties the tag to this
      // specific queue slot, not to "the next turn" in general.
      const conversationId = (
        envelope.payload as Partial<InterAgentMessagePayload>
      ).conversation_id;
      interAgent?.notePendingInjection(envelope);
      void enqueueInstruction(() =>
        host.send(text, undefined, conversationId).catch((err: unknown) => {
          process.stderr.write(`inter-agent inject failed: ${String(err)}\n`);
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
    onSessionId: (id) => link?.setSessionId(id),
    decidePermission: (toolName, input) => broker!.decide(toolName, input),
    // AskUserQuestion path (ADR-0027): server-connected wrappers always
    // have a question broker, so route through it directly.
    decideQuestion: (questions) => questionBroker!.decide(questions),
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
      // allowedTools, so canUseTool fires and the broker runs the
      // per-call operator dialog (Phase 1 都度承認). request_compact
      // (phase-28 B2) is gated the same way — its absence from
      // READ_ONLY_TOOLS (read_only_tools.ts) is what makes it 都度承認, so
      // do not add it there.
      mcpServers: {
        kaoiro: buildKaoiroMcpServer(
          interAgent!,
          requestCompactDescriptor({
            // Ride the same chain operator instructions use, so an approved
            // /compact cannot overtake an instruction still rendering its
            // attachments. Awaiting `queued` lets the tool report a closed
            // or full queue instead of claiming a reservation it never made.
            send: (text) => enqueueInstruction(() => host.send(text)),
          }),
        ),
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
    // Resume: rebuild the server's display history from the session JSONL
    // (ADR-0014 phase-2, #50). The SDK does not replay past turns into the
    // stream, so reconstruct them from disk and reset-then-replay — a server
    // that kept the pre-crash lines for the same session must not double
    // them. setSessionId stamps the resume id so both the replayed lines and
    // the subsequent live ones group under this session.
    if (resumeSessionId !== undefined) {
      link.setSessionId(resumeSessionId);
      // The reset/replay need a server entry to attach to (append_log /
      // reset_history are :noop without one). The idle announce above seeds
      // it, but only in the no-prompt idle-wait mode; a resume that also
      // carries a prompt (spawn with initial_prompt + resume_session_id)
      // skipped it, so seed the entry here before the reset.
      if (prompt !== undefined) {
        link.send(makeStateChange(
          config, "idle", new Date().toISOString(), {}, host.statusExtSnapshot(),
        ));
      }
      const history = readSessionHistory(process.cwd(), resumeSessionId, config);
      // Reset first — unconditionally on resume — so a server still holding
      // this session's pre-crash lines is overwritten even when
      // reconstruction yields nothing (e.g. a transcript of only bookkeeping
      // lines); then replay whatever was rebuilt.
      const replayId = link.sendHistoryReset();
      for (const envelope of history) link.send(envelope);
      link.sendHistoryReplayComplete(replayId);
    }
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
