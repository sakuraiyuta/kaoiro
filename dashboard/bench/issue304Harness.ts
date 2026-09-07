import { mount } from "svelte";
import "../src/app.css";
import App from "@issue304-app";
import type { FakeChannel, Socket } from "./fakePhoenix.js";

const LOBBY_TOPIC = "agents:lobby";
const BASE_TS_MS = Date.parse("2026-07-01T00:00:00Z");

interface Envelope {
  version: string;
  agent_id: string;
  persona: { id: string; name: string; sprite_set: string };
  ts: string;
  seq: number;
  type: string;
  state: string;
  payload: Record<string, unknown>;
  ext?: Record<string, unknown>;
}

interface AgentSeed {
  agentId: string;
  historyCount: number;
}

function tsFor(seq: number): string {
  return new Date(BASE_TS_MS + seq * 1_000).toISOString();
}

function assistantLog(agentId: string, seq: number): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name: agentId, sprite_set: agentId },
    ts: tsFor(seq),
    seq,
    type: "log",
    state: "thinking",
    payload: {
      kind: "assistant",
      text:
        `## reply ${seq}\n\nこれはベンチ用の合成ログです。` +
        "段落を長めにして markdown レンダリングのコストを再現します。".repeat(3),
    },
  };
}

function stateEnvelope(agentId: string, seq: number): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name: agentId, sprite_set: agentId },
    ts: tsFor(seq),
    seq,
    type: "state_change",
    state: "idle",
    payload: {},
    ...(agentId === "agent-viewed"
      ? { ext: { slash_commands: ["new", "clear", "help"] } }
      : {}),
  };
}

function getChannel(): FakeChannel {
  const socket = (window as unknown as { __fakeSocket?: Socket }).__fakeSocket;
  const channel = socket?._channelFor(LOBBY_TOPIC);
  if (!channel) throw new Error("lobby channel is unavailable");
  return channel;
}

const bench = {
  async waitReady(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const socket = (window as unknown as { __fakeSocket?: Socket })
        .__fakeSocket;
      if (socket?._channelFor(LOBBY_TOPIC)?.joined) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out waiting for fake Phoenix join");
  },

  seed(agents: AgentSeed[]): void {
    const channel = getChannel();
    const snapshot: Record<string, Envelope> = {};
    const histories: Record<string, Envelope[]> = {};
    for (const agent of agents) {
      snapshot[agent.agentId] = stateEnvelope(
        agent.agentId,
        agent.historyCount + 1_000,
      );
      histories[agent.agentId] = Array.from(
        { length: agent.historyCount },
        (_, seq) => assistantLog(agent.agentId, seq),
      );
    }
    channel._emit("snapshot", {
      version: "0",
      agents: snapshot,
      snapshot_incomplete: false,
    });
    channel._emit("history", {
      version: "0",
      agents: histories,
      history_incomplete: false,
    });
  },

  sendLog(agentId: string, seq: number): void {
    getChannel()._emit("envelope", assistantLog(agentId, seq));
  },
};

declare global {
  interface Window {
    __issue304Bench: typeof bench;
    __issue304FormatCalls?: number;
  }
}

window.__issue304Bench = bench;

const target = document.getElementById("app");
if (!target) throw new Error("#app element not found");
mount(App, { target });
