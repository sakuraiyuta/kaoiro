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
function inbound(peer: string, deliverySeq: number, body: string): Envelope {
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
      conversation_id: `c-${peer}`,
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
  line({ event: "init", conversation_id: "cid", init: { tools: ["run_command"] } });
  if (args[1].includes("KUROE358_BLOCK")) {
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
  } else {
    line({ event: "result", result: { conversation_id: "cid", status: "SUCCESS", response: "second turn ran" } });
    process.exit(0);
  }
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
});
