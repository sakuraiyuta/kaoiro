// issue #448 S2: the startup probe's model rows must reach the server in a
// state envelope before the first turn, through the production composition.
//
// This drives the REAL runClaudeCli() entrypoint with the REAL AgentHost,
// built from the options the CLI itself passes. The one controlled point is
// the probe subprocess: `spawnProbe` returns a fake child that writes a probe
// stdout line, so the real runClaudeProbe parsing, the CLI's startup probe
// call, the host's catalog acceptance and the CLI's onState forwarding all
// run unmodified. The link is stubbed only to capture what is sent, and
// `queryFn` only records calls: starting the real SDK or the real probe from
// a unit test would need an account and the network.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import { AgentHost } from "../src/host.js";
import { runClaudeProbe } from "../src/probe-client.js";
import { projectModel } from "../src/probe.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const probeRows = [
  {
    value: "default",
    display_name: "Default",
    description: "",
    effort_levels: ["low", "high"],
    default_effort: "high",
  },
  {
    value: "sonnet",
    display_name: "Sonnet",
    description: "",
    effort_levels: ["low"],
  },
];

/** A probe child that writes one stdout line and closes with exit 0. */
function probeChild(stdoutLine: string): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new EventEmitter();
  child.stdout = stdout as unknown as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  child.kill = () => true;
  setImmediate(() => {
    stdout.emit("data", Buffer.from(`${stdoutLine}\n`, "utf8"));
    child.emit("close", 0);
  });
  return child;
}

async function runIdleCli(stdoutLine: string): Promise<{
  sent: Envelope[];
  spawnProbe: ReturnType<typeof vi.fn>;
  queryFn: ReturnType<typeof vi.fn>;
  host: AgentHost;
  running: Promise<void>;
}> {
  const sent: Envelope[] = [];
  const spawnProbe = vi.fn(() => probeChild(stdoutLine));
  const queryFn = vi.fn(() => {
    throw new Error("no turn may start in this test");
  });
  let host!: AgentHost;
  const running = runClaudeCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _agentId, options) => {
      queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
      return {
        send: (envelope: Envelope) => { sent.push(envelope); },
        close: () => {},
        currentSessionId: () => null,
      } as never;
    },
    createHost: (cfg, options) => {
      host = new AgentHost(cfg, {
        ...options,
        queryFn: queryFn as never,
        probeFn: (deps) => runClaudeProbe({ ...deps, spawnProbe }),
      });
      return host;
    },
  });
  await vi.waitFor(() => expect(spawnProbe).toHaveBeenCalledTimes(1));
  return { sent, spawnProbe, queryFn, host, running };
}

const catalogValues = (envelope: Envelope | undefined): string[] | undefined =>
  (envelope?.ext?.models as { value: string }[] | undefined)?.map((model) => model.value);

describe("Claude CLI startup probe composition (issue #448)", () => {
  it("forwards the startup probe's model rows in a state envelope before the first turn", async () => {
    const { sent, queryFn, host, running } = await runIdleCli(
      JSON.stringify({ ok: true, models: probeRows, elapsed_ms: 1, source: "init" }),
    );
    try {
      await vi.waitFor(() =>
        expect(sent.at(-1)?.ext?.models).toEqual(probeRows),
      );
      const states = sent.filter((envelope) => envelope.type === "state_change");
      // The first idle announcement precedes the probe and carries the seed.
      expect(catalogValues(states[0])).toEqual(["default"]);
      expect(states.at(-1)?.state).toBe("idle");
      expect(queryFn).not.toHaveBeenCalled();
    } finally {
      host.close();
      await running;
    }
  });

  it("publishes the captured 0.3.293 Haiku catalog before a model turn", async () => {
    const raw = JSON.parse(readFileSync(new URL(
      "./fixtures/claude-agent-sdk-0.3.293.models.json", import.meta.url,
    ), "utf8")) as unknown[];
    const models = raw.map(projectModel);
    const { sent, queryFn, host, running } = await runIdleCli(
      JSON.stringify({ ok: true, models, elapsed_ms: 1, source: "init" }),
    );
    try {
      await vi.waitFor(() => expect(sent.at(-1)?.ext?.models).toEqual(models));
      expect(models.find(model => model?.value === "haiku")).toMatchObject({
        resolved_model: "claude-haiku-5-5",
        effort_levels: ["low", "medium", "high", "xhigh", "max"],
      });
      expect(queryFn).not.toHaveBeenCalled();
    } finally {
      host.close();
      await running;
    }
  });

  it("keeps the seed catalog when the startup probe fails", async () => {
    const { sent, queryFn, host, running } = await runIdleCli(
      JSON.stringify({ ok: false, reason: "auth_failed", elapsed_ms: 1 }),
    );
    try {
      // The probe outcome settles on the next macrotask after its close.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const states = sent.filter((envelope) => envelope.type === "state_change");
      expect(states.length).toBeGreaterThan(0);
      for (const state of states) expect(catalogValues(state)).toEqual(["default"]);
      expect(catalogValues({ ext: host.statusExtSnapshot() } as Envelope)).toEqual(["default"]);
      expect(queryFn).not.toHaveBeenCalled();
    } finally {
      host.close();
      await running;
    }
  });
});
