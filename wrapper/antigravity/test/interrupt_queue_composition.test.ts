import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Two different peers so the coordinator dispatches both immediately: the
// first turn goes active in the host, the second lands in the host queue.
function inbound(peer: string, deliverySeq: number, body: string, turnNumber = 1, conversationId = `c-${peer}`): Envelope {
  return {
    version: "0",
    agent_id: peer,
    persona: { id: peer, name: peer, sprite_set: peer },
    display_name: peer,
    ts: "2026-09-18T00:00:00Z",
    type: "inter_agent_message",
    state: "thinking",
    payload: {
      to: config.agent_id,
      conversation_id: conversationId,
      turn_number: turnNumber,
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

// A turn whose prompt carries KUROE358_BLOCK stays ACTIVE until SIGTERM; any
// other prompt completes at once. Each `--print` is its own agy process, so a
// per-invocation prompt check is enough.
function writeFixture(root: string): { executable: string; configPath: string } {
  const executable = join(root, "agy-fixture.mjs");
  const configPath = join(root, "wrapper.config.json");
  const hook = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;
  writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2);
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[0] === "models") {
  process.stdout.write("fixture-model\\tFixture Model\\n");
} else if (args[0] === "-p" && args[1] === "/hooks") {
  const customization = args[args.lastIndexOf("--add-dir") + 1];
  process.stdout.write(JSON.stringify({ hooks: [{ source: customization + "/.agents/hooks.json", actions: [{ event: "PreToolUse", matcher: "*", command: ${JSON.stringify(hook)}, timeout_seconds: 3600 }] }] }));
} else if (args[0] === "--print") {
  // The prompt arrives as one NDJSON line on the live epoch's stdin, not as
  // an argv positional; stdin stays open between turns.
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    const boundary = input.indexOf("\\n");
    if (boundary < 0) return;
    const prompt = JSON.parse(input.slice(0, boundary)).message.content;
    line({ event: "init", conversation_id: "cid", init: { tools: ["run_command"] } });
    if (prompt.includes("KUROE358_BLOCK")) {
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1000);
    } else if (prompt.includes("KUROE541_TRIP")) {
      process.on("SIGTERM", () => process.exit(0));
      setTimeout(() => line({ event: "step_update", step_update: { step_index: 513, state: "DONE", step_type: "tool", tool_name: "run_command" } }), 500);
      setInterval(() => {}, 1000);
    } else if (prompt.includes("KUROE541_FAIL")) {
      process.exit(0);
    } else {
      line({ event: "result", result: { conversation_id: "cid", status: "SUCCESS", response: "second turn ran" } });
      process.exit(0);
    }
  });
} else {
  process.exitCode = 2;
}
`);
  chmodSync(executable, 0o755);
  writeFileSync(configPath, JSON.stringify({ ...config, antigravity_cli_path: executable, antigravity_probe_timeout_ms: 45_000 }));
  return { executable, configPath };
}

describe("Antigravity ordinary interrupt preserves the queued peer turn (issue #358)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("drains and acks a second peer's queued turn after the active turn is interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-358-"));
    const { configPath } = writeFixture(root);
    const acknowledgements: number[] = [];
    const sent: Envelope[] = [];
    let options!: Record<string, any>;
    let host: { close(): void } | undefined;
    const run = runAntigravityCli({
      parseCliArgs: () => ({ configPath, prompt: undefined, resume: undefined }),
      probeSshAgentIdentities: async () => "unknown",
      onHostCreated: (created) => { host = created; },
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

    try {
      const deliver = (envelope: Envelope) =>
        (options.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(envelope);
      // peer1's turn goes active and blocks; its turn_start acks seq 1.
      await waitFor(() => options?.onInterAgentMessage !== undefined, () => ({}), 4_000);
      await deliver(inbound("peer1", 1, "KUROE358_BLOCK"));
      await waitFor(() => acknowledgements.includes(1), () => ({ acknowledgements }), 8_000);
      // peer2's turn is enqueued behind the active turn, in the host queue.
      await deliver(inbound("peer2", 2, "KUROE358_FAST"));
      // An ordinary interrupt aborts the active turn; the queued one must survive.
      (options.onInterrupt as () => void)();
      // The preserved turn drains under the new generation and acks seq 2.
      await waitFor(() => acknowledgements.includes(2),
        () => ({ acknowledgements, sent: sent.map((e) => e.type) }), 8_000);
      // No indefinitely pending delivery: both recipient seqs are acknowledged.
      expect(acknowledgements).toContain(1);
      expect(acknowledgements).toContain(2);
      // peer2's preserved turn ran to completion on a real agy child.
      await waitFor(() => sent.some((e) => e.type === "result"),
        () => ({ sent: sent.map((e) => e.type) }), 8_000);
    } finally {
      host?.close();
      await run;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("retires a queued peer batch once on a gate trip, then dispatches that peer's next batch", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-541-"));
    const lifecycleOutput: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lifecycleOutput.push(String(chunk));
      return true;
    });
    const { configPath } = writeFixture(root);
    const acknowledgements: number[] = [];
    const sent: Envelope[] = [];
    const retiredSequences: number[] = [];
    const deliveryEvents: string[] = [];
    let options!: Record<string, any>;
    let host: { close(): void } | undefined;
    const run = runAntigravityCli({
      parseCliArgs: () => ({ configPath, prompt: undefined, resume: undefined }),
      probeSshAgentIdentities: async () => "unknown",
      onHostCreated: (created) => { host = created; },
      createServerLink: (_url, _agentId, createdOptions) => {
        options = createdOptions as unknown as Record<string, any>;
        queueMicrotask(() => {
          options.onPersonaPrompt("persona");
          options.onInterAgentDeliveryStatus({ acked_seq: 0 });
        });
        return {
          close: () => {},
          setSessionId: () => {},
          acknowledgeInterAgentDelivery: (sequence: number) => {
            acknowledgements.push(sequence);
            deliveryEvents.push(`ack:${sequence}`);
          },
          retireInterAgentDeliveries: (envelopes: readonly Envelope[]) => {
            const sequences = envelopes.map((envelope) => (envelope as Envelope & { delivery_seq?: number }).delivery_seq ?? 0);
            retiredSequences.push(...sequences);
            deliveryEvents.push(`retire:${sequences.join(",")}`);
            options.onInterAgentDeliveryStatus({ acked_seq: 1, skipped_ranges: [[2, 2]] });
            for (const envelope of envelopes) {
              const payload = envelope.payload as { conversation_id: string; turn_number: number };
              sent.push({
                version: "0",
                agent_id: "server",
                persona: { id: "server", name: "server", sprite_set: "server" },
                display_name: "server",
                ts: "2026-10-09T00:00:00Z",
                type: "inter_agent_message",
                state: "thinking",
                payload: {
                  to: envelope.agent_id,
                  conversation_id: payload.conversation_id,
                  turn_number: payload.turn_number + 1,
                  kind: "inform",
                  body: "peer error (interrupted)",
                  meta: { done: false, propose_next: "" },
                  owner: { kind: "user", id: "operator" },
                  error: { code: "interrupted", peer: "peer2", message: "interrupted" },
                },
                ext: {},
              } as unknown as Envelope);
            }
            return true;
          },
          send: (envelope: Envelope) => { sent.push(envelope); },
        } as never;
      },
    });

    try {
      const deliver = (envelope: Envelope) =>
        (options.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(envelope);
      await waitFor(() => options?.onInterAgentMessage !== undefined, () => ({}), 4_000);
      await deliver(inbound("peer1", 1, "KUROE541_TRIP"));
      await waitFor(() => acknowledgements.includes(1), () => ({ acknowledgements }), 8_000);
      await deliver(inbound("peer2", 2, "first queued", 1, "c-peer2-first"));
      await deliver(inbound("peer2", 3, "second queued", 1, "c-peer2-next"));

      await waitFor(
        () => acknowledgements.includes(3),
        () => ({ acknowledgements, sent: sent.map((item) => item.type) }),
        12_000,
      );
      const peer2Notices = sent.filter((envelope) => {
        const payload = envelope.payload as { to?: string; error?: { code?: string }; conversation_id?: string; turn_number?: number };
        return envelope.type === "inter_agent_message" &&
          payload.error?.code === "interrupted" &&
          payload.to === "peer2";
      });
      expect(peer2Notices).toHaveLength(1);
      expect((peer2Notices[0]!.payload as { turn_number: number }).turn_number).toBe(2);
      expect(acknowledgements).toEqual([1, 2, 3]);
      expect(retiredSequences).toEqual([2]);
      expect(deliveryEvents.indexOf("retire:2")).toBeLessThan(deliveryEvents.indexOf("ack:2"));
      await waitFor(
        () => sent.some((envelope) => envelope.type === "result" && JSON.stringify(envelope.payload).includes("second turn ran")),
        () => ({ acknowledgements, sent: sent.map((envelope) => envelope.type) }),
        12_000,
      );
      expect(sent.some((envelope) => envelope.type === "result" && JSON.stringify(envelope.payload).includes("second turn ran"))).toBe(true);

      await deliver(inbound("peer2", 4, "KUROE541_FAIL", 3, "c-peer2-first"));
      await waitFor(
        () => acknowledgements.includes(4) && sent.some((envelope) => {
          const payload = envelope.payload as { to?: string; conversation_id?: string; turn_number?: number; error?: { code?: string } };
          return envelope.type === "inter_agent_message" && payload.to === "peer2" &&
            payload.conversation_id === "c-peer2-first" && payload.turn_number === 4 &&
            payload.error?.code === "api_error";
        }),
        () => ({ acknowledgements, sent: sent.map((envelope) => envelope.type) }),
        12_000,
      );
      expect(acknowledgements).toEqual([1, 2, 3, 4]);
      expect(sent.filter((envelope) => {
        const payload = envelope.payload as { to?: string; conversation_id?: string; turn_number?: number; error?: { code?: string } };
        return envelope.type === "inter_agent_message" && payload.to === "peer2" &&
          payload.conversation_id === "c-peer2-first" && payload.turn_number === 4 &&
          payload.error?.code === "api_error";
      })).toHaveLength(1);

      const lifecycle = lifecycleOutput.join("").split("\n")
        .filter((line) => line.startsWith("[kaoiro][antigravity-lifecycle] "))
        .map((line) => JSON.parse(line.slice(line.indexOf("{") )) as Record<string, unknown> & { event: string });
      expect(lifecycle).toContainEqual(expect.objectContaining({
        event: "gate_fault",
        fault_class: "tool_completion_unobserved",
        tool_name: "run_command",
        trip_count: 1,
        probe_result: "started",
      }));
      expect(lifecycle).toContainEqual(expect.objectContaining({
        event: "gate_recovery",
        fault_class: "tool_completion_unobserved",
        tool_name: "run_command",
        trip_count: 1,
        probe_result: "passed",
      }));
    } finally {
      host?.close();
      await run;
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
});
