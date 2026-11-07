import { RecoveryReporter, recoveryExitCode, shutdownForRecovery } from "@kaoiro/wrapper-core";
import { PermissionSyncTimeoutError } from "@kaoiro/wrapper-core";
import { retirePermissionSyncInput } from "@kaoiro/agent-common";
import { randomUUID } from "node:crypto";
import type { PermissionSelection, PermissionSyncMessage, WrapperPermissionLifecycleMessage } from "@kaoiro/protocol";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  askUserQuestionDescriptor,
  classifyInterAgentError,
  createDeliveryAcknowledgementRuntime,
  formatInboundMessage,
  HistoryReplayer,
  InterAgentTool,
  makeLog,
  makeStateChange,
  mergePendingDisplayNameSync,
  PermissionBroker,
  QuestionBroker,
  writeRedactedStderr,
  type Envelope,
  type ToolDescriptor,
  type WhoamiSnapshot,
} from "@kaoiro/agent-common";
import {
  loadConfig,
  loadWrapperBuildInfo,
  parseCliArgs,
  ServerLink,
  type ServerLinkOptions,
} from "@kaoiro/wrapper-core";
import { GrokHost, type GrokHostOptions } from "./host.js";
import type { GrokWireMetadata } from "./grok/wire.js";
import { GrokLaunchError } from "./grok/errors.js";
import { readGrokHistory } from "./history.js";

export interface GrokCliDependencies {
  parseCliArgs?: typeof parseCliArgs;
  loadConfig?: typeof loadConfig;
  loadWrapperBuildInfo?: typeof loadWrapperBuildInfo;
  createServerLink?: (
    ...args: ConstructorParameters<typeof ServerLink>
  ) => ServerLink;
  createHost?: (options: GrokHostOptions) => GrokHost;
  onHostCreated?: (host: GrokHost) => void;
  onMetadata?: (metadata: GrokWireMetadata) => void;
  additionalTools?: ToolDescriptor[];
  cwd?: string;
  platform?: NodeJS.Platform;
}

