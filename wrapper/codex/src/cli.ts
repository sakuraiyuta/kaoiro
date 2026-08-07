// Codex wrapper CLI — the composition root of the codex engine: loads the
// config, connects the ServerLink, waits fail-closed for the server-pushed
// personality (ADR-0029 F3), then drives a CodexHost. Mirrors the Claude
// composition (@kaoiro/claude-code/src/cli.ts) minus the Claude-only parts:
// no permission broker wiring (approval is launch-fixed, ADR-0033 F3), no
// image-only upload rendering, rollout history replay.
//
// Usage: node dist/cli.js [configPath] [prompt] [--resume <session_id>]

import { randomUUID } from "node:crypto";
import {
  HistoryReplayer,
  IaSidecar,
  InterAgentTool,
  QuestionBroker,
  askUserQuestionDescriptor,
  classifyInterAgentError,
  formatInboundMessage,
  isIngressStamp,
  makeLog,
  makeStateChange,
} from "@kaoiro/agent-common";
import type {
  Envelope,
  InterAgentMessagePayload,
  KaoiroState,
  ModelSource,
} from "@kaoiro/agent-common";
import { ServerLink, loadConfig, parseCliArgs } from "@kaoiro/wrapper-core";
import { CodexHost } from "./host.js";
import { readCodexHistory } from "./history.js";
import { codexSidecarPath } from "./rollout.js";
import { effectiveNetworkAccess } from "./network_access.js";
import { resolveCodexSources } from "./source_resolution.js";

const COLOR: Record<KaoiroState, string> = {
  idle: "90",
  sending: "93",
  thinking: "36",
  tool_running: "33",
  waiting_permission: "35",
  waiting_question: "95",
  waiting_input: "32",
  done: "92",
  error: "31",
};

/** Upper bound on the wait for the server's `persona_prompt` push after
 *  join (ADR-0029 F3, fail-closed). Matches the Claude CLI. */
const PERSONA_PROMPT_TIMEOUT_MS = 10_000;

