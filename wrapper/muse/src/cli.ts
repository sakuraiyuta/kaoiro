import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { PermissionMode, PermissionSelection } from "@kaoiro/protocol";
import {
  askUserQuestionDescriptor,
  classifyInterAgentError,
  createDeliveryAcknowledgementRuntime,
  formatInboundMessage,
  InterAgentTool,
  makeLog,
  makeStateChange,
  mergePendingDisplayNameSync,
  operatorApprovalGated,
  PermissionBroker,
  QuestionBroker,
  REQUEST_SESSION_RESET_TOOL_FQN,
  requestSessionResetDescriptor,
  SessionResetCoordinator,
  validateRequestSessionResetInput,
  writeRedactedStderr,
  type Envelope,
  type ToolDescriptor,
  type WhoamiSnapshot,
} from "@kaoiro/agent-common";
import { UploadIntake } from "@kaoiro/agent-common/dist/upload.js";
import {
  loadConfig,
  loadWrapperBuildInfo,
  parseCliArgs,
  RecoveryReporter,
  ServerLink,
  shutdownForRecovery,
  type ServerLinkOptions,
} from "@kaoiro/wrapper-core";
import { MuseHost, type MuseHostOptions } from "./host.js";
import { MuseHistoryReplay } from "./history_replay.js";

export interface MuseCliDependencies {
  parseCliArgs?: typeof parseCliArgs;
  loadConfig?: typeof loadConfig;
  loadWrapperBuildInfo?: typeof loadWrapperBuildInfo;
  createServerLink?: (
    ...args: ConstructorParameters<typeof ServerLink>
  ) => ServerLink;
  createHost?: (options: MuseHostOptions) => MuseHost;
  onHostCreated?: (host: MuseHost) => void;
  onMetadata?: (metadata: { direction: string; method?: string; variant?: string }) => void;
  additionalTools?: ToolDescriptor[];
  cwd?: string;
}

