import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  askUserQuestionDescriptor,
  classifyInterAgentError,
  createDeliveryAcknowledgementRuntime,
  InterAgentTool,
  makeLog,
  makeStateChange,
  PermissionBroker,
  QuestionBroker,
  type Envelope,
  type WhoamiSnapshot,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import { writeRedactedStderr } from "@kaoiro/agent-common";
import {
  loadConfig,
  loadWrapperBuildInfo,
  parseCliArgs,
  ServerLink,
} from "@kaoiro/wrapper-core";
import { AntigravityHost } from "./host.js";
import { handleAntigravityInterAgentMessage } from "./inter_agent_message_handler.js";
import { AntigravityInterAgentTurnCoordinator } from "./inter_agent_turn_coordinator.js";
import { applyAntigravityEnvDefaultModel, applyAntigravitySources, resolveAntigravitySources } from "./source_resolution.js";
import { probeSshAgentIdentities } from "./ssh_agent_probe.js";
import { nonInteractiveToolEnv } from "./tool_child_env.js";
import { readTurnWatchdogSettings, TurnWatchdog } from "./turn_watchdog.js";
import type { TurnWatchdogWarning } from "./turn_watchdog.js";

const PERSONA_PROMPT_TIMEOUT_MS = 10_000;

type CreateServerLink = (
  ...args: ConstructorParameters<typeof ServerLink>
) => ServerLink;
type CreateAntigravityHost = (
  ...args: ConstructorParameters<typeof AntigravityHost>
) => AntigravityHost;

export interface AntigravityCliDependencies {
  parseCliArgs?: typeof parseCliArgs;
  loadConfig?: typeof loadConfig;
  loadWrapperBuildInfo?: typeof loadWrapperBuildInfo;
  createServerLink?: CreateServerLink;
  createHost?: CreateAntigravityHost;
  onHostCreated?: (host: AntigravityHost) => void;
  probeSshAgentIdentities?: typeof probeSshAgentIdentities;
}

export function relayAntigravityInstruction(
  config: WrapperConfig,
  state: AntigravityHost["state"],
  send: (envelope: Envelope) => void,
  sendInstruction: (text: string) => Promise<void>,
  text: string,
  now: () => string = () => new Date().toISOString(),
): void {
  send(makeLog(config, state, now(), { kind: "user", text }));
  void sendInstruction(text);
}

