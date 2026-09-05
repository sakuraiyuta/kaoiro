import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  askUserQuestionDescriptor,
  InterAgentTool,
  makeLog,
  makeStateChange,
  PermissionBroker,
  QuestionBroker,
  type Envelope,
  type WhoamiSnapshot,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import {
  loadConfig,
  loadWrapperBuildInfo,
  parseCliArgs,
  ServerLink,
} from "@kaoiro/wrapper-core";
import { AntigravityHost } from "./host.js";
import { applyAntigravityEnvDefaultModel, applyAntigravitySources, resolveAntigravitySources } from "./source_resolution.js";

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
  const { modelSource, effortSource } = resolveAntigravitySources(
    config,
    process.env.KAOIRO_ANTIGRAVITY_DEFAULT_MODEL,
  );
  applyAntigravityEnvDefaultModel(config, process.env.KAOIRO_ANTIGRAVITY_DEFAULT_MODEL);
  applyAntigravitySources(config, { modelSource, effortSource });

  let host: AntigravityHost | undefined;
  let link: ServerLink | undefined;
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
  const buildInfo = loadBuildInfo(fileURLToPath(new URL("../dist/build-info.json", import.meta.url)));
  link = createServerLink(config.server_url, config.agent_id, {
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
        process.stderr.write(`antigravity: ${String(error)}\n`);
      });
    },
    onSetPermissionMode: () => process.stderr.write("antigravity: permission axes are fixed at spawn in Stage A\n"),
    onRenameDisplayName: (displayName, revision) => host?.renameDisplayName(displayName, revision),
  });
  const timer = setTimeout(() => rejectPersona(new Error("timed out waiting for persona_prompt")), PERSONA_PROMPT_TIMEOUT_MS);
  let appendSystemPrompt: string;
  try {
    appendSystemPrompt = await personaPrompt;
  } finally {
    clearTimeout(timer);
  }
  host = createHost(config, {
    cwd: process.cwd(),
    appendSystemPrompt,
    permissionBroker,
    questionBroker,
    onState: send,
    onLog: send,
    onSessionId: (sessionId) => link?.setSessionId(sessionId),
    toolDescriptors: [
      ...interAgent.descriptors(),
      askUserQuestionDescriptor((questions) => questionBroker.decide(questions)),
    ],
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
  });
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
  try {
    await host.run(prompt);
  } finally {
    questionBroker.close();
    permissionBroker.close();
    link.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAntigravityCli().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
