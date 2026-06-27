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
// Usage: node dist/cli.js [configPath] [prompt] [--resume <session_id>]

import { parseCliArgs } from "./args.js";
import { readSessionHistory } from "./history.js";
import { AgentHost } from "./host.js";
import { PermissionBroker } from "./permission.js";
import { PERMISSION_MODES, loadConfig } from "./persona.js";
import { makeLog, makeStateChange } from "./state.js";
import { ServerLink } from "./transport.js";
import type { Envelope, KaoiroState, PermissionMode } from "./types.js";

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
  const { configPath, prompt: promptArg, resume: resumeSessionId } =
    parseCliArgs(process.argv.slice(2));
  const config = loadConfig(configPath);

  // Resident when server-connected: the session stays open for operator
  // instructions instead of ending after the first turn.
  const persistent = Boolean(config.server_url);

  // No prompt argument: server-connected wrappers start idle and wait
  // for the first instruction; local-only runs keep the demo prompt
  // (no instruction channel exists to start a turn otherwise).
  const prompt =
    promptArg ??
    (persistent
      ? undefined
      : "src/state.ts を読んで、状態機械の状態名を日本語で列挙して。書き込みは不要。");

  let host: AgentHost;
  let link: ServerLink | null = null;
  let broker: PermissionBroker | null = null;
  // host.send is async now (the PDF fit-to-SDK path awaits pdf-lib). Chain
  // operator instructions through one Promise so a slow render (e.g. a big
  // PDF) does not let the next instruction's queue.push run first, which
  // would reorder turns on the SDK input stream.
  let instructionChain: Promise<void> = Promise.resolve();

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
      // Stamp ext.pending_permission onto the host so the next
      // state_change envelope carries it (ADR-0022). Captured-by-closure
      // host is assigned just below, before any tool ever fires.
      onPendingChange: (pending) => host?.setPendingPermission(pending),
    });
    link = new ServerLink(config.server_url, config.agent_id, {
      ...(config.server_token === undefined
        ? {}
        : { token: config.server_token }),
      onInstruction: (text, attachmentIds) => {
        const tag = attachmentIds && attachmentIds.length > 0
          ? `instruction(+${attachmentIds.length})`
          : "instruction";
        process.stdout.write(`  ${tag}: ${text}\n`);
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
        // Serialise async sends so render cost (PDF fit, etc.) cannot
        // reorder instructions on the SDK queue. swallow per-call failures
        // so one bad turn does not break the chain.
        instructionChain = instructionChain.then(() =>
          host.send(text, attachmentIds).catch((err: unknown) => {
            process.stderr.write(`send failed: ${String(err)}\n`);
          }),
        );
      },
      onPermissionDecision: (decision) => broker?.resolve(decision),
      onInterrupt: () => {
        // protocol.md (#51): graceful stop of the current turn. SDK returns
        // an `error_*` SDKResultMessage which the adapter folds into the
        // existing error -> waiting_input path; no extra state to emit.
        process.stdout.write("  interrupt\n");
        void host.interrupt().catch(() => {});
      },
      onSetModel: (value) => {
        // protocol.md (#54): apply the operator's model choice to subsequent
        // turns; a bad alias surfaces as a rejected control request, swallowed
        // like the other best-effort controls.
        process.stdout.write(`  set_model: ${value}\n`);
        void host.setModel(value).catch(() => {});
      },
      onSetEffort: (level) => {
        process.stdout.write(`  set_effort: ${level}\n`);
        void host.setEffort(level).catch(() => {});
      },
      onSetPermissionMode: (mode) => {
        // protocol.md (#58): operator pick OR server after-join push of the
        // last persisted choice. Validate against the closed enum so a
        // malformed server payload never reaches the SDK; setPermissionMode
        // swallows SDK errors (e.g. bypass requested when the session was
        // not opened with allowDangerouslySkipPermissions) like the other
        // controls.
        if (!(PERMISSION_MODES as readonly string[]).includes(mode)) {
          process.stdout.write(
            `  set_permission_mode: ignored unknown value '${mode}'\n`,
          );
          return;
        }
        process.stdout.write(`  set_permission_mode: ${mode}\n`);
        void host.setPermissionMode(mode as PermissionMode).catch(() => {});
      },
      // File-upload wire (file-upload spec / ADR-0025). attach_* events
      // feed pending_uploads on the host; the host's validation emits
      // attach_rejected / instruction_rejected straight back to the server.
      onAttachOpen: (msg) => {
        process.stdout.write(
          `  attach_open: ${msg.upload_id} (${msg.mime}, ${msg.size}B, ${msg.chunks} chunks)\n`,
        );
        host.attachOpen(msg);
      },
      onAttachChunk: (payload) => host.attachChunk(payload),
      onAttachClose: (uploadId) => {
        process.stdout.write(`  attach_close: ${uploadId}\n`);
        host.attachClose(uploadId);
      },
    });
  }

  host = new AgentHost(config, {
    onState,
    onLog,
    // attach_rejected / instruction_rejected ride the same envelope path
    // as state/log — the link relays them to the server (file-upload spec).
    onAttachRejected: (envelope) => link?.send(envelope),
    onInstructionRejected: (envelope) => link?.send(envelope),
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
      ...(resumeSessionId !== undefined ? { resume: resumeSessionId } : {}),
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
    // Resume: rebuild the server's display history from the session JSONL
    // (ADR-0014 phase-2, #50). The SDK does not replay past turns into the
    // stream, so reconstruct them from disk and reset-then-replay — a server
    // that kept the pre-crash lines for the same session must not double
    // them. setSessionId stamps the resume id so both the replayed lines and
    // the subsequent live ones group under this session.
    if (resumeSessionId !== undefined && link) {
      link.setSessionId(resumeSessionId);
      // The reset/replay need a server entry to attach to (append_log /
      // reset_history are :noop without one). The idle announce above seeds
      // it, but only in the no-prompt idle-wait mode; a resume that also
      // carries a prompt (spawn with initial_prompt + resume_session_id)
      // skipped it, so seed the entry here before the reset.
      if (prompt !== undefined) {
        link.send(makeStateChange(config, "idle", new Date().toISOString()));
      }
      const history = readSessionHistory(process.cwd(), resumeSessionId, config);
      // Reset first — unconditionally on resume — so a server still holding
      // this session's pre-crash lines is overwritten even when
      // reconstruction yields nothing (e.g. a transcript of only bookkeeping
      // lines); then replay whatever was rebuilt.
      link.sendHistoryReset();
      for (const envelope of history) link.send(envelope);
    } else if (resumeSessionId !== undefined) {
      // Resume without a server link (local mode): the SDK still resumes the
      // conversation, but there is no server display history to rebuild.
      process.stderr.write(
        "  resume: no server configured; display history not rebuilt\n",
      );
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
