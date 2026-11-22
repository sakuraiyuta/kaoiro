import "../../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";
import { writeFakeAgy } from "./fake_agy_executable.js";

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

// A prompt carrying BLOCK stays open until it is cancelled; UNHOOKED trips
// the gate after a delay; ECHO answers at once (fixtures/fake-agy-acp.mjs).
function writeFixture(root: string): { executable: string; configPath: string } {
  const executable = writeFakeAgy(root, { env: { FAKE_AGY_PROMPT_LOG: join(root, "prompts.jsonl") } });
  const configPath = join(root, "wrapper.config.json");
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
      parseCliArgs: () => ({ configPath }),
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
      await deliver(inbound("peer1", 1, "BLOCK"));
      await waitFor(() => acknowledgements.includes(1), () => ({ acknowledgements }), 8_000);
      // peer2's turn is enqueued behind the active turn, in the host queue.
      await deliver(inbound("peer2", 2, "ECHO second turn ran"));
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

  it("retires a queued peer batch once on a gate trip; the fault is sticky, so a later batch is retired without starting agy (D3)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-541-"));
    const lifecycleOutput: string[] = [];
    const readLifecycle = () => lifecycleOutput.join("").split("\n")
      .filter((line) => line.startsWith("[kaoiro][antigravity-lifecycle] "))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as
        Record<string, unknown> & { event: string });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lifecycleOutput.push(String(chunk));
      return true;
    });
    const { configPath } = writeFixture(root);
    const acknowledgements: number[] = [];
    const sent: Envelope[] = [];
    const retiredSequences: number[] = [];
    let options!: Record<string, any>;
    let host: { close(): void; state: string } | undefined;
    const run = runAntigravityCli({
      parseCliArgs: () => ({ configPath }),
      probeSshAgentIdentities: async () => "unknown",
      onHostCreated: (created) => { host = created as never; },
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
          retireInterAgentDeliveries: (envelopes: readonly Envelope[]) => {
            retiredSequences.push(...envelopes.map((envelope) => (envelope as Envelope & { delivery_seq?: number }).delivery_seq ?? 0));
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
      await deliver(inbound("peer1", 1, "UNHOOKED run_command 800"));
      await waitFor(() => acknowledgements.includes(1), () => ({ acknowledgements }), 8_000);
      await deliver(inbound("peer2", 2, "ECHO first queued", 1, "c-peer2-first"));
      await waitFor(() => readLifecycle().some((event) => event.event === "gate_fault"),
        () => ({ prompts: existsSync(join(root, "prompts.jsonl")) ? readFileSync(join(root, "prompts.jsonl"), "utf8") : "" }), 12_000);
      await waitFor(() => retiredSequences.includes(2), () => ({ retiredSequences, acknowledgements }), 12_000);
      expect(host?.state).toBe("error");
      await deliver(inbound("peer2", 3, "ECHO second queued", 1, "c-peer2-next"));
      await waitFor(() => retiredSequences.includes(3), () => ({ retiredSequences }), 12_000);
      expect(retiredSequences).toEqual([2, 3]);
      expect(acknowledgements).toEqual([1]);
      expect(sent.some((envelope) => envelope.type === "result" && JSON.stringify(envelope.payload).includes("queued"))).toBe(false);
      const faults = readLifecycle().filter((event) => event.event === "gate_fault");
      expect(faults).toHaveLength(1);
      expect(faults[0]).toMatchObject({ reason: "antigravity_gate_unobserved_tool", detail: "antigravity_gate_unobserved_tool:run_command" });
      await waitFor(() => readLifecycle().some((event) => event.event === "generation_ended"), () => readLifecycle(), 8_000);
      expect(readLifecycle().filter((event) => event.event === "generation_ended")).toHaveLength(1);
    } finally {
      host?.close();
      await run;
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
});
