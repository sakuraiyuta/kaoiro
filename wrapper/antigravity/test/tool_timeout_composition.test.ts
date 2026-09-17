import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

function inbound(deliverySeq: number, body: string): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: { id: "peer", name: "Peer", sprite_set: "peer" },
    display_name: "Peer",
    ts: "2026-09-17T00:00:00Z",
    type: "inter_agent_message",
    state: "thinking",
    payload: {
      to: config.agent_id,
      conversation_id: `c-${deliverySeq}`,
      turn_number: 1,
      kind: "request",
      body,
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
    delivery_seq: deliverySeq,
  } as unknown as Envelope;
}

async function waitFor(predicate: () => boolean, diagnostic: () => unknown, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms: ${JSON.stringify(diagnostic())}`);
}

/** `blocked`: the tool never leaves ACTIVE. `released`: it completes at
 *  100 ms and the turn keeps streaming past the 1 s deadline. Either way the
 *  fixture prints unrelated progress every 100 ms. */
function writeFixture(root: string, mode: "blocked" | "released"): { executable: string; configPath: string; sigtermMarker: string } {
  const executable = join(root, "agy-fixture.mjs");
  const configPath = join(root, "wrapper.config.json");
  const sigtermMarker = join(root, "sigterm.marker");
  const hook = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;
  // call_mcp_tool is agent-internal, so its DONE needs no hook observation.
  const toolName = mode === "blocked" ? "run_command" : "call_mcp_tool";
  writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const step = (step_index, state, extra) => line({ event: "step_update", step_update: { conversation_id: "cid-timeout", step_index, state, ...extra } });
if (args[0] === "models") {
  process.stdout.write("fixture-model\\tFixture Model\\n");
} else if (args[0] === "-p" && args[1] === "/hooks") {
  const customization = args[args.lastIndexOf("--add-dir") + 1];
  process.stdout.write(JSON.stringify({ hooks: [{ source: customization + "/.agents/hooks.json", actions: [{ event: "PreToolUse", matcher: "*", command: ${JSON.stringify(hook)}, timeout_seconds: 3600 }] }] }));
} else if (args[0] === "--print") {
  line({ event: "init", conversation_id: "cid-timeout", init: { tools: [${JSON.stringify(toolName)}] } });
  step(2, "ACTIVE", { step_type: "tool", tool_name: ${JSON.stringify(toolName)}, tool_info: { name: ${JSON.stringify(toolName)}, parameters: { CommandLine: "git fetch origin" } } });
  const progress = setInterval(() => step(3, "ACTIVE", { step_type: "agent_response", text_delta: "." }), 100);
  if (${JSON.stringify(mode)} === "released") {
    setTimeout(() => step(2, "DONE", { step_type: "tool", tool_name: ${JSON.stringify(toolName)}, tool_info: { name: ${JSON.stringify(toolName)}, output: "ok" } }), 100);
    setTimeout(() => {
      clearInterval(progress);
      line({ event: "result", result: { conversation_id: "cid-timeout", status: "SUCCESS", response: "finished after the deadline" } });
      process.exit(0);
    }, 1_600);
  }
  process.on("SIGTERM", () => {
    writeFileSync(${JSON.stringify(sigtermMarker)}, "");
    line({ event: "result", result: { conversation_id: "cid-timeout", status: "SUCCESS", response: "printed on the way out" } });
    process.exit(0);
  });
} else {
  process.exitCode = 2;
}
`);
  chmodSync(executable, 0o755);
  writeFileSync(configPath, JSON.stringify({
    ...config,
    antigravity_cli_path: executable,
    antigravity_probe_timeout_ms: 45_000,
  }));
  return { executable, configPath, sigtermMarker };
}

