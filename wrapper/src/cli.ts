// Minimal demo CLI — runs an agent session and prints color-coded state
// transitions, so you can watch the kaoiro state follow real agent behavior.
//
// Modes: with server_url the wrapper stays resident after the first turn
// (Phase 3: it accepts operator instructions and relays tool-permission
// requests to the approval UI); without it, one local turn and exit.
//
// Safety: allowedTools pre-allows read-only tools only. Other tools go to
// the canUseTool ask path — when that path fires (issue #1), the decision
// comes from the server's approval flow (PermissionBroker), defaulting to
// deny on timeout. The local allowedTools ceiling cannot be widened from
// the server side (specs/threat-model.md).
//
// Usage: node dist/cli.js [configPath] [prompt]

import { AgentHost } from "./host.js";
import { PermissionBroker } from "./permission.js";
import { loadConfig } from "./persona.js";
import { ServerLink } from "./transport.js";
import type { Envelope, KaoiroState } from "./types.js";

const COLOR: Record<KaoiroState, string> = {
  idle: "90", // grey
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

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? "kaoiro.config.json";
  const prompt =
    process.argv[3] ??
    "src/state.ts を読んで、状態機械の状態名を日本語で列挙して。書き込みは不要。";
  const config = loadConfig(configPath);

  // Resident when server-connected: the session stays open for operator
  // instructions instead of ending after the first turn.
  const persistent = Boolean(config.server_url);

  let host: AgentHost;
  let link: ServerLink | null = null;
  let broker: PermissionBroker | null = null;

  const onState = (envelope: Envelope): void => {
    printState(envelope);
    link?.send(envelope);
    if (!persistent && envelope.state === "waiting_input") host.close();
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
        host.send(text);
      },
      onPermissionDecision: (decision) => broker?.resolve(decision),
    });
  }

  host = new AgentHost(config, {
    onState,
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
      allowedTools: [...READ_ONLY_TOOLS],
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
