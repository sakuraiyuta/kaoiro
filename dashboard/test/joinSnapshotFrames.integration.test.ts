// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectKaoiro,
  type Envelope,
  type KaoiroConnection,
  type KaoiroHandlers,
} from "../src/lib/protocol";

class AckingWebSocket {
  static instances: AckingWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  readyState = AckingWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(_url: string) {
    AckingWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState === AckingWebSocket.CLOSED) return;
      this.readyState = AckingWebSocket.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data !== "string") return;
    const [joinRef, ref, topic] = JSON.parse(data) as [
      string | null,
      string | null,
      string,
    ];
    setTimeout(() => {
      if (this.readyState !== AckingWebSocket.OPEN) return;
      this.onmessage?.({
        data: JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]),
      });
    }, 0);
  }

  close(): void {
    this.readyState = AckingWebSocket.CLOSED;
    this.onclose?.({});
  }
}

async function settleSocket(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(5);
}

function injectServerPush(ws: AckingWebSocket, event: string, payload: unknown): void {
  ws.onmessage?.({
    data: JSON.stringify([null, null, "agents:lobby", event, payload]),
  });
}

function stateEnvelope(agentId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name: agentId, sprite_set: agentId },
    ts: "2026-08-28T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
  } as unknown as Envelope;
}

function taskEnvelope(agentId: string, taskId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name: agentId, sprite_set: agentId },
    ts: "2026-08-28T00:00:00Z",
    type: "task",
    state: "idle",
    payload: {
      kind: "started",
      agent_id: agentId,
      task_id: taskId,
      task_type: "subagent",
      status: "running",
    },
  } as unknown as Envelope;
}

function handlers() {
  return {
    onStatus: vi.fn(),
    onSnapshot: vi.fn(),
    onSnapshotIncomplete: vi.fn(),
    onTaskSnapshot: vi.fn(),
    onDeliverySnapshot: vi.fn(),
    onDeliverySnapshotIncomplete: vi.fn(),
    onEnvelope: vi.fn(),
  } satisfies KaoiroHandlers;
}

let connection: KaoiroConnection | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  AckingWebSocket.instances = [];
});

afterEach(() => {
  connection?.disconnect();
  connection = null;
  vi.useRealTimers();
});

describe("join snapshot frames (issue #203 V-2)", () => {
  it("agents / tasks / deliveries を各 event から独立に配線する", async () => {
    const captured = handlers();
    connection = connectKaoiro("ws://test/client", captured, {
      transport: AckingWebSocket,
      heartbeatIntervalMs: 1_000,
    });
    await settleSocket();
    const ws = AckingWebSocket.instances[0];
    if (ws === undefined) throw new Error("socket was not created");

    const agent = stateEnvelope("agent-a");
    const task = taskEnvelope("agent-a", "task-a");
    injectServerPush(ws, "snapshot", {
      version: "0",
      agents: { "agent-a": agent },
      snapshot_incomplete: true,
    });
    injectServerPush(ws, "task_snapshot", {
      version: "0",
      tasks: { "agent-a": { "task-a": task } },
    });
    injectServerPush(ws, "delivery_snapshot", {
      version: "0",
      deliveries: {
        "agent-a": {
          issued_seq: 2,
          acked_seq: 1,
          pending_since: "2026-08-28T00:00:00Z",
        },
      },
      snapshot_incomplete: true,
    });

    expect(captured.onSnapshot).toHaveBeenCalledWith({ "agent-a": agent });
    expect(captured.onSnapshotIncomplete).toHaveBeenCalledWith(true);
    expect(captured.onTaskSnapshot).toHaveBeenCalledWith({
      "agent-a": { "task-a": task },
    });
    expect(captured.onDeliverySnapshot).toHaveBeenCalledWith({
      "agent-a": {
        issued_seq: 2,
        acked_seq: 1,
        pending_since: "2026-08-28T00:00:00Z",
      },
    });
    expect(captured.onDeliverySnapshotIncomplete).toHaveBeenCalledWith(true);
  });
});
