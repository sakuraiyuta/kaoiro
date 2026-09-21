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
import { boundErrorDetail, writeRedactedStderr } from "@kaoiro/agent-common";
import {
  loadConfig,
  loadWrapperBuildInfo,
  parseCliArgs,
  ServerLink,
} from "@kaoiro/wrapper-core";
import type { PermissionSyncMessage } from "@kaoiro/protocol";
import { AntigravityHost } from "./host.js";
import { handleAntigravityInterAgentMessage } from "./inter_agent_message_handler.js";
import { AntigravityInterAgentTurnCoordinator } from "./inter_agent_turn_coordinator.js";
import { applyAntigravityEnvDefaultModel, applyAntigravitySources, resolveAntigravitySources } from "./source_resolution.js";
import { probeSshAgentIdentities } from "./ssh_agent_probe.js";
import { nonInteractiveToolEnv } from "./tool_child_env.js";
import { readEpochIdleMs } from "./epoch.js";
import { readTurnWatchdogSettings, TurnWatchdog } from "./turn_watchdog.js";
import { antigravityTranscriptPath } from "./transcript_path.js";
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
  const epochIdleMs = readEpochIdleMs(process.env);
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
  // issue #359 M1: permission_sync negotiation state. onSync can fire before the
  // host is created (during the join / persona-prompt await), so hold the
  // message and apply it once the host exists (Codex parity).
  let permissionSyncSupported = false;
  let pendingPermissionSync: PermissionSyncMessage | undefined;
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
          // issue #371 S1: log before classifying so an unattributed
          // rejection (root cause otherwise invisible from the journal) is
          // still diagnosable next time.
          writeAntigravityLifecycle({
            event: "send_not_started",
            turnToken: batch.turnToken,
            details: { shape: "throw", reason: boundErrorDetail(String(error)) },
          });
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
    details?: Record<string, number | string | boolean>;
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
    // issue #359 M1: negotiate permission_sync so the server seeds this
    // session's permission ledger and relays a durable control/next on
    // reconnect. Gates the supports_permission_switch advertisement.
    permissionSync: {
      engine: "antigravity",
      onNegotiated: (supported) => {
        permissionSyncSupported = supported;
        host?.setPermissionSyncSupported(supported);
      },
      onSync: (message) => {
        if (host === undefined) {
          pendingPermissionSync = message;
          return;
        }
        host.applyPermissionSync(message);
      },
    },
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
    onSetPermissionMode: () => writeRedactedStderr("antigravity: permission-mode switching is unsupported; use set_permission (ADR-0057 F4c)\n"),
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
  // issue #359 M1: settle permission_sync negotiation before the host is built
  // so the constructor knows whether to advertise the selector and seed the
  // baseline (Codex parity). A test double without the method leaves the
  // negotiated flag false (fail-closed).
  if (
    link !== undefined &&
    "waitForPermissionSyncNegotiation" in link &&
    typeof link.waitForPermissionSyncNegotiation === "function"
  ) {
    permissionSyncSupported = await link.waitForPermissionSyncNegotiation();
  }
  host = createHost(config, deliveryAcknowledgementRuntime.withHostOptions({
    cwd: process.cwd(),
    appendSystemPrompt,
    permissionBroker,
    questionBroker,
    onState: send,
    onLog: send,
    onSessionId: (sessionId) => {
      link?.setSessionId(sessionId);
      // issue #352: the runner inherits this process's stdout into its own
      // (systemd) journal, so one line here is the operator's only way to
      // find this agent's engine-side transcript after the fact. Reported
      // as an expected path (no existence check): the CLI may not have
      // written the transcript file yet at this point.
      process.stdout.write(
        `[kaoiro] transcript: agent=${config.agent_id} engine=antigravity ` +
          `session=${sessionId} path=${antigravityTranscriptPath(sessionId)}\n`,
      );
    },
    onPermissionLifecycle: (event) => link?.reportPermissionLifecycle(event),
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
    // issue #371 item 2: lifecycle events for an operator interrupt, next
    // to `turn_start` in the same stream.
    onInterruptRequested: ({ turnToken, pendingPermission, pendingQuestion, childPid }) => {
      writeAntigravityLifecycle({
        event: "interrupt_requested",
        turnToken,
        details: {
          pending_permission: pendingPermission,
          pending_question: pendingQuestion,
          ...(childPid === null ? {} : { child_pid: childPid }),
        },
      });
    },
    onInterruptSettled: ({ turnToken, exitCode, signal, elapsedMs }) => {
      writeAntigravityLifecycle({
        event: "interrupt_settled",
        turnToken,
        details: {
          ...(exitCode === null ? {} : { exit_code: exitCode }),
          ...(signal === null ? {} : { signal }),
          elapsed_ms: elapsedMs,
        },
      });
    },
    // issue #371 S1: `send()` resolved without starting a turn (closed /
    // gate-broken / fail-stopped) — the caller's own promise never rejects
    // for this, so `instructionChain`'s `.catch()` below cannot see it.
    onSendRejected: ({ turnToken, reason }) => {
      writeAntigravityLifecycle({
        event: "send_not_started",
        ...(turnToken === undefined ? {} : { turnToken }),
        details: { shape: "no_op", reason },
      });
    },
    toolDescriptors: [
      ...interAgent.descriptors(),
      askUserQuestionDescriptor((questions) => questionBroker.decide(questions)),
    ],
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    // issue #359 M1: relay the negotiated permission_sync state and the barrier
    // so the host advertises/seeds correctly and each turn's gate waits for a
    // durable control/next relayed on reconnect.
    permissionSyncSupported,
    waitForPermissionSync: () => {
      if (
        link !== undefined &&
        "waitForPermissionSync" in link &&
        typeof link.waitForPermissionSync === "function"
      ) {
        return link.waitForPermissionSync();
      }
      return Promise.resolve();
    },
    // issue #379: the same grace TurnWatchdog uses for its own interrupt ->
    // SIGKILL sequencing also bounds an operator `interrupt()` and a
    // gate-correlation-failure kill (the Host arms its own timer for those,
    // since TurnWatchdog does not orchestrate them).
    abortGraceMs: turnWatchdogSettings.abortGraceMs,
    // issue #377 Stage 2: idle-epoch lifetime bound (`KAOIRO_ANTIGRAVITY_EPOCH_IDLE_MS`).
    epochIdleMs,
    onEpochEnded: ({ reason, code, signal, turns }) => {
      writeAntigravityLifecycle({
        event: "epoch_ended",
        details: {
          reason,
          turns,
          ...(code === null ? {} : { code }),
          ...(signal === null ? {} : { signal }),
        },
      });
    },
    onOutOfTurnEvent: (info) => {
      const details: Record<string, number | string | boolean> = { event_kind: info.eventKind };
      if (info.eventKind === "step_update") {
        if (info.stepIndex !== undefined) details.step_index = info.stepIndex;
        if (info.stepType !== undefined) details.step_type = info.stepType;
        if (info.state !== undefined) details.state = info.state;
      } else if (info.eventKind === "result" && info.status !== undefined) {
        details.status = info.status;
      }
      writeAntigravityLifecycle({ event: "out_of_turn_event", details });
    },
    onEpochStderrLine: ({ kind }) => {
      writeAntigravityLifecycle({ event: "epoch_stderr", details: { kind } });
    },
  }, (turnToken) => {
    writeAntigravityLifecycle({ event: "turn_start", turnToken });
    turnWatchdog.start(turnToken);
  }));
  dependencies.onHostCreated?.(host);
  // issue #359 M1: apply a permission_sync that arrived before the host existed.
  if (pendingPermissionSync !== undefined) {
    host.applyPermissionSync(pendingPermissionSync);
  }
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
  // issue #379 M1: without a handler, Node's default SIGTERM behavior kills
  // this process immediately -- no `close()`, no group signal, no
  // escalation -- and the runner's stop / delete / restart / reset paths
  // (`entry.child.kill()`, a bare SIGTERM) all rely on exactly that signal.
  // `close()` (not `interrupt()`) directly: SIGTERM is an external "stop
  // now", not an operator action, so it should not manufacture an
  // `interrupt_requested` / `interrupted` settlement record for what the
  // operator never asked to interrupt. Registering this handler also
  // suppresses Node's default immediate-exit behavior, so the process
  // naturally stays alive (child stdio + the pending escalation timer keep
  // the event loop open) until `close()`'s SIGKILL escalation actually
  // finishes the agy subtree -- no explicit `process.exit()` here.
  const onSigterm = (): void => {
    host?.close();
  };
  process.on("SIGTERM", onSigterm);
  let disconnectReason: "stop" | "crash" = "stop";
  try {
    await host.run(prompt);
  } catch (error) {
    disconnectReason = "crash";
    throw error;
  } finally {
    // Remove this invocation's own listener once `run()` settles -- this
    // process only ever runs one `runAntigravityCli()` in production, but
    // leaving the listener registered would accumulate a stale one per
    // invocation for any caller (tests included) that runs it more than
    // once in the same process, each closing over an already-finished
    // `host`.
    process.off("SIGTERM", onSigterm);
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