export async function runMuseCli(
  dependencies: MuseCliDependencies = {},
  argv: string[] = process.argv.slice(2),
) {
  const { configPath } = (dependencies.parseCliArgs ?? parseCliArgs)(argv);
  const config = (dependencies.loadConfig ?? loadConfig)(configPath, {
    museEffortWarning: true,
  });
  const resumeSessionId = config.resume_session_id;
  const buildInfo = (dependencies.loadWrapperBuildInfo ?? loadWrapperBuildInfo)(
    fileURLToPath(new URL("../dist/build-info.json", import.meta.url)),
  );
  let host: MuseHost | undefined;
  let link: ServerLink | undefined;
  const recovery = new RecoveryReporter(config, resumeSessionId, (failure) => {
    void shutdownForRecovery(failure, () => host?.close(),
      () => link?.reportDisconnectIntent("crash"), () => { link?.close(); }).catch(() => {});
  }, true);
  if (recovery.failure) throw recovery.failure;
  let pendingName: { displayName: string; revision: number } | undefined;
  let chain: Promise<void> = Promise.resolve();
  let ready!: () => void;
  const hostReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const deliveries = new Map<string, Envelope[]>();
  const send = (envelope: Envelope) => replayer.sendLiveLog(envelope);
  const replayer = new MuseHistoryReplay({
    schedule: job => host?.scheduleHistoryReplay(job),
    captureFence: () => link?.captureHistoryReplayFence?.() ?? (() => false),
    seedState: () => link?.send(makeStateChange(
      config, host?.state ?? "idle", new Date().toISOString(), {},
      host?.statusExtSnapshot() ?? {},
    )),
    sessionId: () => link?.currentSessionId() ?? null,
    readSidecar: () => [],
    sendHistoryReset: id => link?.sendHistoryReset(id),
    sendEnvelope: envelope => link?.send(envelope),
    sendReplayIa: (id, items) => link?.sendReplayIa(id, items),
    sendHistoryReplayComplete: id => link?.sendHistoryReplayComplete(id),
    ...(resumeSessionId ? { legacyResumeSessionId: resumeSessionId } : {}),
  });
  const cwd = dependencies.cwd ?? process.cwd();
  const intake = new UploadIntake({
    config,
    send,
    state: () => host?.state ?? "idle",
    acceptsMime: (mime) => host?.acceptsAttachmentMime(mime) === true,
  });
  const permission = new PermissionBroker({
    config,
    send,
    onPendingChange: (pending) => host?.setPendingPermission(pending),
  });
  const question = new QuestionBroker({
    config,
    send,
    onPendingChange: (pending) => host?.setPendingQuestion(pending),
  });
  const sessionReset = new SessionResetCoordinator({
    request: (mode, reason) => link
      ? link.requestSessionReset(mode, reason)
      : Promise.reject(new Error("server link unavailable")),
    notify: (text) => {
      const queued = chain.then(async () => {
        await hostReady;
        await host!.send(text);
      });
      chain = queued.catch(() => {});
      return queued;
    },
    log: (text) => writeRedactedStderr(`${text}\n`),
  });
  const resetApprovalDeadlineMs = Math.min(
    300_000, config.permission_timeout_ms ?? 300_000,
  );
  const turns = {
    deliverySequencesForTurn: (token: string) =>
      (deliveries.get(token) ?? []).flatMap((envelope) => {
        const seq = (envelope as Envelope & { delivery_seq?: number })
          .delivery_seq;
        return seq === undefined ? [] : [seq];
      }),
    deliveryEnvelopesForTurn: (token: string) => deliveries.get(token) ?? [],
  };
  const acknowledgements = createDeliveryAcknowledgementRuntime(
    (seq) => link?.acknowledgeInterAgentDelivery(seq),
    turns,
    () => {
      const incarnation = link?.deliveryIncarnation();
      const generation = link?.deliveryGeneration();
      return incarnation && generation ? { incarnation, generation } : null;
    },
  );
  const workTools = {
    workControlSupported: () =>
      typeof link?.workControlSupported === "function" &&
      link.workControlSupported(),
    deliveryModesSupported: () =>
      typeof link?.deliveryModes === "function" && link.deliveryModes() !== null,
    deliveryModes: () => typeof link?.deliveryModesState === "function"
      ? link.deliveryModesState() : "pending" as const,
    workStatus: ({ work_id }: { work_id?: string | undefined }) => link
      ? link.requestWorkStatus(work_id === undefined ? {} : { work_id })
      : Promise.reject(new Error("work_control_unavailable")),
    workOpResult: (input: { operation_id: string }) => link
      ? link.requestWorkOpResult(input)
      : Promise.reject(new Error("work_control_unavailable")),
    deliveryStatus: (input: {
      conversation_id?: string | undefined;
      turn_number?: number | undefined;
    }) => link
      ? link.requestDeliveryStatus(
        input.conversation_id === undefined || input.turn_number === undefined
          ? {}
          : { conversation_id: input.conversation_id,
            turn_number: input.turn_number },
      )
      : Promise.reject(new Error("work_control_unavailable")),
  };
  const interAgent = new InterAgentTool({
    workTools,
    config,
    send,
    getState: () => host?.state ?? "idle",
    getActiveInterAgentTurnToken: () =>
      host?.activeInterAgentTurnToken() ?? null,
    noticeAttributionMode: () => link?.noticeAttributionMode() ?? "pending",
    sendInterAgent: (envelope) =>
      link?.sendInterAgent(envelope) ??
      Promise.resolve({ kind: "unknown", reason: "not_connected" }),
    requestDirectory: () =>
      link?.requestDirectory() ?? Promise.resolve({ agents: [], users: [] }),
    setStatusLine: (text) =>
      link?.setStatusLine(text) ??
      Promise.resolve({ kind: "error", reason: "not_connected" }),
    readStatusLine: (id) =>
      link?.readStatusLine(id) ??
      Promise.resolve({ kind: "error", reason: "not_connected" }),
    requestInterAgentDeliveryStatus: () =>
      link?.requestInterAgentDeliveryStatus() ?? Promise.resolve(null),
    requestSelfIdentity: () => link?.requestSelfIdentity() ?? Promise.resolve(null),
    getWhoami: () =>
      ({
        agent_id: config.agent_id,
        persona: config.persona,
        state: host?.state ?? "idle",
        ...(host?.statusSnapshot() ?? { engine: "muse" }),
        build: buildInfo,
      }) as WhoamiSnapshot,
  });
  let resolvePersona!: (text: string) => void;
  const persona = new Promise<string>((resolve) => {
    resolvePersona = resolve;
  });
  const controlFailure = (operation: string, detail = "is unsupported by the muse engine") => {
    send(
      makeLog(config, host?.state ?? "idle", new Date().toISOString(), {
        kind: "system",
        text: `muse ${operation} ${detail}`,
      }),
    );
  };
  const turnFailure = () => send(makeLog(
    config, host?.state ?? "idle", new Date().toISOString(),
    { kind: "system", text: "muse turn failed" },
  ));
  const options = acknowledgements.withServerLinkOptions<ServerLinkOptions>({
    personaId: config.persona.id,
    ...(config.server_token ? { token: config.server_token } : {}),
    ...(config.transition_id ? { transitionId: config.transition_id } : {}),
    buildInfo,
    noticeAttribution: "v1" as const,
    workControl: "v1" as const,
    onWorkNotice: (notice) => {
      chain = chain
        .then(async () => {
          await hostReady;
          await host!.send(`Work notice: ${JSON.stringify(notice)}`);
        })
        .catch(() => {
          turnFailure();
        });
    },
    interAgentDeliveryModes: {
      version: "v1" as const,
      early: "none" as const,
      yield: "none" as const,
      stage_reports: false,
    },
    onPersonaPrompt: resolvePersona,
    onHydration: verdict => replayer.onVerdict(verdict),
    onInstruction: (text: string, attachments?: string[]) => {
      const staged = attachments?.length ? intake.stage(attachments) : undefined;
      if (attachments?.length && !staged) return;
      chain = chain
        .then(async () => {
          await hostReady;
          if (!staged?.dropped) await host!.send(text, staged);
        })
        .catch(() => {
          turnFailure();
        });
    },
    onAttachOpen: (meta) => intake.attachOpen(meta),
    onAttachChunk: (payload) => intake.attachChunk(payload),
    onAttachClose: (id) => intake.attachClose(id),
    onPermissionDecision: (
      decision: Parameters<PermissionBroker["resolve"]>[0],
    ) => permission.resolve(decision),
    onSessionResetFailed: ({ requestId, reason }) =>
      sessionReset.onResetFailed(requestId, reason),
    onQuestionResponse: (answer: Parameters<QuestionBroker["resolve"]>[0]) =>
      question.resolve(answer),
    onInterrupt: () => {
      intake.interrupt();
      if (host) void host.interrupt().catch(() => host?.close());
    },
    onSetModel: (value: string) => {
      if (host) void host.setModel(value).catch(() => {
        controlFailure("model switching");
        host?.republishState();
      });
      else controlFailure("model switching", "is not ready");
    },
    onSetEffort: (level: string) => {
      if (host) void host.setEffort(level).catch(() => {
        controlFailure("effort switching");
        host?.republishState();
      });
      else controlFailure("effort switching", "is not ready");
    },
    onSetPermission: (value: PermissionSelection) => {
      // Unsupported controls are returned as unsupported, not merely
      // logged: the host throws, and the unchanged effective state is
      // re-published so the server does not persist the pick as applied.
      if (host) {
        void host.setPermission(value).catch(() => {
          controlFailure("permission switching");
          host?.republishState();
        });
      } else controlFailure("permission switching", "is not ready");
    },
    onSetPermissionMode: (mode: string) => {
      if (host) {
        void host.setPermissionMode(mode as PermissionMode).catch(() => {
          controlFailure("permission mode switching");
          host?.republishState();
        });
      } else controlFailure("permission mode switching", "is not ready");
    },
    onRenameDisplayName: (name: string, revision: number) => {
      if (host) host.renameDisplayName(name, revision);
      else
        pendingName = mergePendingDisplayNameSync(pendingName, name, revision);
    },
    onInterAgentMessage: (envelope: Envelope) => {
      acknowledgements.captureDelivery(envelope);
      chain = chain
        .then(async () => {
          await hostReady;
          const disposition = await interAgent.receiveInbound(envelope);
          if (disposition.consumed || !disposition.inject) {
            if (!(disposition.consumed && disposition.deferAck)) {
              acknowledgements.acknowledgeDelivery(envelope);
            }
            if (disposition.notice) send(disposition.notice);
            return;
          }
          const token = randomUUID();
          const id = String(envelope.payload.conversation_id);
          deliveries.set(token, [envelope]);
          interAgent.notePendingInjection(envelope, token);
          try {
            await host!.send(
              formatInboundMessage(envelope, { mode: disposition.mode }),
              undefined,
              [id],
              token,
            );
          } catch {
            for (const notice of interAgent.resolveTurnEnd(
              token,
              [id],
              classifyInterAgentError({ detail: "muse turn failed" }),
            ))
              send(notice);
          } finally {
            deliveries.delete(token);
          }
        })
        .catch(() => {
          turnFailure();
        });
    },
  });
  const createLink =
    dependencies.createServerLink ??
    ((...values: ConstructorParameters<typeof ServerLink>) =>
      new ServerLink(...values));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => host?.close();
  let disconnectReason: "stop" | "crash" = "stop";
  try {
    link = createLink(config.server_url, config.agent_id, options);
    const rules = await Promise.race([
      persona,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("muse persona prompt timed out")),
          10_000,
        );
      }),
    ]);
    clearTimeout(timer);
    host = (dependencies.createHost ?? ((opts) => new MuseHost(opts)))(
      acknowledgements.withHostOptions({
        config,
        cwd,
        personaPrompt: rules,
        recovery,
        intake,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        send,
        toolDescriptors: [
          ...interAgent.descriptors(),
          askUserQuestionDescriptor((questions) => question.decide(questions)),
          operatorApprovalGated(
            requestSessionResetDescriptor({
              reserve: (mode, reason) => sessionReset.reserve(mode, reason,
                host?.activeInterAgentTurnToken() ?? undefined),
              offerCompact: false,
            }),
            {
              decide: (name, input, signal) => permission.decide(
                name, input, signal, { deadlineMs: resetApprovalDeadlineMs },
              ),
              toolName: REQUEST_SESSION_RESET_TOOL_FQN,
              validate: validateRequestSessionResetInput,
            },
          ),
          ...(dependencies.additionalTools ?? []),
        ],
        decidePermission: (
          name: string,
          input: Record<string, unknown>,
          signal?: AbortSignal,
        ) => permission.decide(name, input, signal),
        onReady: () => replayer.markReady(),
        onSessionId: (id: string) => {
          link?.setSessionId(id);
        },
        onMetadata: (metadata) => {
          writeRedactedStderr(
            `[kaoiro] muse ACP ${JSON.stringify(metadata)}\n`,
          );
          dependencies.onMetadata?.(metadata);
        },
        onTurnEnd: ({
          turnToken,
          conversationIds,
          error,
          settled,
        }: {
          turnToken: string;
          conversationIds: string[];
          error?: { detail: string; reason?: string };
          settled?: { authoritative: boolean; why?: string };
        }) => {
          if (settled) sessionReset.onTurnEnd({ turnToken, ...settled });
          question.close();
          for (const notice of interAgent.resolveTurnEnd(
            turnToken,
            conversationIds,
            error ? classifyInterAgentError(error) : undefined,
          ))
            send(notice);
        },
      }),
    );
    if (pendingName)
      host.renameDisplayName(pendingName.displayName, pendingName.revision);
    ready();
    dependencies.onHostCreated?.(host);
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    await host.run(config.initial_prompt);
  } catch (error) {
    disconnectReason = "crash";
    throw error;
  } finally {
    clearTimeout(timer);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    replayer.close();
    question.close();
    permission.close();
    interAgent.close();
    intake.close();
    host?.close();
    await host?.closed;
    try {
      if (!recovery.failure) await link?.reportDisconnectIntent(disconnectReason);
    } finally {
      link?.close();
      if (recovery.failure) throw recovery.failure;
    }
  }
}