function printState(envelope: Envelope): void {
  const color = COLOR[envelope.state];
  const time = envelope.ts.slice(11, 19);
  process.stdout.write(
    `\x1b[${color}m[${time}] ${envelope.persona.name}: ${envelope.state}\x1b[0m\n`,
  );
}

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
  const { configPath, prompt, resume: resumeSessionId } = parseCliArgs(
    process.argv.slice(2),
  );
  const config = loadConfig(configPath);

  // Codex CLI env source (ADR-0032 F4bc addendum, phase-15 15-3):
  // KAOIRO_CODEX_DEFAULT_MODEL is the env-tier default, applied when
  // config.model is unset. Legacy KAOIRO_WRAPPER_DEFAULT_MODEL is
  // deliberately NOT read here — it may hold a claude-* value that would
  // fail with 400/404 under Codex ChatGPT auth (codex-model-catalog.md).
  // Resolution: launch (config.model, SpawnMessage relay) > env > engine
  // account default. Model source stamping to ext.model_source lands in
  // 15-4c.
  const envDefaultModel = process.env.KAOIRO_CODEX_DEFAULT_MODEL;
  const effectiveConfig: typeof config =
    config.model === undefined && envDefaultModel !== undefined
      ? { ...config, model: envDefaultModel }
      : config;

  // Source vocabulary for ext.model_source / ext.effort_source (ADR-0032
  // F4bc addendum, phase-15 15-4c + phase-23 P1 pair-aware apply).
  // Priority + semantics are pinned in `resolveCodexSources` unit tests
  // (source_resolution.test.ts); CLI just consumes the resolved pair.
  const { modelSource: resolvedModelSource, effortSource: resolvedEffortSource } =
    resolveCodexSources(config, envDefaultModel);

  // Engine-mismatch config warns (phase-15 15-6). Claude-only fields
  // (permission_mode, allowed_tools) surface loudly instead of being
  // silently ignored when written into a Codex config (D3 rationale).
  if (config.permission_mode !== undefined) {
    process.stderr.write(
      "config warn: permission_mode is claude-code-only, ignored on codex\n",
    );
  }
  if (config.allowed_tools !== undefined) {
    process.stderr.write(
      "config warn: allowed_tools is claude-code-only, ignored on codex\n",
    );
  }

  // Startup resolved-config summary (phase-15 15-5): one stderr line with
  // the engine-relevant fields and their source tags. approval is
  // host-fixed to "never" on Codex (ADR-0033 F3); effort is included only
  // when explicitly resolved. ignored-flags mark claude-only fields when
  // they were nonetheless supplied.
  {
    const resolvedModel = effectiveConfig.model ?? "<account default>";
    const resolvedModelTag =
      resolvedModelSource !== undefined
        ? `(source=${resolvedModelSource})`
        : "(source=account)";
    const effortPart =
      effectiveConfig.effort !== undefined
        ? ` effort=${effectiveConfig.effort}(source=${resolvedEffortSource ?? "default"})`
        : "";
    const sandbox = effectiveConfig.sandbox ?? "workspace-write";
    const sandboxSource: string =
      config.sandbox !== undefined ? "config" : "default";
    // Sandbox-aware normalization (phase-22 藤 audit, ADR-0033 F3 追補):
    // the raw toggle is meaningful only for workspace-write; danger-full-
    // access always carries network, read-only never does. Same helper as
    // CodexHost's effective-status snapshot (SSoT) so this log line never
    // diverges from ext.effective / whoami.
    const networkAccess = effectiveNetworkAccess(
      sandbox,
      effectiveConfig.network_access ?? false,
    );
    const permissionModePart =
      config.permission_mode !== undefined
        ? ` permission_mode=${config.permission_mode}(ignored)`
        : "";
    const allowedToolsPart =
      config.allowed_tools !== undefined
        ? ` allowed_tools=${config.allowed_tools.length}(ignored)`
        : "";
    process.stderr.write(
      `[wrapper resolved] engine=codex ` +
        `model=${resolvedModel}${resolvedModelTag}${effortPart} ` +
        `sandbox=${sandbox}(source=${sandboxSource}) ` +
        `network_access=${networkAccess} ` +
        `approval=never(host-fixed)` +
        `${permissionModePart}${allowedToolsPart} ` +
        `persona=${config.persona.id}\n`,
    );
  }

  let host: CodexHost;
  let link: ServerLink | null = null;
  let questionBroker: QuestionBroker | null = null;
  let interAgent: InterAgentTool | null = null;
  let instructionChain: Promise<void> = Promise.resolve();

  const onState = (envelope: Envelope): void => {
    printState(envelope);
    link?.send(envelope);
  };
  const onLog = (envelope: Envelope): void => {
    printLog(envelope);
    link?.send(envelope);
  };

  let resolvePersonaPrompt!: (prompt: string) => void;
  let rejectPersonaPrompt!: (reason: Error) => void;
  const personaPromptPromise = new Promise<string>((resolve, reject) => {
    resolvePersonaPrompt = resolve;
    rejectPersonaPrompt = reject;
  });

  questionBroker = new QuestionBroker({
    config,
    send: (envelope) => link?.send(envelope),
    // Stamps ext.pending_question AND drives waiting_question on codex —
    // CodexHost derives the state from this signal (no canUseTool hook).
    onPendingChange: (pending) => host?.setPendingQuestion(pending),
  });
  interAgent = new InterAgentTool({
    config,
    getState: () => host.state,
    send: (envelope) => link?.send(envelope),
    requestDirectory: () => link?.requestDirectory() ?? Promise.resolve([]),
    getWhoami: () => host.statusSnapshot(),
  });
  // ADR-0051 D3-2 / D3-5 — same contract as the Claude wrapper, with the
  // codex rollout directory as the sidecar's home. That directory is
  // date-nested and only resolvable once the rollout exists, which is
  // exactly what the pending journal covers.
  const sidecar = new IaSidecar({
    agentId: config.agent_id,
    generation: config.transition_id ?? randomUUID(),
    resolveSessionPath: (sessionId) => codexSidecarPath(sessionId),
  });

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

  // Constructed before the link: the join reply can arrive before `host`
  // exists, so the verdict has to be held until markReady() (ADR-0051 D2).
  const replayer = new HistoryReplayer({
    seedState: () =>
      link?.send(
        makeStateChange(
          effectiveConfig,
          host?.state ?? "idle",
          new Date().toISOString(),
          {},
          host?.statusExtSnapshot() ?? {},
        ),
      ),
    sessionId: () => link?.currentSessionId() ?? null,
    readTranscript: (sessionId) => readCodexHistory(sessionId, config),
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
      onLog(
        makeLog(config, host.state, new Date().toISOString(), {
          kind: "user",
          text,
        }),
      );
      instructionChain = instructionChain.then(() =>
        host.send(text, attachmentIds).catch((err: unknown) => {
          process.stderr.write(`send failed: ${String(err)}\n`);
        }),
      );
    },
    onQuestionResponse: (response) => questionBroker?.resolve(response),
    onInterrupt: () => {
      process.stdout.write("  interrupt\n");
      void host.interrupt().catch(() => {});
    },
    onSetModel: (value) => {
      process.stdout.write(`  set_model: ${value}\n`);
      void host.setModel(value).catch(() => {});
    },
    onSetEffort: (level) => {
      process.stdout.write(`  set_effort: ${level}\n`);
      void host.setEffort(level).catch(() => {});
    },
    onSetPermissionMode: (mode) => {
      // Claude-mode pushes (server after_join restores a persisted pick)
      // do not apply to codex: permission is launch-fixed (ADR-0033 F3).
      process.stdout.write(
        `  set_permission_mode: ignored (codex is launch-fixed): ${mode}\n`,
      );
    },
    onAttachOpen: (msg) => {
      host.attachOpen(msg);
    },
    onAttachChunk: (payload) => host.attachChunk(payload),
    onAttachClose: (uploadId) => host.attachClose(uploadId),
    onInterAgentMessage: (envelope) => {
      // Recorded before anything consumes it (ADR-0051 D3-2 receive side).
      recordInboundIa(envelope);
      if (interAgent?.receiveInbound(envelope)) {
        process.stdout.write(`  inter_agent_message reply consumed: ${envelope.agent_id}\n`);
        return;
      }
      const text = formatInboundMessage(envelope);
      process.stdout.write(`  inter_agent_message: ${envelope.agent_id}\n`);
      // issue #131: this wrapper now owes a reply on the conversation. Tag
      // the queued turn with the conversation_id (must-fix 1: turn-scoped
      // resolution) so onTurnEnd below resolves exactly THIS turn, not
      // whatever else happens to be pending.
      const conversationId = (
        envelope.payload as Partial<InterAgentMessagePayload>
      ).conversation_id;
      interAgent?.notePendingInjection(envelope);
      instructionChain = instructionChain.then(() =>
        host.send(text, undefined, conversationId).catch((err: unknown) => {
          process.stderr.write(`inter-agent inject failed: ${String(err)}\n`);
          // issue #136: host.send() rejecting here means the injection
          // never reached the queue, so no turn will ever run for this
          // conversation_id and onTurnEnd's resolveTurnEnd() below never
          // fires for it either — the entry notePendingInjection just set
          // would otherwise stay in the pending map forever. Resolve it
          // here the same way a turn that ran and errored is resolved, so
          // the peer gets a peer_error notice instead of silence.
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
    link?.close();
    questionBroker?.close();
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  host = new CodexHost(effectiveConfig, {
    onState,
    onLog,
    // issue #131: resolve exactly the conversation this turn was tagged
    // with (must-fix 1 — turn-scoped, never a sweep of everything pending).
    // On error, classify what codex reported (best-effort — no structured
    // reason, only a raw message when one is available) and push the
    // resulting notice envelope straight through ServerLink — this bypasses
    // the model/tool path entirely since the turn just failed to produce
    // one, so no broker approval applies.
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
    onInstructionRejected: (envelope) => link?.send(envelope),
    onAttachRejected: (envelope) => link?.send(envelope),
    onSessionId: (id) => {
      link?.setSessionId(id);
      sidecar.bind(id);
    },
    toolDescriptors: [
      ...interAgent.descriptors(),
      askUserQuestionDescriptor((questions) => questionBroker!.decide(questions)),
    ],
    ...(resolvedModelSource !== undefined
      ? { modelSource: resolvedModelSource }
      : {}),
    ...(resolvedEffortSource !== undefined
      ? { effortSource: resolvedEffortSource }
      : {}),
    // Resume snapshot relayed by the runner on a resume launch (ADR-0014
    // F1 追補, phase-15 D8). Undefined on a fresh spawn.
    ...(effectiveConfig.resume_snapshot !== undefined
      ? { resumeSnapshot: effectiveConfig.resume_snapshot }
      : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
  });

  process.on("SIGINT", () => {
    void host
      .interrupt()
      .catch(() => {})
      .finally(() => host.close());
  });

  try {
    // Idle-wait start, matching the Claude CLI: announce idle so the agent
    // appears on the dashboard before its first turn.
    if (prompt === undefined) {
      const idle = makeStateChange(
        effectiveConfig, "idle", new Date().toISOString(), {},
        host.statusExtSnapshot(),
      );
      printState(idle);
      link?.send(idle);
    }
    // resumeThread continues only future turns; the display transcript is
    // rebuilt from the rollout by the replay below (#106).
    if (resumeSessionId !== undefined) {
      link.setSessionId(resumeSessionId);
      sidecar.bind(resumeSessionId);
    }
    // ADR-0051 D2: the server's join verdict decides whether a replay runs,
    // on startup and on every later reconnect. See the Claude CLI for the
    // rationale; the two wrappers share the coordinator.
    replayer.markReady();
    await host.run(prompt);
  } finally {
    questionBroker?.close();
    link?.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
