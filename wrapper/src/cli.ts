// Minimal demo CLI — runs an agent session and prints color-coded state
// transitions, so you can watch the kaoiro state follow real agent behavior.
//
// Modes: with server_url the wrapper stays resident after the first turn
// (Phase 3: it accepts operator instructions and relays tool-permission
// requests to the approval UI); without it, one local turn and exit.
// When the prompt argument is omitted and a server is configured, the
// session starts idle and waits for the first operator instruction.
//
// Safety: allowedTools defaults to read-only tools; config.allowed_tools
// raises that ceiling per wrapper (local config only). Other tools go to
// the canUseTool ask path — when that path fires (issue #1), the decision
// comes from the server's approval flow (PermissionBroker), defaulting to
// deny on timeout. The ceiling cannot be widened from the server side
// (specs/threat-model.md).
//
// Usage: node dist/cli.js [configPath] [prompt]

import { AgentHost } from "./host.js";
import { PermissionBroker } from "./permission.js";
import { loadConfig } from "./persona.js";
import { makeLog, makeStateChange } from "./state.js";
import { ServerLink } from "./transport.js";
import type { Envelope, KaoiroState } from "./types.js";

const COLOR: Record<KaoiroState, string> = {
  idle: "90", // grey
  sending: "93", // bright yellow
  thinking: "36", // cyan
  tool_running: "33", // yellow
  waiting_permission: "35", // magenta
  waiting_input: "32", // green
  done: "92", // bright green
  error: "31", // red
};

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
]);

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
  const configPath = process.argv[2] ?? "kaoiro.config.json";
  const config = loadConfig(configPath);

  // Resident when server-connected: the session stays open for operator
  // instructions instead of ending after the first turn.
  const persistent = Boolean(config.server_url);

  // No prompt argument: server-connected wrappers start idle and wait
  // for the first instruction; local-only runs keep the demo prompt
  // (no instruction channel exists to start a turn otherwise).
  const prompt =
    process.argv[3] ??
    (persistent
      ? undefined
      : "src/state.ts を読んで、状態機械の状態名を日本語で列挙して。書き込みは不要。");

  let host: AgentHost;
  let link: ServerLink | null = null;
  let broker: PermissionBroker | null = null;

  const onState = (envelope: Envelope): void => {
    printState(envelope);
    link?.send(envelope);
    if (!persistent && envelope.state === "waiting_input") host.close();
  };

  const onLog = (envelope: Envelope): void => {
    printLog(envelope);
    link?.send(envelope);
  };

  if (config.server_url) {
    broker = new PermissionBroker({
      config,
      send: (envelope) => link?.send(envelope),
    });
    link = new ServerLink(config.server_url, config.agent_id, {
      ...(config.server_token === undefined
        ? {}
        : { token: config.server_token }),
      onInstruction: (text) => {
        process.stdout.write(`  instruction: ${text}\n`);
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
        host.send(text);
      },
      onPermissionDecision: (decision) => broker?.resolve(decision),
      onInterrupt: () => {
        // protocol.md (#51): graceful stop of the current turn. SDK returns
        // an `error_*` SDKResultMessage which the adapter folds into the
        // existing error -> waiting_input path; no extra state to emit.
        process.stdout.write("  interrupt\n");
        void host.interrupt().catch(() => {});
      },
    });
  }

  host = new AgentHost(config, {
    onState,
    onLog,
    onSessionId: (id) => link?.setSessionId(id),
    decidePermission: (toolName, input) => {
      if (broker) return broker.decide(toolName, input);
      const allow = READ_ONLY_TOOLS.has(toolName);
      process.stdout.write(
        `  permission: ${toolName} -> ${allow ? "allow" : "deny"}\n`,
      );
      return allow
        ? { allow: true }
        : { allow: false, message: "demo: only read-only tools are allowed" };
    },
    queryOptions: {
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: config.allowed_tools ?? [...READ_ONLY_TOOLS],
      cwd: process.cwd(),
    },
  });

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
      const idle = makeStateChange(config, "idle", new Date().toISOString());
      printState(idle);
      link?.send(idle);
    }
    await host.run(prompt);
  } finally {
    // Deny in-flight permission requests, then release the socket so the
    // process can exit.
    broker?.close();
    link?.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
