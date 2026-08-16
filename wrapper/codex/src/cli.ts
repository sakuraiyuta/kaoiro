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
  isIngressStamp,
  makeLog,
  makeStateChange,
  mergePendingDisplayNameSync,
} from "@kaoiro/agent-common";
import type {
  Envelope,
  KaoiroState,
  ModelSource,
} from "@kaoiro/agent-common";
import { ServerLink, loadConfig, parseCliArgs } from "@kaoiro/wrapper-core";
import { CodexHost } from "./host.js";
import { handleInterAgentMessage } from "./inter_agent_message_handler.js";
import { CodexInterAgentTurnCoordinator } from "./inter_agent_turn_coordinator.js";
import { readCodexHistory } from "./history.js";
import { codexSidecarPath } from "./rollout.js";
import { effectiveNetworkAccess } from "./network_access.js";
import {
  applyEnvDefaultModel,
  resolveCodexSources,
} from "./source_resolution.js";

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

// issue #219 D25: human-facing log lines show `display_name` (the
// mutable, operator-chosen label), never the pack's canonical
// `persona.name` — see claude-code cli.ts's identical rationale.
function printState(envelope: Envelope): void {
  const color = COLOR[envelope.state];
  const time = envelope.ts.slice(11, 19);
  process.stdout.write(
    `\x1b[${color}m[${time}] ${envelope.display_name}: ${envelope.state}\x1b[0m\n`,
  );
}

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

  // Source vocabulary for ext.model_source / ext.effort_source (ADR-0032
  // F4bc addendum, phase-15 15-4c + phase-23 P1 pair-aware apply).
  // Priority + semantics are pinned in `resolveCodexSources` unit tests
  // (source_resolution.test.ts); CLI just consumes the resolved pair.
  // MUST run before the env-default mutation below — it reads
  // `config.model` to decide "config" vs "env" attribution, and that
  // distinction only exists before the mutation fills the field in.
  const { modelSource: resolvedModelSource, effortSource: resolvedEffortSource } =
    resolveCodexSources(config, envDefaultModel);

  // issue #197 段階3 (ふじ MF-1 レビュー指摘): mutates `config.model` in
  // place rather than cloning into a separate `effectiveConfig` — see
  // `applyEnvDefaultModel`'s own doc for why the split object was a bug
  // (two independently-diverging persona sources of truth after a
  // rename). Every producer below now reads the same, single, mutated
  // `config` object.
  applyEnvDefaultModel(config, envDefaultModel);

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
    const resolvedModel = config.model ?? "<account default>";
    const resolvedModelTag =
      resolvedModelSource !== undefined
        ? `(source=${resolvedModelSource})`
        : "(source=account)";
    const effortPart =
      config.effort !== undefined
        ? ` effort=${config.effort}(source=${resolvedEffortSource ?? "default"})`
        : "";
    const sandbox = config.sandbox ?? "workspace-write";
    const sandboxSource: string =
      config.sandbox !== undefined ? "config" : "default";
    // Sandbox-aware normalization (phase-22 藤 audit, ADR-0033 F3 追補):
    // the raw toggle is meaningful only for workspace-write; danger-full-
    // access always carries network, read-only never does. Same helper as
    // CodexHost's effective-status snapshot (SSoT) so this log line never
    // diverges from ext.effective / whoami.
    const networkAccess = effectiveNetworkAccess(
      sandbox,
      config.network_access ?? false,
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
  // The after_join display_name sync push
  // (WrapperChannel.after_join_handshake, issue #197 段階3, renamed
  // issue #219 D19/D23) can arrive before `host` is constructed below —
  // `personaPromptPromise` is awaited first (same ordering claude-code's
  // cli.ts documents for its own pendingPermissionMode buffer). Buffer it
  // and apply once `host` exists, rather than risk touching an
  // undefined `host` from the handler.
  let pendingDisplayNameSync: { displayName: string; revision: number } | undefined;

  /** Production owner of Codex same-peer batching. Tests instantiate this
   * exact class instead of copying queue state into their harness. */
  const interAgentTurns = new CodexInterAgentTurnCoordinator({
    onDispatch: (batch) => {
      // Register exactly the batch entering the host queue, never a later
      // accepted arrival waiting behind it (issue #221 MF-1).
      for (const item of batch.items) {
        interAgent?.notePendingInjection(item.envelope);
      }
      instructionChain = instructionChain.then(() =>
        host.send(batch.text, undefined, batch.conversationIds).catch((err: unknown) => {
          process.stderr.write(`inter-agent inject failed: ${String(err)}\n`);
          const settled = interAgentTurns.settle(batch.conversationIds);
          const classified = classifyInterAgentError({ detail: String(err) });
          for (const notice of interAgent?.resolveTurnEnd(
            batch.conversationIds,
            classified,
          ) ?? []) {
            link?.send(notice);
          }
          if (settled !== undefined) {
            interAgentTurns.dispatchNextForPeer(settled.peer);
          }
        }),
      );
    },
  });

  const onState = (envelope: Envelope): void => {
    printState(envelope);
    link?.send(envelope);
  };
  const onLog = (envelope: Envelope): void => {
    printLog(envelope);
    link?.send(envelope);
  };
  // Tasklist snapshots, like child task envelopes, are dashboard-only relay
  // data rather than this agent's console transcript.
  const onTask = (envelope: Envelope): void => {
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
    // ADR-0051 D3-2: `send_to_agent`'s result is the server's acceptance
    // ack, not the local push. No link yet means no server took it.
    sendInterAgent: (envelope) =>
      link?.sendInterAgent(envelope) ??
      Promise.resolve({ kind: "unknown" as const, reason: "not_connected" }),
    requestDirectory: () =>
      link?.requestDirectory() ?? Promise.resolve({ agents: [], users: [] }),
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
          config,
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
    onRenameDisplayName: (displayName, revision) => {
      // protocol.md (issue #197 段階3, renamed issue #219 D19/D23):
      // authoritative display_name from the server — fresh-join /
      // reconnect sync OR a live `rename_agent` relay, delivered via
      // EITHER `persona_sync` (legacy) or `display_name_sync` (new,
      // D22 dual-emit). Structural validation already happened in
      // transport.ts; the revision-freshness check happens inside
      // host.renameDisplayName itself (D15). Buffer if `host` is not
      // yet constructed (see pendingDisplayNameSync comment above).
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
    onAttachOpen: (msg) => {
      host.attachOpen(msg);
    },
    onAttachChunk: (payload) => host.attachChunk(payload),
    onAttachClose: (uploadId) => host.attachClose(uploadId),
    onInterAgentMessage: (envelope) =>
      handleInterAgentMessage(
        {
          interAgent,
          recordInboundIa,
          send: (notice) => link?.send(notice),
          inject: (inbound, mode) => interAgentTurns.receive(inbound, mode),
          log: (line) => process.stdout.write(line),
        },
        envelope,
      ),
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

  host = new CodexHost(config, {
    onState,
    onLog,
    onTask,
    // issue #131: resolve exactly the conversation(s) this turn was tagged
    // with (must-fix 1 — turn-scoped, never a sweep of everything pending;
    // extended issue #221 段階3 for a coalesced turn's multiple cids). On
    // error, classify what codex reported (best-effort — no structured
    // reason, only a raw message when one is available) and push the
    // resulting notice envelope(s) straight through ServerLink — this
    // bypasses the model/tool path entirely since the turn just failed to
    // produce one, so no broker approval applies.
    onTurnEnd: ({ conversationIds, error }) => {
      const classified = error ? classifyInterAgentError(error) : undefined;
      for (const envelope of interAgent?.resolveTurnEnd(
        conversationIds,
        classified,
      ) ?? []) {
        link?.send(envelope);
      }
      // The coordinator releases its exact production batch only after the
      // pending CIDs above have resolved; a later same-CID batch can then be
      // dispatched without overwriting its predecessor's pending record.
      const settled = interAgentTurns.settle(conversationIds);
      if (settled !== undefined) {
        interAgentTurns.dispatchNextForPeer(settled.peer);
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
    ...(config.resume_snapshot !== undefined
      ? { resumeSnapshot: config.resume_snapshot }
      : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
  });

  // Apply the after_join display_name sync that arrived before host was
  // constructed (issue #197 段階3, renamed issue #219 D19/D23), same
  // reasoning as pendingDisplayNameSync above.
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

  try {
    // Idle-wait start, matching the Claude CLI: announce idle so the agent
    // appears on the dashboard before its first turn.
    if (prompt === undefined) {
      const idle = makeStateChange(
        config, "idle", new Date().toISOString(), {},
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