export async function runGrokCli(dependencies: GrokCliDependencies = {}) {
  const args = (dependencies.parseCliArgs ?? parseCliArgs)(
    process.argv.slice(2),
  );
  const config = (dependencies.loadConfig ?? loadConfig)(args.configPath);
  const buildInfo = (dependencies.loadWrapperBuildInfo ?? loadWrapperBuildInfo)(
    fileURLToPath(new URL("../dist/build-info.json", import.meta.url)),
  );
  let host: GrokHost | undefined;
  let link: ServerLink | undefined;
  const recovery = new RecoveryReporter(config, args.resume, failure => {
    void shutdownForRecovery(failure, () => host?.close(),
      () => link?.reportDisconnectIntent?.("crash"), () => { link?.close(); }).catch(() => {});
  });
  if (recovery.failure) throw recovery.failure;

  const platform = dependencies.platform ?? process.platform;
  let permissionSyncSupported = false;
  const pendingPermissions: ({ kind: "sync"; value: PermissionSyncMessage } |
    { kind: "relay"; value: PermissionSelection })[] = [];
  let pendingName: { displayName: string; revision: number } | undefined;
  let chain: Promise<void> = Promise.resolve();
  let ready!: () => void;
  const hostReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const deliveries = new Map<string, Envelope[]>();
  const send = (envelope: Envelope) => link?.send(envelope);
  const cwd = dependencies.cwd ?? process.cwd();
  // ADR-0051 D2. Built before the link: the join reply, and with it the
  // hydration verdict, can land before the host exists, so the replayer holds
  // the verdict until markReady().
  const replayer = new HistoryReplayer({
    seedState: () =>
      link?.send(
        makeStateChange(config, host?.state ?? "idle", new Date().toISOString(), {},
          host?.statusExtSnapshot() ?? {}),
      ),
    sessionId: () => link?.currentSessionId() ?? null,
    readTranscript: (sessionId) => readGrokHistory(cwd, sessionId, config),
    // Grok records no inter-agent sidecar.
    readSidecar: () => [],
    sendHistoryReset: (replayId) => link?.sendHistoryReset(replayId),
    sendEnvelope: (envelope) => link?.send(envelope),
    sendReplayIa: (replayId, items) => link?.sendReplayIa(replayId, items),
    sendHistoryReplayComplete: (replayId) => link?.sendHistoryReplayComplete(replayId),
    ...(args.resume ? { legacyResumeSessionId: args.resume } : {}),
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
  const interAgent = new InterAgentTool({
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
        ...(host?.statusSnapshot() ?? { engine: "grok" }),
        build: buildInfo,
      }) as WhoamiSnapshot,
  });
  let resolvePersona!: (text: string) => void;
  const persona = new Promise<string>((resolve) => {
    resolvePersona = resolve;
  });
  const controlFailure = (operation: string, detail = "is unsupported in work unit 1") => {
    send(
      makeLog(config, host?.state ?? "idle", new Date().toISOString(), {
        kind: "system",
        text: `grok ${operation} ${detail}`,
      }),
    );
  };
  const turnFailure = () => send(makeLog(
    config, host?.state ?? "idle", new Date().toISOString(),
    { kind: "system", text: "grok turn failed" },
  ));
  const options = acknowledgements.withServerLinkOptions<Omit<ServerLinkOptions, "onInterAgentDeliveryStatus">>({
    personaId: config.persona.id,
    ...(config.server_token ? { token: config.server_token } : {}),
    ...(config.transition_id ? { transitionId: config.transition_id } : {}),
    buildInfo,
    noticeAttribution: "v1" as const,
    interAgentDeliveryModes: {
      version: "v1" as const,
      early: "none" as const,
      yield: "none" as const,
      stage_reports: false,
    },
    ...(platform === "linux" ? { permissionSync: {
      engine: "grok" as const,
      onNegotiated: (supported: boolean) => {
        permissionSyncSupported = supported;
        host?.setPermissionSyncSupported(supported);
      },
      onSync: (value: PermissionSyncMessage) => {
        if (host) host.applyPermissionSync(value);
        else pendingPermissions.push({ kind: "sync", value });
      },
    } } : {}),
    onPersonaPrompt: resolvePersona,
    onHydration: (verdict: Parameters<HistoryReplayer["onVerdict"]>[0]) => replayer.onVerdict(verdict),
    onInstruction: (text: string, attachments?: string[]) => {
      chain = chain
        .then(async () => {
          await hostReady;
          await host!.send(text, attachments);
        })
        .catch((error: unknown) => {
          if (error instanceof PermissionSyncTimeoutError) return;
          if (attachments?.length) controlFailure("attachment input");
          else turnFailure();
        });
    },
    onPermissionDecision: (
      decision: Parameters<PermissionBroker["resolve"]>[0],
    ) => permission.resolve(decision),
    onQuestionResponse: (answer: Parameters<QuestionBroker["resolve"]>[0]) =>
      question.resolve(answer),
    onInterrupt: () => {
      void host?.interrupt().catch(() => host?.close());
    },
    onSetModel: (value: string) => {
      if (host) void host.setModel(value).catch(() => controlFailure("model switching", "failed"));
      else controlFailure("model switching", "is not ready");
    },
    onSetEffort: (level: string) => {
      if (host) void host.setEffort(level).catch(() => controlFailure("effort switching", "failed"));
      else controlFailure("effort switching", "is not ready");
    },
    onSetPermission: (value: PermissionSelection) => {
      if (host) void host.setPermission(value).catch(() => controlFailure("permission switching", "failed"));
      else pendingPermissions.push({ kind: "relay", value });
    },
    onSetPermissionMode: () => controlFailure("permission mode switching"),
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
          } catch (error) {
            if (error instanceof PermissionSyncTimeoutError) return;
            for (const notice of interAgent.resolveTurnEnd(
              token,
              [id],
              classifyInterAgentError({ detail: "grok turn failed" }),
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
          () => reject(new Error("grok persona prompt timed out")),
          10_000,
        );
      }),
    ]);
    clearTimeout(timer);
    if (platform === "linux" && typeof link.waitForPermissionSyncNegotiation === "function")
      permissionSyncSupported = await link.waitForPermissionSyncNegotiation();
    host = (dependencies.createHost ?? ((opts) => new GrokHost(opts)))(
      acknowledgements.withHostOptions({
        config,
        recovery,
        platform,
        permissionSyncSupported,
        waitForPermissionSync: () => link?.waitForPermissionSync?.() ?? Promise.resolve(),
        onPermissionLifecycle: (event: WrapperPermissionLifecycleMessage) => link?.reportPermissionLifecycle(event),
        cwd,
        personaPrompt: rules,
        ...(args.resume ? { resumeSessionId: args.resume } : {}),
        ...(config.resume_snapshot ? { resumeSnapshot: config.resume_snapshot } : {}),
        send,
        toolDescriptors: [
          ...interAgent.descriptors(),
          askUserQuestionDescriptor((questions) => question.decide(questions)),
          ...(dependencies.additionalTools ?? []),
        ],
        decidePermission: (
          name: string,
          input: Record<string, unknown>,
          signal?: AbortSignal,
        ) => permission.decide(name, input, signal),
        onSessionId: (id: string) => {
          link?.setSessionId(id);
          // The session id is known, so a verdict can now be served.
          replayer.markReady();
        },
        onMetadata: (metadata: GrokWireMetadata) => {
          writeRedactedStderr(
            `[kaoiro] grok ACP ${JSON.stringify(metadata)}\n`,
          );
          dependencies.onMetadata?.(metadata);
        },
        onTurnEnd: ({
          turnToken,
          conversationIds,
          error,
        }: {
          turnToken: string;
          conversationIds: string[];
          error?: { detail: string; reason?: string };
        }) => {
          question.close();
          if (error?.reason === "permission_sync_timeout") {
            retirePermissionSyncInput({
              envelopes: deliveries.get(turnToken) ?? [],
              retire: envelopes => link?.retireInterAgentDeliveries(envelopes),
              clearInjection: () => { interAgent.resolveTurnEnd(turnToken, conversationIds); },
            });
            return;
          }
          for (const notice of interAgent.resolveTurnEnd(
            turnToken,
            conversationIds,
            error ? classifyInterAgentError(error) : undefined,
          ))
            send(notice);
        },
      }),
    );
    for (const pending of pendingPermissions) {
      if (pending.kind === "sync") host.applyPermissionSync(pending.value);
      else await host.setPermission(pending.value).catch(() => controlFailure("permission switching", "failed"));
    }
    if (pendingName)
      host.renameDisplayName(pendingName.displayName, pendingName.revision);
    ready();
    dependencies.onHostCreated?.(host);
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    await host.run(args.prompt);
  } catch (error) {
    disconnectReason = "crash";
    throw error;
  } finally {
    clearTimeout(timer);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    question.close();
    permission.close();
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void runGrokCli().catch((error: unknown) => {
    const detail =
      error instanceof GrokLaunchError ? error.message : "grok wrapper failed";
    writeRedactedStderr(`[kaoiro] ${detail}\n`);
    process.exitCode = recoveryExitCode(error);
  });
}