describe("Antigravity tool deadline through the production default CLI (issue #350)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** `inbound` starts the turn as an inter-agent delivery (real token);
   *  `instruction` starts it as an operator instruction (host-synthesized
   *  token, no inter-agent bookkeeping). */
  async function launch(
    configPath: string,
    trigger: "inbound" | "instruction",
  ): Promise<{ sent: Envelope[]; stderr: string[]; acknowledgements: number[]; finish: () => Promise<void> }> {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
    const sent: Envelope[] = [];
    const acknowledgements: number[] = [];
    let options!: Record<string, any>;
    let host: { close(): void } | undefined;
    const run = runAntigravityCli({
        parseCliArgs: () => ({ configPath, prompt: undefined, resume: undefined }),
        probeSshAgentIdentities: async () => "unknown",
        onHostCreated: (created) => {
          host = created;
          queueMicrotask(() => {
            if (trigger === "inbound") {
              void (options.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
                inbound(1, "run the blocked fetch"),
              );
            } else {
              (options.onInstruction as (text: string) => void)("run the blocked fetch");
            }
          });
        },
        createServerLink: (_url, _agentId, createdOptions) => {
          options = createdOptions as unknown as Record<string, any>;
          queueMicrotask(() => {
            options.onPersonaPrompt("persona");
            options.onInterAgentDeliveryStatus({ acked_seq: 0 });
          });
          return {
            close: () => {},
            setSessionId: () => {},
            acknowledgeInterAgentDelivery: (sequence: number) => { acknowledgements.push(sequence); },
            send: (envelope: Envelope) => { sent.push(envelope); },
          } as never;
        },
    });
    return {
      sent,
      stderr,
      acknowledgements,
      finish: async () => {
        host?.close();
        await run;
      },
    };
  }

  it("terminates a tool that stays ACTIVE past the deadline while stdout keeps flowing", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-tool-timeout-"));
    const { configPath, sigtermMarker } = writeFixture(root, "blocked");
    vi.stubEnv("KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS", "1000");
    const started = performance.now();
    let launched: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      launched = await launch(configPath, "inbound");
      const { sent, stderr } = launched;
      const resultOf = () => sent.find((envelope) => envelope.type === "result");
      await waitFor(() => resultOf() !== undefined, () => ({ sent: sent.map((e) => e.type), stderr }), 8_000);
      const elapsedMs = performance.now() - started;
      expect(resultOf()?.payload).toMatchObject({
        is_error: true, error_subtype: "error_during_execution", error_detail: "tool_timeout",
      });
      expect(elapsedMs).toBeLessThan(6_000);
      expect(existsSync(sigtermMarker)).toBe(true);
      const states = sent.filter((envelope) => envelope.type === "state_change").map((envelope) => envelope.state);
      expect(states.slice(-2)).toEqual(["error", "waiting_input"]);
      await waitFor(
        () => sent.some((envelope) => envelope.type === "inter_agent_message"),
        () => ({ sent: sent.map((e) => e.type) }),
        2_000,
      );
      const notice = sent.find((envelope) => envelope.type === "inter_agent_message");
      expect(notice?.payload).toMatchObject({
        to: "peer.agent", conversation_id: "c-1", error: { code: "timeout" },
      });
      const warning = stderr.find((line) => line.includes("turn watchdog tool timeout"));
      expect(warning).toContain("step=2 tool=run_command elapsed=");
      expect(warning).toContain("threshold=1000ms");
      expect(warning).not.toContain("git fetch");
      const lifecycle = stderr
        .filter((line) => line.startsWith("[kaoiro][antigravity-lifecycle] "))
        .map((line) => JSON.parse(line.slice("[kaoiro][antigravity-lifecycle] ".length)) as Record<string, unknown>);
      expect(lifecycle.find((record) => record.event === "tool_timeout")).toMatchObject({
        turn_token: expect.any(String), step_index: 2, tool_name: "run_command", threshold_ms: 1000,
      });
    } finally {
      await launched?.finish();
      rmSync(root, { force: true, recursive: true });
    }
  }, 15_000);

  it("releases the deadline on DONE so a turn that outlives it completes normally", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-tool-released-"));
    const { configPath, sigtermMarker } = writeFixture(root, "released");
    vi.stubEnv("KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS", "1000");
    let launched: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      launched = await launch(configPath, "inbound");
      const { sent, stderr } = launched;
      const resultOf = () => sent.find((envelope) => envelope.type === "result");
      await waitFor(() => resultOf() !== undefined, () => ({ sent: sent.map((e) => e.type), stderr }), 8_000);
      expect(resultOf()?.payload).toMatchObject({ text: "finished after the deadline" });
      expect(existsSync(sigtermMarker)).toBe(false);
      expect(stderr.join("")).not.toContain("tool timeout");
    } finally {
      await launched?.finish();
      rmSync(root, { force: true, recursive: true });
    }
  }, 15_000);

  it("bounds an operator instruction turn the same way without inter-agent bookkeeping", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-tool-timeout-operator-"));
    const { configPath, sigtermMarker } = writeFixture(root, "blocked");
    vi.stubEnv("KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS", "1000");
    let launched: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      launched = await launch(configPath, "instruction");
      const { sent, stderr, acknowledgements } = launched;
      const resultOf = () => sent.find((envelope) => envelope.type === "result");
      await waitFor(() => resultOf() !== undefined, () => ({ sent: sent.map((e) => e.type), stderr }), 8_000);
      expect(resultOf()?.payload).toMatchObject({
        is_error: true, error_subtype: "error_during_execution", error_detail: "tool_timeout",
      });
      expect(existsSync(sigtermMarker)).toBe(true);
      const states = sent.filter((envelope) => envelope.type === "state_change").map((envelope) => envelope.state);
      expect(states.slice(-2)).toEqual(["error", "waiting_input"]);
      const lifecycle = stderr
        .filter((line) => line.startsWith("[kaoiro][antigravity-lifecycle] "))
        .map((line) => JSON.parse(line.slice("[kaoiro][antigravity-lifecycle] ".length)) as Record<string, unknown>);
      const timeout = lifecycle.find((record) => record.event === "tool_timeout");
      expect(timeout).toMatchObject({ turn_token: expect.any(String), step_index: 2, tool_name: "run_command" });
      // The synthesized token belongs to no delivery and no conversation.
      expect(timeout).not.toHaveProperty("seq_first");
      expect(acknowledgements).toEqual([]);
      expect(sent.filter((envelope) => envelope.type === "inter_agent_message")).toEqual([]);
    } finally {
      await launched?.finish();
      rmSync(root, { force: true, recursive: true });
    }
  }, 15_000);
});
