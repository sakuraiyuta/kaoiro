// Codex wrapper CLI — the composition root of the codex engine: loads the
// config, connects the ServerLink, waits fail-closed for the server-pushed
// personality (ADR-0029 F3), then drives a CodexHost. Mirrors the Claude
// composition (@kaoiro/claude-code/src/cli.ts) minus the Claude-only parts:
// no permission broker wiring (approval is launch-fixed, ADR-0033 F3), no
// upload rendering (attachments are rejected), rollout history replay.
//
// Usage: node dist/cli.js [configPath] [prompt] [--resume <session_id>]

import {
  InterAgentTool,
  QuestionBroker,
  askUserQuestionDescriptor,
  formatInboundMessage,
  makeAttachRejected,
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
import { replayCodexHistory } from "./history.js";

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
  // F4bc addendum, phase-15 15-4c). "config" wins over "env" when both are
  // set (config.model reaches CodexHost via effectiveConfig even under an
  // env-tier default). Codex has no launch-time effort env, so effort source
  // is either "config" (config.effort set) or undefined.
  const resolvedModelSource: ModelSource | undefined =
    config.model !== undefined
      ? "config"
      : envDefaultModel !== undefined
        ? "env"
        : undefined;
  const resolvedEffortSource: ModelSource | undefined =
    config.effort !== undefined ? "config" : undefined;

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
    const networkAccess = effectiveConfig.network_access ?? false;
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
  link = new ServerLink(config.server_url, config.agent_id, {
    personaId: config.persona.id,
    ...(config.server_token === undefined
      ? {}
      : { token: config.server_token }),
    onPersonaPrompt: (received) => resolvePersonaPrompt(received),
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
    // No upload pipeline on codex yet (file-upload spec is Claude-side):
    // reject each attach_open so the operator's upload fails loudly instead
    // of hanging (the dashboard clears its pending upload on the reject).
    onAttachOpen: (msg) => {
      process.stdout.write(`  attach_open rejected: ${msg.upload_id}\n`);
      link?.send(
        makeAttachRejected(config, host.state, new Date().toISOString(), {
          upload_id: msg.upload_id,
          reason: "sdk_error",
          detail: "codex adapter does not support attachments yet",
        }),
      );
    },
    onInterAgentMessage: (envelope) => {
      const payload = envelope.payload as Partial<InterAgentMessagePayload>;
      if (
        typeof payload.conversation_id === "string" &&
        typeof payload.turn_number === "number"
      ) {
        interAgent?.observeInbound(
          payload.conversation_id,
          payload.turn_number,
        );
      }
      const text = formatInboundMessage(envelope);
      process.stdout.write(`  inter_agent_message: ${envelope.agent_id}\n`);
      instructionChain = instructionChain.then(() =>
        host.send(text).catch((err: unknown) => {
          process.stderr.write(`inter-agent inject failed: ${String(err)}\n`);
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
    appendSystemPrompt,
    onInstructionRejected: (envelope) => link?.send(envelope),
    onSessionId: (id) => link?.setSessionId(id),
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
      const idle = makeStateChange(config, "idle", new Date().toISOString());
      printState(idle);
      link?.send(idle);
    }
    if (resumeSessionId !== undefined) {
      // resumeThread continues only future turns; rebuild the display
      // transcript from the rollout before the host starts (#106). A prompt
      // resume needs an idle seed because AgentStates reset/append are no-ops
      // until the wrapper has established its latest-state entry.
      replayCodexHistory(
        link,
        config,
        resumeSessionId,
        prompt === undefined
          ? undefined
          : makeStateChange(config, "idle", new Date().toISOString()),
      );
    }
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
