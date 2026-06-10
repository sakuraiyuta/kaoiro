// Minimal demo CLI — runs one agent turn and prints color-coded state
// transitions, so you can watch the kaoiro state follow real agent behavior.
//
// Safety: in headless SDK mode the canUseTool "ask" path is not auto-invoked
// (tools resolve via allowedTools), so the demo enforces read-only by restricting
// allowedTools — non-read tools are not pre-allowed and never execute. The
// decidePermission wiring below drives waiting_permission only if/when the ask
// path is enabled (see docs/specs/agent-sdk-events.md follow-up).
//
// Usage: node dist/cli.js [configPath] [prompt]

import { AgentHost } from "./host.js";
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
  const link = config.server_url
    ? new ServerLink(config.server_url, config.agent_id)
    : null;

  let host: AgentHost;
  const onState = (envelope: Envelope): void => {
    printState(envelope);
    link?.send(envelope);
    // Once the turn completes, close the input stream to end the session.
    if (envelope.state === "waiting_input") host.close();
  };

  host = new AgentHost(config, {
    onState,
    decidePermission: (toolName) => {
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
    // Release the socket so the process can exit.
    link?.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