export async function runAntigravityCli(
  dependencies: AntigravityCliDependencies = {},
): Promise<void> {
  const parseArgs = dependencies.parseCliArgs ?? parseCliArgs;
  const loadCliConfig = dependencies.loadConfig ?? loadConfig;
  const loadBuildInfo = dependencies.loadWrapperBuildInfo ?? loadWrapperBuildInfo;
  const createServerLink =
    dependencies.createServerLink ?? ((...args) => new ServerLink(...args));
  const createHost =
    dependencies.createHost ?? ((...args) => new AntigravityHost(...args));
  const { configPath, prompt, resume: resumeSessionId } = parseArgs(process.argv.slice(2));
  const config = loadCliConfig(configPath);
  const turnWatchdogSettings = readTurnWatchdogSettings(
    process.env,
    (message) => writeRedactedStderr(message),
  );
  if (nonInteractiveToolEnv(process.env).preservedGitSshCommand) {
    writeRedactedStderr("[kaoiro] antigravity respects the operator's GIT_SSH_COMMAND; ssh BatchMode is not injected\n");
  }
  const probeSshAgent = dependencies.probeSshAgentIdentities ?? probeSshAgentIdentities;
  void probeSshAgent({ env: process.env }).then((identities) => {
    if (identities === "no_identities") {
      writeRedactedStderr("[kaoiro] antigravity SSH_AUTH_SOCK has no identities; SSH Git operations will fail in BatchMode\n");
    }
  });
  const { modelSource, effortSource } = resolveAntigravitySources(
    config,
    process.env.KAOIRO_ANTIGRAVITY_DEFAULT_MODEL,
  );
  applyAntigravityEnvDefaultModel(config, process.env.KAOIRO_ANTIGRAVITY_DEFAULT_MODEL);
  applyAntigravitySources(config, { modelSource, effortSource });

  let host: AntigravityHost | undefined;
  let link: ServerLink | undefined;
  let instructionChain: Promise<void> = Promise.resolve();
  let watchdogFailStopped = false;
  let resolvePersona!: (value: string) => void;
  let rejectPersona!: (reason: Error) => void;
  const personaPrompt = new Promise<string>((resolvePrompt, rejectPrompt) => {
    resolvePersona = resolvePrompt;
    rejectPersona = rejectPrompt;
  });
  const send = (envelope: Envelope): void => link?.send(envelope);
  const permissionBroker = new PermissionBroker({
    config,
    send,
    onPendingChange: (pending) => host?.setPendingPermission(pending),
  });
  const questionBroker = new QuestionBroker({
    config,
    send,
    onPendingChange: (pending) => host?.setPendingQuestion(pending),
  });
  const interAgent = new InterAgentTool({
    config,
    getState: () => host?.state ?? "idle",
    getActiveInterAgentTurnToken: () =>
      host?.activeInterAgentTurnToken() ?? null,
    send,
    sendInterAgent: (envelope) => link?.sendInterAgent(envelope) ?? Promise.resolve({ kind: "unknown", reason: "not_connected" }),
    requestDirectory: () => link?.requestDirectory() ?? Promise.resolve({ agents: [], users: [] }),
    requestInterAgentDeliveryStatus: () => link?.requestInterAgentDeliveryStatus() ?? Promise.resolve(null),
    getWhoami: () => ({
      agent_id: config.agent_id,
      persona: config.persona,
      state: host?.state ?? "idle",
      ...(host?.statusSnapshot() ?? { engine: "antigravity" }),
    }) as WhoamiSnapshot,
  });
  const interAgentTurns = new AntigravityInterAgentTurnCoordinator({
    onDispatch: (batch) => {
      for (const item of batch.items) {
        interAgent.notePendingInjection(item.envelope, batch.turnToken);
      }
      instructionChain = instructionChain.then(() =>
        host!.send(
          batch.text,
          undefined,
          batch.conversationIds,
          batch.turnToken,
        ).catch((error: unknown) => {
          const classified = classifyInterAgentError({ detail: String(error) });
          for (const notice of interAgent.resolveTurnEnd(
            batch.turnToken,
            batch.conversationIds,
            classified,
          )) {
            link?.send(notice);
          }
          const settled = interAgentTurns.settle(batch.turnToken);
          if (settled !== undefined && !watchdogFailStopped) {
            interAgentTurns.dispatchNextForPeer(settled.peer);
          }
        }),
      );
    },
  });
  const lifecycleRange = (turnToken: string | undefined): {
    seqFirst: number;
    seqLast: number;
  } | undefined => {
    if (turnToken === undefined) return undefined;
    const range = interAgentTurns.deliverySequenceRangeForTurn(turnToken);
    return range === undefined
      ? undefined
      : { seqFirst: range.first, seqLast: range.last };
  };
  const writeAntigravityLifecycle = (event: {
    event: string;
    turnToken?: string;
    seq?: number;
    seqFirst?: number;
    seqLast?: number;
    details?: Record<string, number | string>;
  }): void => {
    try {
      const range = lifecycleRange(event.turnToken);
      const record: Record<string, unknown> = {
        at: new Date().toISOString(),
        event: event.event,
        ...(event.turnToken === undefined ? {} : { turn_token: event.turnToken }),
        ...(event.seq === undefined ? {} : { seq: event.seq }),
        ...event.details,
      };
      const first = event.seqFirst ?? range?.seqFirst;
      const last = event.seqLast ?? range?.seqLast;
      if (first !== undefined) record.seq_first = first;
      if (last !== undefined) record.seq_last = last;
      writeRedactedStderr(`[kaoiro][antigravity-lifecycle] ${JSON.stringify(record)}\n`);
    } catch {
      // Lifecycle output must not affect turn control.
    }
  };
  const describeTurnWatchdogWarning = (warning: TurnWatchdogWarning): string => {
    switch (warning.kind) {
      case "inactivity_timeout":
        return `[kaoiro] antigravity turn watchdog inactivity timeout: token=${warning.turnToken} idle=${warning.idleMs}ms threshold=${warning.inactivityMs}ms; requesting child interrupt`;
      case "tool_timeout":
        return `[kaoiro] antigravity turn watchdog tool timeout: token=${warning.turnToken} step=${warning.stepIndex} tool=${warning.toolName} elapsed=${warning.elapsedMs}ms threshold=${warning.toolTimeoutMs}ms; requesting child interrupt`;
      case "abort_grace_expired":
        return `[kaoiro] antigravity turn watchdog interrupt grace expired: token=${warning.turnToken} grace=${warning.abortGraceMs}ms; stopping host admission pending operator recovery`;
      case "interrupt_unavailable":
        return `[kaoiro] antigravity turn watchdog interrupt unavailable: token=${warning.turnToken}; closing host admission through unattributed fail-stop`;
      case "fail_stop_unavailable":
        return `[kaoiro] antigravity turn watchdog exact fail-stop unavailable: token=${warning.turnToken}; closing host admission through unattributed fail-stop`;
      case "start_conflict":
        return `[kaoiro] antigravity turn watchdog start attribution conflict: watched=${warning.watchedTurnToken} started=${warning.startedTurnToken}; closing host admission through unattributed fail-stop`;
    }
  };
  const turnWatchdog = new TurnWatchdog({
    settings: turnWatchdogSettings,
    onWarning: (warning) => {
      writeRedactedStderr(`${describeTurnWatchdogWarning(warning)}\n`);
      if (warning.kind === "tool_timeout") {
        writeAntigravityLifecycle({
          event: "tool_timeout",
          turnToken: warning.turnToken,
          details: {
            step_index: warning.stepIndex,
            tool_name: warning.toolName,
            elapsed_ms: warning.elapsedMs,
            threshold_ms: warning.toolTimeoutMs,
          },
        });
      }
    },
    requestInterrupt: (turnToken, cause) => host?.requestInterruptForTurn(turnToken, cause) ?? false,
    failStop: (turnToken) => host?.failStopTurnForWatchdog(turnToken) ?? false,
    failStopUnattributed: () => { host?.failStopForWatchdogAttributionUnknown(); },
  });
  const deliveryAcknowledgementRuntime = createDeliveryAcknowledgementRuntime(
    (deliverySeq) => {
      const turnToken = interAgentTurns.turnTokenForDeliverySequence(deliverySeq);
      writeAntigravityLifecycle({
        event: "delivery_ack",
        ...(turnToken === undefined ? {} : { turnToken }),
        seq: deliverySeq,
      });
      link?.acknowledgeInterAgentDelivery(deliverySeq);
    },
    interAgentTurns,
  );
  const buildInfo = loadBuildInfo(fileURLToPath(new URL("../dist/build-info.json", import.meta.url)));
  link = createServerLink(config.server_url, config.agent_id, deliveryAcknowledgementRuntime.withServerLinkOptions({
    personaId: config.persona.id,
    ...(config.server_token === undefined ? {} : { token: config.server_token }),
    ...(config.transition_id === undefined ? {} : { transitionId: config.transition_id }),
    buildInfo,
    onPersonaPrompt: resolvePersona,
    onInstruction: (text) => {
      if (host === undefined) return;
      relayAntigravityInstruction(config, host.state, send, (instruction) => host!.send(instruction), text);
    },
    onPermissionDecision: (decision) => permissionBroker.resolve(decision),
    onQuestionResponse: (response) => questionBroker.resolve(response),
    onInterrupt: () => { void host?.interrupt(); },
    onSetModel: (model) => { void host?.setModel(model); },
    onSetEffort: (effort) => {
      void host?.setEffort(effort).catch((error: unknown) => {
        writeRedactedStderr(`antigravity: ${String(error)}\n`);
      });
    },
    onSetPermission: (selection) => {
      void host?.setPermission(selection).catch((error: unknown) => {
        writeRedactedStderr(`antigravity: ${String(error)}\n`);
      });
    },
    onSetPermissionMode: () => writeRedactedStderr("antigravity: permission axes are fixed at spawn in Stage A\n"),
    onRenameDisplayName: (displayName, revision) => host?.renameDisplayName(displayName, revision),
    onInterAgentMessage: (envelope) =>
      handleAntigravityInterAgentMessage(
        deliveryAcknowledgementRuntime.withInboundContext({
          interAgent,
          send: (notice) => link?.send(notice),
          inject: (inbound, mode) => interAgentTurns.receive(inbound, mode),
          log: (line) => process.stdout.write(line),
        }),
        envelope,
      ),
  }));
  const timer = setTimeout(() => rejectPersona(new Error("timed out waiting for persona_prompt")), PERSONA_PROMPT_TIMEOUT_MS);
  let appendSystemPrompt: string;
  try {
    appendSystemPrompt = await personaPrompt;
  } finally {
    clearTimeout(timer);
  }
  host = createHost(config, deliveryAcknowledgementRuntime.withHostOptions({
    cwd: process.cwd(),
    appendSystemPrompt,
    permissionBroker,
    questionBroker,
    onState: send,
    onLog: send,
    onSessionId: (sessionId) => link?.setSessionId(sessionId),
    onTurnBoundary: ({ turnToken }) => {
      turnWatchdog.end(turnToken);
    },
    onTurnProgress: ({ turnToken }) => {
      turnWatchdog.progress(turnToken);
    },
    onToolStart: ({ turnToken, stepIndex, toolName }) => {
      turnWatchdog.toolStart(turnToken, stepIndex, toolName);
    },
    onToolEnd: ({ turnToken, stepIndex }) => {
      turnWatchdog.toolEnd(turnToken, stepIndex);
    },
    onTurnEnd: ({ turnToken, conversationIds, error, cancellation }) => {
      if (cancellation?.kind === "watchdog_fail_stop") {
        for (const notice of interAgent.resolveTurnEnd(
          turnToken,
          conversationIds,
          error === undefined ? undefined : classifyInterAgentError(error),
        )) {
          link?.send(notice);
        }
        interAgentTurns.settle(turnToken);
        return;
      }
      for (const notice of interAgent.resolveTurnEnd(
        turnToken,
        conversationIds,
        error === undefined ? undefined : classifyInterAgentError(error),
      )) {
        link?.send(notice);
      }
      const settled = interAgentTurns.settle(turnToken);
      if (settled !== undefined && !watchdogFailStopped) {
        interAgentTurns.dispatchNextForPeer(settled.peer);
      }
    },
    onWatchdogFailStop: ({ turnToken, attribution }) => {
      watchdogFailStopped = true;
      const frozen = interAgentTurns.freezeForWatchdogFailStop(turnToken, (envelopes) => link?.retireInterAgentDeliveries?.(envelopes));
      writeRedactedStderr(
        `[kaoiro] antigravity turn watchdog fail-stop: token=${turnToken ?? "<unknown>"} ` +
          `attribution=${attribution}; discarded unstarted dispatched=${frozen.droppedDispatched}, ` +
          `pending=${frozen.droppedPending}; operator recovery is required\n`,
      );
    },
    toolDescriptors: [
      ...interAgent.descriptors(),
      askUserQuestionDescriptor((questions) => questionBroker.decide(questions)),
    ],
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
  }, (turnToken) => {
    writeAntigravityLifecycle({ event: "turn_start", turnToken });
    turnWatchdog.start(turnToken);
  }));
  dependencies.onHostCreated?.(host);
  send(
    makeStateChange(
      config,
      host.state,
      new Date().toISOString(),
      {},
      host.statusExtSnapshot(),
    ),
  );
  process.on("SIGINT", () => {
    void host?.interrupt().finally(() => host?.close());
  });
  let disconnectReason: "stop" | "crash" = "stop";
  try {
    await host.run(prompt);
  } catch (error) {
    disconnectReason = "crash";
    throw error;
  } finally {
    interAgentTurns.freezeForWatchdogFailStop(undefined, (envelopes) => link?.retireInterAgentDeliveries?.(envelopes));
    try {
      await link?.flushInterAgentRetirements?.();
    } finally {
      turnWatchdog.dispose();
      questionBroker.close();
      permissionBroker.close();
      try {
        await link.reportDisconnectIntent?.(disconnectReason);
      } finally {
        link.close();
      }
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAntigravityCli().catch((error: unknown) => {
    writeRedactedStderr(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
