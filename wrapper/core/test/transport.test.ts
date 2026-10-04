import { beforeEach, describe, expect, it, vi } from "vitest";

// ServerLink wraps phoenix Socket/Channel; mock the module so the channel
// event handlers can be invoked directly. `handlers` captures every
// channel.on(event, cb) registration so a test can fire a synthetic push.
// `lastPush` exposes the most recent channel.push() so a test can drive
// its receive("ok") / receive("error") / receive("timeout") branches.
type PushReceivers = Map<string, (payload: unknown) => void>;
// `lastChannelParams` exposes the join params the channel was opened with,
// so a test can assert what rides the handshake (persona_id / transition_id).
// `handlers` maps an event to EVERY callback registered for it, not just the
// last one. Phoenix 1.8.8's Channel.on appends and its trigger invokes all of
// them; a Map<string, callback> silently collapsed duplicates, which hid a
// raw `channel.on` added on top of an already-bound event (ふじ #218 レビュー
// MF-4 — the structural meta-test below could not see it).
const mock = vi.hoisted(() => ({
  connected: true,
  channelState: "joined",
  handlers: new Map<string, ((payload: unknown) => void)[]>(),
  lastPush: null as { event: string; payload: unknown; receivers: Map<string, (payload: unknown) => void> } | null,
  // Every push in order — `replay_ia` is chunked into several (M4), so a
  // test asserting the split cannot look at `lastPush` alone.
  pushes: [] as { event: string; payload: unknown }[],
  lastChannelParams: null as unknown,
  onOpen: null as (() => void) | null,
  onClose: null as ((event?: { code?: number }) => void) | null,
  // ADR-0051 D2: the hydration verdict rides the JOIN reply, so a test has
  // to be able to fire the join push's receive("ok") the way the phoenix
  // client does on every (re)join.
  joinReceivers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("phoenix", () => {
  class Channel {
    get state() { return mock.channelState; }
    on(event: string, cb: (payload: unknown) => void): void {
      const bound = mock.handlers.get(event);
      if (bound === undefined) mock.handlers.set(event, [cb]);
      else bound.push(cb);
    }
    join(): {
      receive: (
        status: string,
        cb: (payload: unknown) => void,
      ) => ReturnType<Channel["join"]>;
    } {
      const chain = {
        receive(status: string, cb: (payload: unknown) => void) {
          mock.joinReceivers.set(status, cb);
          return chain;
        },
      };
      return chain;
    }
    push(event: string, payload: unknown): {
      receive: (
        status: string,
        cb: (payload: unknown) => void,
      ) => ReturnType<Channel["push"]>;
    } {
      const receivers: PushReceivers = new Map();
      mock.lastPush = { event, payload, receivers };
      mock.pushes.push({ event, payload });
      const chain = {
        receive(status: string, cb: (payload: unknown) => void) {
          receivers.set(status, cb);
          return chain;
        },
      };
      return chain;
    }
    leave(): void {}
  }
  class Socket {
    isConnected(): boolean { return mock.connected; }
    connect(): void {}
    channel(_topic: string, params?: unknown): Channel {
      mock.lastChannelParams = params;
      return new Channel();
    }
    onOpen(cb: () => void): void {
      mock.onOpen = cb;
    }
    disconnect(): void {}
    onClose(callback: (event?: { code?: number }) => void): void { mock.onClose = callback; }
    onError(_callback: () => void): void {}
  }
  return { Channel, Socket };
});

// transport.ts reads the global `WebSocket` as the phoenix transport; stub it
// so the constructor does not depend on the node version's global.
vi.stubGlobal("WebSocket", class {});

import {
  MAX_ACTIVE_TASK_CACHE_BYTES,
  MAX_ACTIVE_TASK_CACHE_ENTRIES,
  MAX_PENDING_DELIVERY_STAGE_REPORTS,
  MAX_REPLAY_IA_PUSH_BYTES,
  SERVER_EVENT_VERSION_POLICY,
  WRAPPER_CONTROL_EVENT_POLICY,
  ServerLink,
  chunkReplayIaItems,
  hydrationVerdictFrom,
} from "../src/transport.js";
import type { ServerLinkOptions } from "../src/transport.js";
import type { Envelope } from "@kaoiro/protocol";
import type { VersionedWrapperEvent } from "../src/transport.js";
import type { QueueOffer } from "../src/queue_lease.js";
import { createDeliveryAcknowledgementRuntime } from "../../agent-common/src/delivery_ack.js";

function emit(event: string, payload: unknown): void {
  const bound = mock.handlers.get(event);
  if (bound === undefined || bound.length === 0) {
    throw new Error(`no handler registered for ${event}`);
  }
  // Every registered callback, matching Phoenix's own trigger (ふじ MF-4).
  for (const handler of bound) handler(payload);
}

describe("ServerLink — initial envelope sequence (#107)", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.lastPush = null;
    mock.pushes = [];
    mock.joinReceivers.clear();
    mock.channelState = "joined";
    mock.onClose = null;
  });

  it("first send は seq=1 を付与し ext を透過する", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    link.send({
      version: "0", agent_id: "a.agent",
      persona: { id: "ao", name: "あお", sprite_set: "ao" },
      display_name: "あお",
      ts: "T", type: "state_change", state: "idle", payload: {},
      ext: { engine: "claude-code",
        session_capabilities: { supports_attachments: true } },
    } as Envelope);

    expect(mock.lastPush).toMatchObject({ event: "envelope", payload: {
      seq: 1, ext: { engine: "claude-code",
        session_capabilities: { supports_attachments: true } },
    } });
  });
});

describe("ServerLink — reconnect active task replay (issue #188)", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.lastPush = null;
    mock.pushes = [];
    mock.onOpen = null;
  });

  it("再接続後に active tasklist を fresh seq で再送し、server 側を復元する", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const state = {
      version: "0", agent_id: "a.agent",
      persona: { id: "ao", name: "あお", sprite_set: "ao" },
      display_name: "あお",
      ts: "T", type: "state_change", state: "idle", payload: {}, ext: {},
    } as Envelope;
    const tasklist = {
      ...state,
      type: "task",
      payload: {
        agent_id: "a.agent",
        task_id: "tasklist",
        task_type: "tasklist",
        kind: "updated",
        status: "running",
        items: [{ text: "調査", status: "in_progress" }],
      },
    } as Envelope;

    link.send(state);
    link.send(tasklist);
    // WrapperChannel.terminate/2 discards TaskStates on the old connection.
    mock.pushes = [];
    mock.onOpen?.();

    expect(mock.pushes.map(({ payload }) => (payload as Envelope).type)).toEqual([
      "state_change",
      "task",
    ]);
    expect(mock.pushes[1]?.payload).toMatchObject({
      seq: 4,
      payload: { task_id: "tasklist", task_type: "tasklist" },
    });
  });

  it("completed task は active cache から外れ、再接続時に復活させない", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const base = {
      version: "0", agent_id: "a.agent",
      persona: { id: "ao", name: "あお", sprite_set: "ao" },
      display_name: "あお",
      ts: "T", type: "task", state: "thinking", ext: {},
    };
    link.send({
      ...base,
      payload: {
        agent_id: "a.agent", task_id: "child-1", task_type: "local_agent",
        kind: "started", status: "running",
      },
    } as Envelope);
    link.send({
      ...base,
      payload: {
        agent_id: "a.agent", task_id: "child-1", task_type: "local_agent",
        kind: "completed", status: "completed",
      },
    } as Envelope);

    mock.pushes = [];
    mock.onOpen?.();

    expect(mock.pushes).toEqual([]);
  });

  it("未完了の終端 event がなくても reconnect cache を bound し、tasklist を優先して残す", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const base = {
      version: "0", agent_id: "a.agent",
      persona: { id: "ao", name: "あお", sprite_set: "ao" },
      display_name: "あお",
      ts: "T", type: "task", state: "thinking", ext: {},
    };

    link.send({
      ...base,
      payload: {
        agent_id: "a.agent", task_id: "tasklist", task_type: "tasklist",
        kind: "updated", status: "running", items: [{ text: "調査", status: "pending" }],
      },
    } as Envelope);
    for (let index = 1; index <= MAX_ACTIVE_TASK_CACHE_ENTRIES; index += 1) {
      link.send({
        ...base,
        payload: {
          agent_id: "a.agent", task_id: `child-${index}`, task_type: "local_agent",
          kind: "started", status: "running",
        },
      } as Envelope);
    }

    mock.pushes = [];
    mock.onOpen?.();
    const replayedIds = mock.pushes.map(
      ({ payload }) => (payload as Envelope).payload.task_id,
    );

    expect(replayedIds).toHaveLength(MAX_ACTIVE_TASK_CACHE_ENTRIES);
    expect(replayedIds).toContain("tasklist");
    expect(replayedIds).not.toContain("child-1");
    expect(replayedIds).toContain(`child-${MAX_ACTIVE_TASK_CACHE_ENTRIES}`);
    expect(stderr).toHaveBeenCalledOnce();
    stderr.mockRestore();
  });

  it("JSON byte ceiling も reconnect cache に適用する", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const base = {
      version: "0", agent_id: "a.agent",
      persona: { id: "ao", name: "あお", sprite_set: "ao" },
      display_name: "あお",
      ts: "T", type: "task", state: "thinking", ext: {},
    };
    const summary = "x".repeat(64_000);
    const sample = {
      ...base,
      payload: {
        agent_id: "a.agent", task_id: "large-0", task_type: "local_agent",
        kind: "started", status: "running", summary,
      },
    } as Envelope;
    const count = Math.floor(
      MAX_ACTIVE_TASK_CACHE_BYTES / Buffer.byteLength(JSON.stringify(sample), "utf8"),
    ) + 1;

    for (let index = 0; index < count; index += 1) {
      link.send({
        ...base,
        payload: {
          agent_id: "a.agent", task_id: `large-${index}`, task_type: "local_agent",
          kind: "started", status: "running", summary,
        },
      } as Envelope);
    }

    mock.pushes = [];
    mock.onOpen?.();
    const replayedIds = mock.pushes.map(
      ({ payload }) => (payload as Envelope).payload.task_id,
    );

    expect(replayedIds.length).toBeLessThan(count);
    expect(replayedIds).not.toContain("large-0");
    expect(replayedIds).toContain(`large-${count - 1}`);
    expect(stderr).toHaveBeenCalledOnce();
    stderr.mockRestore();
  });
});

describe("ServerLink — join params (phase-27 transition_id, #160)", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.lastChannelParams = null;
  });

  it("transitionId を transition_id として join params に載せる", () => {
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      transitionId: "tr-1",
    });

    expect(mock.lastChannelParams).toEqual(expect.objectContaining({
      persona_id: "ao",
      transition_id: "tr-1",
      inter_agent_delivery_ack: "dispatch-v1",
      delivery_resync: "skip-v1",
      delivery_generation: expect.any(String),
    }));
  });

  it("transitionId 未指定なら key ごと省略する", () => {
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });

    expect(mock.lastChannelParams).toEqual(expect.objectContaining({
      persona_id: "ao",
      inter_agent_delivery_ack: "dispatch-v1",
      delivery_resync: "skip-v1",
      delivery_generation: expect.any(String),
    }));
  });

  it("空文字の transitionId も key ごと省略する", () => {
    // The server reads a blank transition_id as a mismatch, not as the
    // legacy absent case, so a blank must never reach the handshake.
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      transitionId: "",
    });

    expect(mock.lastChannelParams).toEqual(expect.objectContaining({
      persona_id: "ao",
      inter_agent_delivery_ack: "dispatch-v1",
      delivery_resync: "skip-v1",
      delivery_generation: expect.any(String),
    }));
  });

  it("同じ transitionId でも wrapper process ごとの delivery_generation は異なる", () => {
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      transitionId: "runner-reuses-this",
    });
    const first = mock.lastChannelParams as { delivery_generation: string };

    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      transitionId: "runner-reuses-this",
    });
    const second = mock.lastChannelParams as { delivery_generation: string };

    expect(first.delivery_generation).not.toBe("runner-reuses-this");
    expect(second.delivery_generation).not.toBe("runner-reuses-this");
    expect(second.delivery_generation).not.toBe(first.delivery_generation);
  });

  it("dispatch-v1 join status と連続 ack push を wire に載せる", async () => {
    const statuses: unknown[] = [];
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onInterAgentDeliveryStatus: (status) => statuses.push(status),
    });
    mock.joinReceivers.get("ok")?.({
      delivery: { issued_seq: 4, acked_seq: 2, pending_since: "T" },
    });
    expect(statuses).toEqual([{ issued_seq: 4, acked_seq: 2, pending_since: "T" }]);

    link.acknowledgeInterAgentDelivery(3);
    expect(mock.lastPush).toMatchObject({
      event: "delivery_ack", payload: { delivery_seq: 3 },
    });
    const pending = link.requestInterAgentDeliveryStatus();
    mock.lastPush?.receivers.get("ok")?.({ delivery: { issued_seq: 4, acked_seq: 3, pending_since: "T" } });
    await expect(pending).resolves.toEqual({ issued_seq: 4, acked_seq: 3, pending_since: "T" });
  });

  it("uses default recovery composition to retire a dropped seq and deliver a later input once", async () => {
    vi.useFakeTimers();
    const arrivals: number[] = [];
    const statuses: unknown[] = [];
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onInterAgentMessage: (envelope) => arrivals.push((envelope as unknown as { delivery_seq: number }).delivery_seq),
      onInterAgentDeliveryStatus: (status) => statuses.push(status),
    });
    try {
      mock.joinReceivers.get("ok")?.({ delivery_resync: "skip-v1", delivery: { issued_seq: 67, acked_seq: 67, pending_since: null } });
      emit("envelope", { version: "0", type: "inter_agent_message", delivery_seq: 69 });
      emit("delivery_status", { version: "0", issued_seq: 69, acked_seq: 67, pending_since: "T" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mock.lastPush).toMatchObject({ event: "delivery_resync", payload: { cutoff: 69, missing_ranges: [[68, 68]] } });
      const pending = mock.lastPush!;
      emit("envelope", { version: "0", type: "inter_agent_message", delivery_seq: 68 });
      expect(arrivals).toEqual([69]);
      pending.receivers.get("ok")?.({ request_id: (pending.payload as { request_id: string }).request_id, delivery: { issued_seq: 69, acked_seq: 68, pending_since: "T", lost_count: 1 }, skipped_ranges: [[68, 68]] });
      await vi.advanceTimersByTimeAsync(0);
      expect(statuses.at(-1)).toEqual({ issued_seq: 69, acked_seq: 68, pending_since: "T", lost_count: 1, skipped_ranges: [[68, 68]] });
      link.acknowledgeInterAgentDelivery(69);
      expect(mock.lastPush).toMatchObject({ event: "delivery_ack", payload: { delivery_seq: 69 } });
      emit("envelope", { version: "0", type: "inter_agent_message", delivery_seq: 69 });
      expect(arrivals).toEqual([69]);
      const discarded = { version: "0", type: "inter_agent_message", delivery_seq: 70 };
      emit("envelope", discarded);
      link.retireInterAgentDeliveries([discarded as unknown as Envelope]);
      expect(mock.lastPush).toMatchObject({ event: "delivery_resync", payload: { missing_ranges: [[70, 70]], reason: "interrupted" } });
      const retirement = mock.lastPush!;
      const drained = link.flushInterAgentRetirements();
      retirement.receivers.get("ok")?.({ request_id: (retirement.payload as { request_id: string }).request_id,
        delivery: { issued_seq: 70, acked_seq: 70, pending_since: null }, skipped_ranges: [[70, 70]] });
      await vi.advanceTimersByTimeAsync(0);
      await drained;
    } finally {
      link.close();
      vi.useRealTimers();
    }
  });
});

describe("ServerLink — ファイルアップロード wire (ADR-0025)", () => {
  beforeEach(() => mock.handlers.clear());

  it("attach_open は payload を onAttachOpen に渡す", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onAttachOpen: (msg) => seen.push(msg),
    });
    emit("attach_open", {
      upload_id: "u1",
      filename: "a.png",
      mime: "image/png",
      size: 100,
      chunks: 1,
    });
    expect(seen).toEqual([
      {
        upload_id: "u1",
        filename: "a.png",
        mime: "image/png",
        size: 100,
        chunks: 1,
      },
    ]);
  });

  it("attach_open の必須フィールド欠落は無視", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onAttachOpen: (msg) => seen.push(msg),
    });
    emit("attach_open", { upload_id: "u1" }); // missing fields
    expect(seen).toEqual([]);
  });

  it("attach_chunk は ArrayBuffer をそのまま渡す", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onAttachChunk: (p) => seen.push(p),
    });
    const buf = new ArrayBuffer(4);
    emit("attach_chunk", buf);
    expect(seen).toEqual([buf]);
  });

  it("attach_chunk は ArrayBufferView も透過する(Node ws)", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onAttachChunk: (p) => seen.push(p),
    });
    const view = new Uint8Array([1, 2, 3]);
    emit("attach_chunk", view);
    expect(seen).toEqual([view]);
  });

  it("attach_chunk が JSON のときはドロップ", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onAttachChunk: (p) => seen.push(p),
    });
    emit("attach_chunk", { not: "binary" });
    expect(seen).toEqual([]);
  });

  it("attach_close は upload_id を onAttachClose に渡す", () => {
    const seen: string[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onAttachClose: (id) => seen.push(id),
    });
    emit("attach_close", { upload_id: "u1" });
    expect(seen).toEqual(["u1"]);
  });

  it("instruction の attachment_ids を onInstruction に渡す", () => {
    const seen: Array<{ text: string; ids?: string[] }> = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onInstruction: (text, ids) =>
        seen.push(ids === undefined ? { text } : { text, ids }),
    });
    emit("instruction", { text: "見て", attachment_ids: ["u1", "u2"] });
    expect(seen).toEqual([{ text: "見て", ids: ["u1", "u2"] }]);
  });

  it("passes the server-owned instruction delivery_intent to its callback", () => {
    const intents: string[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onInstruction: (_text, _ids, intent) => { if (intent) intents.push(intent); },
    });
    emit("instruction", { text: "early", delivery_intent: "early" });
    emit("instruction", { text: "normal", delivery_intent: "normal" });
    expect(intents).toEqual(["early", "normal"]);
  });

  it("instruction の attachment_ids が空 / 非配列なら undefined", () => {
    const seen: Array<{ text: string; ids?: string[] }> = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onInstruction: (text, ids) =>
        seen.push(ids === undefined ? { text } : { text, ids }),
    });
    emit("instruction", { text: "a", attachment_ids: [] });
    emit("instruction", { text: "b", attachment_ids: "wrong" });
    emit("instruction", { text: "c" });
    expect(seen).toEqual([{ text: "a" }, { text: "b" }, { text: "c" }]);
  });

  it("instruction の attachment_ids 内の非文字列は除外する", () => {
    const seen: Array<{ text: string; ids?: string[] }> = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onInstruction: (text, ids) =>
        seen.push(ids === undefined ? { text } : { text, ids }),
    });
    emit("instruction", { text: "mix", attachment_ids: ["u1", 42, "u2"] });
    expect(seen).toEqual([{ text: "mix", ids: ["u1", "u2"] }]);
  });
});

describe("ServerLink — set_model / set_effort 制御 (#54)", () => {
  beforeEach(() => mock.handlers.clear());

  it("set_model は payload.model を onSetModel へ渡す", () => {
    const seen: string[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onSetModel: (value) => seen.push(value),
    });
    emit("set_model", { model: "opus[1m]" });
    expect(seen).toEqual(["opus[1m]"]);
  });

  it("set_effort は payload.effort を onSetEffort へ渡す", () => {
    const seen: string[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onSetEffort: (level) => seen.push(level),
    });
    emit("set_effort", { effort: "max" });
    expect(seen).toEqual(["max"]);
  });

  it("誤フィールド / 非文字列の payload は無視する", () => {
    const model: string[] = [];
    const effort: string[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onSetModel: (value) => model.push(value),
      onSetEffort: (level) => effort.push(level),
    });
    emit("set_model", { value: "opus" }); // wrong field name
    emit("set_model", { model: 42 }); // non-string
    emit("set_effort", { level: "max" }); // wrong field name
    expect(model).toEqual([]);
    expect(effort).toEqual([]);
  });
});

describe("ServerLink — permission synchronization", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.joinReceivers.clear();
    mock.lastChannelParams = null;
    mock.onOpen = null;
  });

  it("negotiated join は authoritative permission_sync まで次の exec barrier を閉じる", async () => {
    const negotiated: boolean[] = [];
    const received: unknown[] = [];
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      permissionSync: {
        engine: "codex",
        onNegotiated: (supported) => negotiated.push(supported),
        onSync: (message, generation) => received.push({ message, generation }),
      },
    });
    expect(mock.lastChannelParams).toEqual(expect.objectContaining({
      permission_sync: { engine: "codex" },
    }));

    mock.joinReceivers.get("ok")?.({ permission_sync: true });
    await expect(link.waitForPermissionSyncNegotiation()).resolves.toBe(true);
    let released = false;
    void link.waitForPermissionSync().then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    emit("permission_sync", { version: "0", control: null, next: null });
    await vi.waitFor(() => expect(released).toBe(true));
    expect(negotiated).toEqual([true]);
    expect(received).toEqual([
      {
        message: { version: "0", control: null, next: null },
        generation: 1,
      },
    ]);
  });

  it("rejects an applied permission_sync whose approval disagrees between submitted and effective (issue #359)", async () => {
    const received: unknown[] = [];
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      permissionSync: {
        engine: "antigravity",
        onSync: (message) => received.push(message),
      },
    });
    mock.joinReceivers.get("ok")?.({ permission_sync: true });
    await expect(link.waitForPermissionSyncNegotiation()).resolves.toBe(true);

    const makeControl = (effectiveApproval: string): Record<string, unknown> => ({
      revision: 5,
      requested: { sandbox: "workspace-write", network_access: false, approval: "local" },
      status: "applied",
      constraints: { approval: "local", enforcement: "advisory" },
      submitted: {
        revision: 5,
        requested: { sandbox: "workspace-write", network_access: false, approval: "local" },
        execution_id: "e5",
      },
      effective: {
        revision: 5,
        requested: {
          sandbox: "workspace-write",
          network_access: false,
          approval: effectiveApproval,
        },
        execution_id: "e5",
        session_id: "s",
        turn_id: "t",
        permission: {
          sandbox: "workspace-write",
          approval: effectiveApproval,
          enforcement: "advisory",
        },
        network_access: false,
      },
    });
    const next = {
      revision: 5,
      requested: { sandbox: "workspace-write", network_access: false, approval: "local" },
    };

    // submitted.approval=local vs effective.requested.approval=never: not the
    // same selection, so the applied evidence is rejected (permissionSyncFrom
    // → null, onSync never fires) and #permissionSyncAccepting stays open.
    emit("permission_sync", { version: "0", control: makeControl("never"), next });
    // A matching approval is accepted.
    emit("permission_sync", { version: "0", control: makeControl("local"), next });

    await vi.waitFor(() => expect(received.length).toBe(1));
    const only = received[0] as {
      control: { effective: { requested: { approval: string } } };
    };
    expect(only.control.effective.requested.approval).toBe("local");
  });

  it("accepts an applied permission_sync whose effective observation omits turn_id (advisory antigravity, issue #359 M1)", async () => {
    const received: unknown[] = [];
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      permissionSync: {
        engine: "antigravity",
        onSync: (message) => received.push(message),
      },
    });
    mock.joinReceivers.get("ok")?.({ permission_sync: true });
    await expect(link.waitForPermissionSyncNegotiation()).resolves.toBe(true);

    const cell = { sandbox: "workspace-write", network_access: false, approval: "local" };
    const submission = { revision: 6, requested: cell, execution_id: "e6" };
    const control = {
      revision: 6,
      requested: cell,
      status: "applied",
      constraints: { approval: "local", enforcement: "advisory" },
      submitted: submission,
      // effective OMITS turn_id — antigravity has no engine per-turn identity.
      effective: {
        ...submission,
        session_id: "s6",
        permission: { sandbox: "workspace-write", approval: "local", enforcement: "advisory" },
        network_access: false,
      },
    };
    emit("permission_sync", {
      version: "0",
      control,
      next: { revision: 6, requested: cell },
    });
    await vi.waitFor(() => expect(received.length).toBe(1));
    const only = received[0] as { control: { effective: Record<string, unknown> } };
    expect(only.control.effective).not.toHaveProperty("turn_id");
    expect(only.control.effective.session_id).toBe("s6");
  });

  it("still rejects an applied permission_sync whose effective turn_id is present but empty (issue #359 M1)", async () => {
    const received: unknown[] = [];
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      permissionSync: {
        engine: "antigravity",
        onSync: (message) => received.push(message),
      },
    });
    mock.joinReceivers.get("ok")?.({ permission_sync: true });
    await expect(link.waitForPermissionSyncNegotiation()).resolves.toBe(true);

    const cell = { sandbox: "workspace-write", network_access: false, approval: "local" };
    const submission = { revision: 7, requested: cell, execution_id: "e7" };
    const control = {
      revision: 7,
      requested: cell,
      status: "applied",
      constraints: { approval: "local", enforcement: "advisory" },
      submitted: submission,
      effective: {
        ...submission,
        session_id: "s7",
        // Present-but-invalid turn_id: optional means absent, NOT empty.
        turn_id: "",
        permission: { sandbox: "workspace-write", approval: "local", enforcement: "advisory" },
        network_access: false,
      },
    };
    emit("permission_sync", {
      version: "0",
      control,
      next: { revision: 7, requested: cell },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(received.length).toBe(0);
  });

  it("legacy join は capability false で既存 dispatch を止めない", async () => {
    const negotiated: boolean[] = [];
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      permissionSync: {
        engine: "codex",
        onNegotiated: (supported) => negotiated.push(supported),
      },
    });
    mock.joinReceivers.get("ok")?.({});

    await expect(link.waitForPermissionSyncNegotiation()).resolves.toBe(false);
    await expect(link.waitForPermissionSync()).resolves.toBeUndefined();
    expect(negotiated).toEqual([false]);
  });

  it("complete positive revision の set_permission だけを host へ relay する", () => {
    const selections: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onSetPermission: (selection) => selections.push(selection),
    });

    emit("set_permission", {
      version: "future-version",
      revision: 1,
      sandbox: "workspace-write",
      network_access: true,
    });
    emit("set_permission", {
      version: "0",
      revision: 2,
      sandbox: "workspace-write",
    });
    emit("set_permission", {
      version: "0",
      revision: 0,
      sandbox: "read-only",
      network_access: false,
    });
    expect(selections).toEqual([
      {
        revision: 1,
        requested: { sandbox: "workspace-write", network_access: true },
      },
    ]);
  });

  it("relays the mutable approval axis on a set_permission (issue #359)", () => {
    const selections: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onSetPermission: (selection) => selections.push(selection),
    });

    // valid approval rides through into requested.
    emit("set_permission", {
      version: "0",
      revision: 4,
      sandbox: "workspace-write",
      network_access: false,
      approval: "local",
    });
    // a malformed approval rejects the whole selection fail-closed (not relayed).
    emit("set_permission", {
      version: "0",
      revision: 5,
      sandbox: "workspace-write",
      network_access: false,
      approval: "bogus",
    });

    expect(selections).toEqual([
      {
        revision: 4,
        requested: {
          sandbox: "workspace-write",
          network_access: false,
          approval: "local",
        },
      },
    ]);
  });

  it("permission outcome を versioned session_lifecycle audit として送る", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    link.reportPermissionLifecycle({
      version: "0",
      kind: "permission_failed",
      at: "2026-09-06T00:00:00Z",
      details: {
        revision: 1,
        requested: { sandbox: "workspace-write", network_access: true },
        reason: "policy_mismatch",
        execution_id: "exec-1",
      },
    });

    expect(mock.lastPush).toEqual(expect.objectContaining({
      event: "session_lifecycle",
      payload: {
        version: "0",
        kind: "permission_failed",
        at: "2026-09-06T00:00:00Z",
        details: {
          revision: 1,
          requested: { sandbox: "workspace-write", network_access: true },
          reason: "policy_mismatch",
          execution_id: "exec-1",
        },
      },
    }));
  });
});

describe("ServerLink — persona_sync (issue #197 段階3, legacy key, revised issue #219 D22)", () => {
  beforeEach(() => mock.handlers.clear());

  it("persona_sync は name/revision を onRenameDisplayName へ渡す", () => {
    const seen: Array<[string, number]> = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onRenameDisplayName: (name, revision) => seen.push([name, revision]),
    });
    emit("persona_sync", { name: "あお(改名)", revision: 1 });
    expect(seen).toEqual([["あお(改名)", 1]]);
  });

  it("非文字列 name / 非数値 revision / 誤フィールドは無視する", () => {
    const seen: Array<[string, number]> = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onRenameDisplayName: (name, revision) => seen.push([name, revision]),
    });
    emit("persona_sync", { name: 42, revision: 1 });
    emit("persona_sync", { name: "x", revision: "1" });
    emit("persona_sync", { name: "x", revision: 1.5 });
    emit("persona_sync", { value: "x", revision: 1 });
    expect(seen).toEqual([]);
  });

  // issue #197 段階3 ふじ MF-4 レビュー指摘: name は plain string
  // チェックだけで、server と同じ trim/grapheme/制御文字 contract を
  // 検証していなかった。`validDisplayNameOrNull` (users projection と
  // 同じ関数) を再利用する形に直した。
  it("空文字 / 64 grapheme 超 / 制御文字混入の name は無視する", () => {
    const seen: Array<[string, number]> = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onRenameDisplayName: (name, revision) => seen.push([name, revision]),
    });
    emit("persona_sync", { name: "", revision: 1 });
    emit("persona_sync", { name: "   ", revision: 2 });
    emit("persona_sync", { name: "a".repeat(65), revision: 3 });
    emit("persona_sync", {
      name: `bad${String.fromCharCode(0x01)}name`,
      revision: 4,
    });
    expect(seen).toEqual([]);
  });

  // grapheme cluster での数え方が server (String.length/1) と一致する
  // ことを、users projection の narrow と同じ境界値で再確認する。
  it("結合文字/ZWJ絵文字で server の 64 grapheme 境界ちょうどの name は通す", () => {
    const seen: Array<[string, number]> = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onRenameDisplayName: (name, revision) => seen.push([name, revision]),
    });
    const boundaryName = "👨‍👩‍👧‍👦".repeat(64);
    emit("persona_sync", { name: boundaryName, revision: 1 });
    expect(seen).toEqual([[boundaryName, 1]]);
  });

  // AgentDirectory.rename/2 は revision を 0 始まりで単調 +1 しか発行
  // しない — 負値は producer の domain 外という意味で定義上 malformed
  // であり、drop する理由はそれだけ (guard poisoning 対策ではない:
  // host.renamePersona の `revision <= #personaRevision` guard は
  // baseline 0 から出発するため、そもそも負値が植わることはない)。
  it("負の revision は無視する", () => {
    const seen: Array<[string, number]> = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onRenameDisplayName: (name, revision) => seen.push([name, revision]),
    });
    emit("persona_sync", { name: "x", revision: -1 });
    expect(seen).toEqual([]);
  });

  // ADR-0015 warn-then-accept (issue #197 段階3, ふじ MF-1 レビュー
  // 指摘): persona_sync は段階3 で新設された server -> wrapper message
  // のうち、version チェックがそもそも実装されていなかった最初の1つ。
  // 一致時は無警告、欠落/不一致時は警告しつつ name/revision が valid
  // なら受理継続する — rename 自体を version でブロックしない。
  it("version が一致 (\"0\") なら警告しない", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seen: Array<[string, number]> = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onRenameDisplayName: (name, revision) => seen.push([name, revision]),
    });
    emit("persona_sync", { version: "0", name: "あお(改名)", revision: 1 });
    expect(seen).toEqual([["あお(改名)", 1]]);
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("version が欠落/不一致でも警告した上で name/revision が valid なら受理継続する", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seen: Array<[string, number]> = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onRenameDisplayName: (name, revision) => seen.push([name, revision]),
    });
    emit("persona_sync", { name: "あお(欠落)", revision: 1 });
    emit("persona_sync", { version: "1", name: "あお(不一致)", revision: 2 });
    expect(seen).toEqual([
      ["あお(欠落)", 1],
      ["あお(不一致)", 2],
    ]);
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(stderr.mock.calls[0]![0]).toContain("persona_sync");
    expect(stderr.mock.calls[0]![0]).toContain("(absent)");
    expect(stderr.mock.calls[1]![0]).toContain("persona_sync");
    expect(stderr.mock.calls[1]![0]).toContain('"1"');
    stderr.mockRestore();
  });
});

// issue #219 D22: dual-emit compatibility — display_name_sync is the NEW
// event (display_name key), fed through the SAME validate+dispatch as
// persona_sync above. Only the happy path + the key itself are pinned
// here; the exhaustive validation-boundary cases (malformed value/
// revision, version stamp) are already covered by the persona_sync
// block above and share the identical code path.
describe("ServerLink — display_name_sync (issue #219 D22, new key)", () => {
  beforeEach(() => mock.handlers.clear());

  it("display_name_sync は display_name/revision を onRenameDisplayName へ渡す", () => {
    const seen: Array<[string, number]> = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onRenameDisplayName: (name, revision) => seen.push([name, revision]),
    });
    emit("display_name_sync", { display_name: "あお(改名)", revision: 1 });
    expect(seen).toEqual([["あお(改名)", 1]]);
  });

  it("version が欠落/不一致でも警告した上で display_name/revision が valid なら受理継続する", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seen: Array<[string, number]> = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onRenameDisplayName: (name, revision) => seen.push([name, revision]),
    });
    emit("display_name_sync", { display_name: "あお(欠落)", revision: 1 });
    expect(seen).toEqual([["あお(欠落)", 1]]);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]![0]).toContain("display_name_sync");
    stderr.mockRestore();
  });

  // D22 の中核 — 同一 revision で dual-emit された 2 event を両方受理して
  // も、revision guard (host 側実装) が適用するのは最初に届いた方だけに
  // なる、という前提を wire 層で確認する。ここでは transport 層の責務
  // (両 event とも同じ callback へ値を渡す) だけを見る — guard 自体は
  // host.ts のテストが担う。
  it("persona_sync と display_name_sync が同一 revision で両方届いても、両方とも onRenameDisplayName へ渡される (guard は host 側の責務)", () => {
    const seen: Array<[string, number]> = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onRenameDisplayName: (name, revision) => seen.push([name, revision]),
    });
    emit("persona_sync", { name: "あお(改名)", revision: 1 });
    emit("display_name_sync", { display_name: "あお(改名)", revision: 1 });
    expect(seen).toEqual([
      ["あお(改名)", 1],
      ["あお(改名)", 1],
    ]);
  });
});

describe("ServerLink — refresh_models 制御 (ADR-0037 F6, phase-18-5)", () => {
  beforeEach(() => mock.handlers.clear());

  it("refresh_models は onRefreshModels を発火する (payload なし)", () => {
    let calls = 0;
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onRefreshModels: () => {
        calls += 1;
      },
    });
    emit("refresh_models", {});
    expect(calls).toBe(1);
  });

  it("refresh_models は payload の余分な key を無視して onRefreshModels を発火する", () => {
    let calls = 0;
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onRefreshModels: () => {
        calls += 1;
      },
    });
    // Forward-compat: additional fields must not suppress the trigger.
    emit("refresh_models", { extra: "ignored", nested: { a: 1 } });
    expect(calls).toBe(1);
  });
});

describe("ServerLink — inter_agent_message inbound (protocol-inter-agent, phase-8)", () => {
  beforeEach(() => mock.handlers.clear());

  it("type=inter_agent_message の envelope を onInterAgentMessage に渡す", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onInterAgentMessage: (env) => seen.push(env),
    });
    const env = {
      type: "inter_agent_message",
      agent_id: "peer.agent",
      payload: { to: "a.agent", body: "hi" },
    };
    emit("envelope", env);
    expect(seen).toEqual([env]);
  });

  it("type 違いの envelope は無視する (state_change など)", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onInterAgentMessage: (env) => seen.push(env),
    });
    emit("envelope", { type: "state_change", agent_id: "a.agent" });
    emit("envelope", "not a map");
    expect(seen).toEqual([]);
  });
});

// phase-28 C2 / CR-MF1. The refusal reason reaches an operator log AND a
// turn injected into the model, so it must be a value from the closed
// vocabulary or nothing at all — never server-supplied free text.
describe("ServerLink — requestSessionReset (phase-28 C2)", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.lastPush = null;
    mock.pushes = [];
  });

  function push(): { link: ServerLink; pending: Promise<{ requestId: string }> } {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
    });
    const pending = link.requestSessionReset("new", "理由");
    return { link, pending };
  }

  it("mode と reason を session_reset_request として送る", async () => {
    const { pending } = push();
    expect(mock.lastPush?.event).toBe("session_reset_request");
    expect(mock.lastPush?.payload).toEqual({ mode: "new", reason: "理由", version: "0" });
    mock.lastPush!.receivers.get("ok")!({ request_id: "rs-1" });
    await expect(pending).resolves.toEqual({ requestId: "rs-1" });
  });

  it("reason 省略時は field ごと送らない", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
    });
    void link.requestSessionReset("clear").catch(() => {});
    expect(mock.lastPush?.payload).toEqual({ mode: "clear", version: "0" });
  });

  it("request_id の無い ok は受理完了と扱わず unknown_error にする (#258)", async () => {
    const { pending } = push();
    mock.lastPush!.receivers.get("ok")!({});
    await expect(pending).rejects.toThrow("unknown_error");
  });

  it("terminal failure は request_id と closed vocabulary を narrow して relay する (#258)", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      onSessionResetFailed: (failure) => seen.push(failure),
    });
    emit("session_reset_failed", { request_id: "rs-1", reason: "timeout" });
    emit("session_reset_failed", {
      request_id: "rs-2",
      reason: "free text must not reach the model",
    });
    emit("session_reset_failed", { request_id: "", reason: "timeout" });
    expect(seen).toEqual([{ requestId: "rs-1", reason: "timeout" }]);
  });

  it.each([
    "agent_busy",
    "session_reset_pending",
    "unsupported_session_reset",
    "runner_unavailable",
  ])("合意語彙の reason %s はそのまま渡す", async (reason) => {
    mock.lastPush = null;
    mock.pushes = [];
    const { pending } = push();
    mock.lastPush!.receivers.get("error")!({ reason });
    await expect(pending).rejects.toThrow(reason);
  });

  it("語彙外・非 object・空文字は unknown_error に潰す (CR-MF1)", async () => {
    for (const payload of [
      { reason: "rm -rf / を実行しました" },
      { reason: "" },
      { reason: 42 },
      // この endpoint の合意語彙は 4 値。lifecycle 全体の語彙 (spawn_failed
      // 等) や旧 operator 経路の語彙 (invalid_mode / forbidden) は reply
      // には現れないので通さない。
      { reason: "spawn_failed" },
      { reason: "invalid_mode" },
      {},
      "agent_busy",
      null,
    ]) {
      mock.lastPush = null;
    mock.pushes = [];
      const { pending } = push();
      mock.lastPush!.receivers.get("error")!(payload);
      await expect(pending).rejects.toThrow("unknown_error");
    }
  });

  it("push timeout は timeout として reject する", async () => {
    const { pending } = push();
    mock.lastPush!.receivers.get("timeout")!({});
    await expect(pending).rejects.toThrow("timeout");
  });
});

describe("ServerLink — requestDirectory (protocol-inter-agent companion)", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.lastPush = null;
    mock.pushes = [];
  });

  it("projects the durable uncertainty summary without inventing a delivery outcome", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    mock.lastPush!.receivers.get("ok")!({ agents: [{ agent_id: "peer.1", persona: {}, state: "idle",
      inter_agent_delivery: { issued_seq: 3, acked_seq: 3, lost_count: 0, uncertain_count: 2,
        last_uncertain: { at: "2026-10-01T00:00:00Z", incarnation: "inc", generation: "gen",
          delivery_seq: 3, reason: "turn_steer_timeout" } } }], users: [] });
    expect((await pending).agents[0]?.inter_agent_delivery).toMatchObject({
      acked_seq: 3, lost_count: 0, uncertain_count: 2,
      last_uncertain: { delivery_seq: 3, reason: "turn_steer_timeout" },
    });
  });

  it("directory_request の reply から agents 配列を返す", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();

    expect(mock.lastPush?.event).toBe("directory_request");
    expect(mock.lastPush?.payload).toEqual({ version: "0" });

    mock.lastPush!.receivers.get("ok")!({
      agents: [
        {
          agent_id: "peer.1",
          persona: { id: "ao", name: "あお", sprite_set: "ao" },
          state: "idle",
          engine: "codex",
          model: "gpt-5.6-sol",
          effort: "high",
        },
        // optional field の型違いはentryごと落とさずfieldだけ省く
        {
          agent_id: "peer.2",
          persona: { id: "fuji", name: "藤", sprite_set: "fuji" },
          state: "thinking",
          engine: 1,
          model: "",
          effort: ["high"],
        },
        // 不正 entry (agent_id 欠落) は filter で落とす
        { persona: {}, state: "thinking" },
      ],
    });

    const { agents, users } = await pending;
    expect(agents).toEqual([
      {
        agent_id: "peer.1",
        persona: { id: "ao", name: "あお", sprite_set: "ao" },
        state: "idle",
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
      {
        agent_id: "peer.2",
        persona: { id: "fuji", name: "藤", sprite_set: "fuji" },
        state: "thinking",
      },
    ]);
    // users キー無しの reply は旧 server 相当 — 空配列に narrow する
    // (issue #197 段階2 D8 back-compat)。
    expect(users).toEqual([]);
  });

  /** Drives one entry through the narrow and returns what survived. */
  async function narrowOne(
    entry: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
    });
    const pending = link.requestDirectory();
    mock.lastPush!.receivers.get("ok")!({
      agents: [
        { agent_id: "peer.1", persona: {}, state: "idle", ...entry },
      ],
    });
    const {
      agents: [narrowed],
    } = await pending;
    return narrowed as unknown as Record<string, unknown>;
  }

  it("状況判断メタデータ 6 field を素通しする (#160)", async () => {
    const narrowed = await narrowOne({
      context: { used_tokens: 1200, max_tokens: 200000, used_percentage: 0.6 },
      session_started_at: "2026-07-28T01:12:44Z",
      turns: 17,
      last_activity_at: "2026-07-28T03:41:09Z",
      conversation: { active: true, peers: ["peer.2"] },
      rate_limits: {
        five_hour: { status: "allowed", utilization: 0.42, resets_at: 1785200000 },
      },
    });

    expect(narrowed).toEqual({
      agent_id: "peer.1",
      persona: {},
      state: "idle",
      context: { used_tokens: 1200, max_tokens: 200000, used_percentage: 0.6 },
      session_started_at: "2026-07-28T01:12:44Z",
      turns: 17,
      last_activity_at: "2026-07-28T03:41:09Z",
      conversation: { active: true, peers: ["peer.2"] },
      rate_limits: {
        five_hour: { status: "allowed", utilization: 0.42, resets_at: 1785200000 },
      },
    });
  });

  it("未知の nested key は写さない", async () => {
    const narrowed = await narrowOne({
      context: {
        used_tokens: 1,
        max_tokens: 2,
        used_percentage: 3,
        cwd: "/secret",
      },
      rate_limits: { five_hour: { utilization: 0.1, quota_owner: "operator" } },
    });

    expect(narrowed.context).toEqual({
      used_tokens: 1,
      max_tokens: 2,
      used_percentage: 3,
    });
    expect(narrowed.rate_limits).toEqual({ five_hour: { utilization: 0.1 } });
  });

  it("malformed な top-level field だけを落とし sibling は残す", async () => {
    const narrowed = await narrowOne({
      // 3 数値が揃わない context は field ごと drop
      context: { used_tokens: 1, max_tokens: "many", used_percentage: 3 },
      conversation: { active: "yes", peers: [] },
      turns: -1,
      session_started_at: "",
      rate_limits: { seven_day: { utilization: 0.71 } },
    });

    expect(narrowed).toEqual({
      agent_id: "peer.1",
      persona: {},
      state: "idle",
      rate_limits: { seven_day: { utilization: 0.71 } },
    });
  });

  it("status が 64 bytes を超える window は drop する", async () => {
    const narrowed = await narrowOne({
      rate_limits: {
        five_hour: { status: "あ".repeat(22), utilization: 0.1 },
        seven_day: { status: "allowed" },
      },
    });

    // 22 全角文字 = 66 bytes > 64。値側 bound を超えた window ごと落とす。
    expect(narrowed.rate_limits).toEqual({ seven_day: { status: "allowed" } });
  });

  it("present な値が 1 つでも不正なら window ごと drop する", async () => {
    // utilization だけを落として resets_at を残すと、不完全な窓が完全な窓の
    // ように読める。plan D4 の「逸脱時は当該 window を drop」に従う。
    const narrowed = await narrowOne({
      rate_limits: {
        five_hour: { utilization: "high", resets_at: 1785200000 },
        seven_day: { resets_at: 1785600000 },
      },
    });

    expect(narrowed.rate_limits).toEqual({
      seven_day: { resets_at: 1785600000 },
    });
  });

  it("field を 1 つも持たない window は drop する", async () => {
    const narrowed = await narrowOne({
      rate_limits: { five_hour: {}, seven_day: { utilization: 0.71 } },
    });

    expect(narrowed.rate_limits).toEqual({ seven_day: { utilization: 0.71 } });
  });

  it("window key の charset / 長さ違反を drop する", async () => {
    const narrowed = await narrowOne({
      rate_limits: {
        "five hour": { utilization: 0.1 },
        [`w${"x".repeat(32)}`]: { utilization: 0.2 },
        five_hour: { utilization: 0.3 },
      },
    });

    expect(narrowed.rate_limits).toEqual({ five_hour: { utilization: 0.3 } });
  });

  it("array を object として受理しない (server の is_map と揃える)", async () => {
    // typeof [] === "object" なので素朴な判定では rate_limits: [{...}] が
    // key "0" の window として通る。Elixir 側は is_map/1 で落とすため、
    // 通してしまうと両側の受理集合がずれる。
    const narrowed = await narrowOne({
      context: [1, 2, 3],
      rate_limits: [{ utilization: 0.1 }],
      conversation: ["peer.2"],
    });

    expect(narrowed).toEqual({
      agent_id: "peer.1",
      persona: {},
      state: "idle",
    });
  });

  it("window 値が array の場合も drop する", async () => {
    const narrowed = await narrowOne({
      rate_limits: {
        five_hour: [{ utilization: 0.1 }],
        seven_day: { utilization: 0.71 },
      },
    });

    expect(narrowed.rate_limits).toEqual({ seven_day: { utilization: 0.71 } });
  });

  it("MAX_SAFE_INTEGER ちょうどは受理する (境界)", async () => {
    const narrowed = await narrowOne({
      context: {
        used_tokens: Number.MAX_SAFE_INTEGER,
        max_tokens: Number.MAX_SAFE_INTEGER,
        used_percentage: 1,
      },
      rate_limits: {
        five_hour: { utilization: -Number.MAX_SAFE_INTEGER },
      },
    });

    expect(narrowed.context).toEqual({
      used_tokens: Number.MAX_SAFE_INTEGER,
      max_tokens: Number.MAX_SAFE_INTEGER,
      used_percentage: 1,
    });
    expect(narrowed.rate_limits).toEqual({
      five_hour: { utilization: -Number.MAX_SAFE_INTEGER },
    });
  });

  it("finite でも 1e20 のような巨大値は drop する", async () => {
    // normative contract は「有限数」ではなく |x| <= 2^53-1。1e20 は
    // finite だが double の精度劣化域にあり、Elixir の任意精度整数と
    // 一致しないため drop する。
    const narrowed = await narrowOne({
      context: { used_tokens: 1e20, max_tokens: 200000, used_percentage: 1 },
      rate_limits: { five_hour: { resets_at: 1e20 } },
    });

    expect(narrowed.context).toBeUndefined();
    expect(narrowed.rate_limits).toBeUndefined();
  });

  it("safe integer 範囲を超える数値は drop する", async () => {
    // Number.isFinite だけでは 2^53 超を通すが、その値は既に精度を失って
    // おり、Elixir が受理した任意精度整数と一致しない。
    const narrowed = await narrowOne({
      context: {
        used_tokens: Number.MAX_SAFE_INTEGER + 2,
        max_tokens: 200000,
        used_percentage: 1,
      },
      rate_limits: {
        five_hour: { utilization: Number.MAX_SAFE_INTEGER + 2 },
        seven_day: { utilization: 0.71 },
      },
    });

    expect(narrowed.context).toBeUndefined();
    expect(narrowed.rate_limits).toEqual({ seven_day: { utilization: 0.71 } });
  });

  it("window 数超過は canonical 優先 + lexical で決定的に 8 件へ切る", async () => {
    const many: Record<string, unknown> = {};
    // 挿入順は canonical を最後にして、key 順に依存しないことを示す。
    for (const key of ["z9", "z8", "z7", "z6", "z5", "z4", "z3", "z2", "z1"]) {
      many[key] = { utilization: 0.1 };
    }
    many.seven_day = { utilization: 0.7 };
    many.five_hour = { utilization: 0.5 };

    const narrowed = await narrowOne({ rate_limits: many });

    expect(Object.keys(narrowed.rate_limits as object)).toEqual([
      "five_hour",
      "seven_day",
      "z1",
      "z2",
      "z3",
      "z4",
      "z5",
      "z6",
    ]);
  });

  it("大小文字混在の overflow は ASCII code-unit 順で切る", async () => {
    // localeCompare だと多くの locale で "a" < "Z" になり、binary sort の
    // server ("Z" < "a") と生存 window が食い違う。ASCII 順で固定する。
    const many: Record<string, unknown> = {};
    for (const key of ["a1", "a2", "a3", "Z1", "Z2", "Z3", "B1", "B2", "B3"]) {
      many[key] = { utilization: 0.1 };
    }

    const narrowed = await narrowOne({ rate_limits: many });

    // ASCII: 大文字 (0x42 'B', 0x5A 'Z') がすべて小文字 (0x61 'a') より前。
    expect(Object.keys(narrowed.rate_limits as object)).toEqual([
      "B1",
      "B2",
      "B3",
      "Z1",
      "Z2",
      "Z3",
      "a1",
      "a2",
    ]);
  });

  it("agents/users が無い reply でも空配列で resolve する (旧 server 後方互換)", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    mock.lastPush!.receivers.get("ok")!({});
    expect(await pending).toEqual({ agents: [], users: [] });
  });

  it("error reply は reject する", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    mock.lastPush!.receivers.get("error")!({ reason: "forbidden" });
    await expect(pending).rejects.toThrow(/directory_request failed/);
  });

  it("timeout は reject する", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    mock.lastPush!.receivers.get("timeout")!(undefined);
    await expect(pending).rejects.toThrow(/directory_request timeout/);
  });

  it("keeps only valid nested wrapper build identities", async () => {
    const valid = await narrowOne({
      build: {
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: false,
        version: "2026.9.123456",
        channel: "release",
      },
    });
    expect(valid.build).toEqual({
      revision: "0123456789abcdef0123456789abcdef01234567",
      dirty: false,
      version: "2026.9.123456",
      channel: "release",
    });

    const unknown = await narrowOne({
      build: { revision: "unknown", dirty: false, version: "unknown", channel: "dev" },
    });
    expect(unknown.build).toEqual({
      revision: "unknown", dirty: false, version: "unknown", channel: "dev",
    });

    for (const build of [
      { revision: "bad", dirty: false, version: "2026.9.0", channel: "dev" },
      { revision: "0123456789abcdef0123456789abcdef01234567", dirty: false, version: "bad", channel: "dev" },
      { revision: "unknown", dirty: false, version: "unknown", channel: "release" },
      { revision: "0123456789abcdef0123456789abcdef01234567", dirty: "false", version: "2026.9.0", channel: "dev" },
    ]) {
      const invalid = await narrowOne({ build });
      expect(invalid).not.toHaveProperty("build");
    }
  });

  // issue #269 W1 (S2 の本体): directory-only 形状の生 payload が narrow を
  // 通って agents に残ることを pin する。完了条件1の wrapper 側。
  it("directory-only 形状 (persona あり / directory_only: true / last_seen あり / engine 等なし) の payload が agents に残る", async () => {
    const narrowed = await narrowOne({
      persona: { id: "no-such-pack" },
      state: "disconnected",
      directory_only: true,
      last_seen: "2026-08-21T00:00:00Z",
    });

    expect(narrowed).toEqual({
      agent_id: "peer.1",
      persona: { id: "no-such-pack" },
      state: "disconnected",
      directory_only: true,
      last_seen: "2026-08-21T00:00:00Z",
    });
  });

  it("keeps only closed disconnect origin/reason pairs in directory entries", async () => {
    const valid = await narrowOne({
      state: "disconnected",
      disconnect: { origin: "agent_self", reason: "crash" },
    });
    expect(valid?.disconnect).toEqual({ origin: "agent_self", reason: "crash" });

    const invalid = await narrowOne({
      state: "disconnected",
      disconnect: { origin: "operator", reason: "crash" },
    });
    expect(invalid).not.toHaveProperty("disconnect");

    const live = await narrowOne({
      state: "idle",
      disconnect: { origin: "agent_self", reason: "crash" },
    });
    expect(live).not.toHaveProperty("disconnect");
  });

  // issue #269 W1 (S1 再発防止): persona キーが無い payload は narrow が
  // entry ごと落とす — この挙動が変わると directory-only entry は
  // wrapper に届かず、ログも残らず消える (S1 が言っていた defect そのもの)。
  it("persona キーが無い payload は entry ごと落ちる", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    mock.lastPush!.receivers.get("ok")!({
      agents: [
        { agent_id: "peer.gone", state: "disconnected", directory_only: true },
      ],
    });
    const { agents } = await pending;
    expect(agents).toEqual([]);
  });

  // issue #269 W2: narrow の閉じ方 — server は true のときだけ載せる規約
  // (F6-2 fail-closed) なので、それ以外の値は field だけ落として entry は
  // 残す。
  it("directory_only が false / 文字列 / 数値なら field が落ちる (entry は残る)", async () => {
    for (const value of [false, "true", 1]) {
      const narrowed = await narrowOne({ directory_only: value });
      expect(narrowed.directory_only).toBeUndefined();
      expect(narrowed.agent_id).toBe("peer.1");
    }
  });

  // issue #269 W3: last_seen も他の optional text field と同じ
  // nonEmptyText narrow — domain 外なら field だけ落として entry は残す。
  it("last_seen が domain 外なら field が落ちる (entry は残る)", async () => {
    for (const value of ["", 123, null]) {
      const narrowed = await narrowOne({ last_seen: value });
      expect(narrowed.last_seen).toBeUndefined();
      expect(narrowed.agent_id).toBe("peer.1");
    }
  });

  it("projects only a complete, valid delivery_modes value", async () => {
    const valid = await narrowOne({
      delivery_modes: { early: "none", yield: "none", stage_reports: true },
    });
    expect(valid.delivery_modes).toEqual({ early: "none", yield: "none", stage_reports: true });

    const malformed = await narrowOne({
      delivery_modes: { early: "unknown", yield: "none", stage_reports: true },
    });
    expect(malformed.delivery_modes).toBeUndefined();
    expect(malformed.agent_id).toBe("peer.1");
  });
});

describe("ServerLink — ADR-0015 stage 2 wrapper -> server stamps", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.lastPush = null;
    mock.pushes = [];
    mock.joinReceivers.clear();
    mock.channelState = "joined";
    mock.onClose = null;
  });

  const versioned = () =>
    Object.entries(WRAPPER_CONTROL_EVENT_POLICY)
      .filter(([, policy]) => policy === "versioned")
      .map(([event]) => event)
      .sort();

  const replayEnvelope = (): Envelope => ({
    version: "0",
    agent_id: "a.agent",
    persona: { id: "ao", name: "あお", sprite_set: "ao" },
    display_name: "あお",
    ts: "2026-08-08T00:00:00Z",
    type: "inter_agent_message",
    state: "idle",
    payload: {
      to: "b.agent",
      conversation_id: "cid-1",
      turn_number: 1,
      kind: "inform",
      body: "hi",
      meta: { done: false, propose_next: "" },
    },
    ext: {},
  } as unknown as Envelope);

  const fire: Record<VersionedWrapperEvent, (link: ServerLink) => void> = {
    delivery_ack: (link) => link.acknowledgeInterAgentDelivery(1),
    disconnect_intent: (link) => void link.reportDisconnectIntent("stop"),
    delivery_status_request: (link) => void link.requestInterAgentDeliveryStatus(),
    yield_claim: (link) => void link.requestYieldClaim({
      incarnation: "inc-1", generation: "gen-1", yield_token: "yield-1",
      conversation_id: "cid-1", turn_number: 1, work_id: "wrk_1", authority_epoch: 1,
    }),
    delivery_stage: (link) => link.reportDeliveryStage({ incarnation: "inc-1", delivery_seq: 1, stage: "queued", at: "2026-09-28T00:00:00Z" }),
    work_transfer_ack: (link) => void link.acknowledgeWorkTransfer({ work_id: "wrk_1", transfer_id: "trf_1" }),
    work_op_result_request: (link) => void link.requestWorkOpResult({ operation_id: "op_1_abcdefghijklmnopqrstuv" }),
    work_status_request: (link) => void link.requestWorkStatus({ work_id: "wrk_1" }),
    work_check_request: (link) => void link.requestWorkCheck({ work_id: "wrk_1", action: "start", expected_revision: 1 }),
    delivery_resync: (link) => void link.requestInterAgentDeliveryResync({ request_id: "request", cutoff: 1, missing_ranges: [[1, 1]] }),
    history_reset: (link) => link.sendHistoryReset("r"),
    replay_ia: (link) => link.sendReplayIa("r", [{ ingress_stamp: [1, 1], envelope: replayEnvelope() }]),
    history_replay_complete: (link) => link.sendHistoryReplayComplete("r"),
    directory_request: (link) => void link.requestDirectory(),
    session_reset_request: (link) => void link.requestSessionReset("new").catch(() => {}),
    session_lifecycle: (link) =>
      link.reportSessionLifecycle(
        "threshold_notice",
        undefined,
        "2026-08-31T00:00:00Z",
      ),
    wrapper_build_info: () => {},
    delivery_queue_control: (link) => void link.queueLease()?.credit("root", "turn"),
  };

  const queuePolicy = { batch_max_items: 10, backlog_max_items: 100, backlog_max_bytes: 524_288 };
  const queueEcho = {
    inter_agent_queue: "credit-v1",
    inter_agent_queue_policy: queuePolicy,
    inter_agent_queue_epoch: "epoch-1",
    inter_agent_queue_resume_required: false,
  };

  it("T1-1: fire table covers every active versioned event", () => {
    expect(WRAPPER_CONTROL_EVENT_POLICY.yield_claim).toBe("versioned");
    expect(Object.keys(fire).sort()).toEqual(versioned());
  });

  it("T1-2: all 17 active versioned events are actually sent", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      interAgentReplyBasis: "v1",
      interAgentDeliveryModes: { version: "v1", early: "none", yield: "tool_boundary", stage_reports: true },
      workControl: "v1",
      interAgentQueuePolicy: queuePolicy,
      buildInfo: { revision: "0123456789012345678901234567890123456789", dirty: false, version: "2026.9.0", channel: "dev" },
    });
    // delivery_ack(1) must name a sequence the ledger has seen issued.
    mock.joinReceivers.get("ok")?.({
      ...queueEcho,
      inter_agent_delivery_modes: "v1", work_control: "v1", inter_agent_delivery_incarnation: "inc-1",
      delivery: { issued_seq: 1, acked_seq: 0, pending_since: "T" },
    });
    for (const trigger of Object.values(fire)) trigger(link);
    expect(mock.pushes.map((push) => push.event).sort()).toEqual(Object.keys(fire).sort());
  });

  it("T1-3: all active versioned payloads carry a flat version", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      interAgentReplyBasis: "v1",
      interAgentDeliveryModes: { version: "v1", early: "none", yield: "tool_boundary", stage_reports: true },
      workControl: "v1",
      interAgentQueuePolicy: queuePolicy,
      buildInfo: { revision: "0123456789012345678901234567890123456789", dirty: false, version: "2026.9.0", channel: "dev" },
    });
    // delivery_ack(1) must name a sequence the ledger has seen issued.
    mock.joinReceivers.get("ok")?.({
      ...queueEcho,
      inter_agent_delivery_modes: "v1", work_control: "v1", inter_agent_delivery_incarnation: "inc-1",
      delivery: { issued_seq: 1, acked_seq: 0, pending_since: "T" },
    });
    for (const trigger of Object.values(fire)) trigger(link);
    for (const push of mock.pushes) expect(push.payload).toMatchObject({ version: "0" });
  });

  describe("operator_input_modes negotiation", () => {
    const declared = { version: "v1", early: "steer" } as const;
    const open = (withDeclaration: boolean) => {
      const seen: boolean[] = [];
      const link = new ServerLink("ws://x/wrapper", "a.agent", {
        personaId: "ao",
        interAgentDeliveryModes: { version: "v1", early: "none", yield: "none", stage_reports: true },
        ...(withDeclaration ? { operatorInputModes: declared } : {}),
        onOperatorInputModes: supported => seen.push(supported),
      });
      return { link, seen };
    };

    it("declares at join and exposes the declaration only after the echo", () => {
      const { link, seen } = open(true);
      expect(mock.lastChannelParams).toMatchObject({ operator_input_modes: declared });
      expect(link.operatorInputModes()).toBeNull();
      mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1", operator_input_modes: "v1" });
      expect(link.operatorInputModes()).toEqual(declared);
      expect(seen).toEqual([true]);
    });

    it("stays unavailable when an old server does not echo", () => {
      const { link, seen } = open(true);
      mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1" });
      expect(link.operatorInputModes()).toBeNull();
      expect(seen).toEqual([false]);
    });

    it("does not declare, and ignores a stray echo, without the option", () => {
      const { link } = open(false);
      expect(mock.lastChannelParams).not.toHaveProperty("operator_input_modes");
      mock.joinReceivers.get("ok")?.({ operator_input_modes: "v1" });
      expect(link.operatorInputModes()).toBeNull();
    });

    it("exposes permission-sync readiness synchronously across join and rejoin", () => {
      const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao", permissionSync: { engine: "codex" } });
      expect(link.permissionSyncPending()).toBe(true);
      mock.joinReceivers.get("ok")?.({ permission_sync: true });
      expect(link.permissionSyncPending()).toBe(true);
      emit("permission_sync", { version: "0", control: null, next: null });
      expect(link.permissionSyncPending()).toBe(false);
      mock.channelState = "joining";
      expect(link.permissionSyncPending()).toBe(true);
      mock.channelState = "joined";
      mock.onOpen?.();
      expect(link.permissionSyncPending()).toBe(true);
      mock.joinReceivers.get("ok")?.({ permission_sync: true });
      emit("permission_sync", { version: "0", control: null, next: null });
      expect(link.permissionSyncPending()).toBe(false);
      const unsynced = new ServerLink("ws://x/wrapper", "b.agent", { personaId: "ao" });
      expect(unsynced.permissionSyncPending()).toBe(false);
    });

    it("drops on disconnect and re-negotiates on the next join", () => {
      const { link, seen } = open(true);
      mock.joinReceivers.get("ok")?.({ operator_input_modes: "v1" });
      mock.onClose?.({ code: 1006 });
      expect(link.operatorInputModes()).toBeNull();
      mock.joinReceivers.get("ok")?.({});
      expect(link.operatorInputModes()).toBeNull();
      mock.joinReceivers.get("ok")?.({ operator_input_modes: "v1" });
      expect(link.operatorInputModes()).toEqual(declared);
      expect(seen).toEqual([true, false, true]);
    });
  });

  it("refuses yield_claim when tool-boundary yield was not negotiated", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      interAgentDeliveryModes: { version: "v1", early: "none", yield: "none", stage_reports: true },
    });
    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1" });
    const claim = link.requestYieldClaim({
      incarnation: "inc-1", generation: "gen-1", yield_token: "yield-1",
      conversation_id: "cid-1", turn_number: 1, work_id: "wrk_1", authority_epoch: 1,
    });
    expect(mock.pushes.filter(push => push.event === "yield_claim")).toEqual([]);
    await expect(claim).rejects.toThrow("yield_claim_unavailable");
  });

  it("矛盾した release buildInfo は wrapper_build_info で unknown/dev に落とす", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      buildInfo: {
        revision: "unknown",
        dirty: true,
        version: "2026.9.0",
        channel: "release",
      },
    });
    mock.joinReceivers.get("ok")!({});
    const push = mock.pushes.find((entry) => entry.event === "wrapper_build_info");
    expect(push?.payload).toMatchObject({
      build_revision: "unknown",
      build_dirty: false,
      build_version: "unknown",
      build_channel: "dev",
    });
  });

  it("reports delivery stages only with the server-issued join incarnation", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      interAgentDeliveryModes: { version: "v1", early: "none", yield: "none", stage_reports: true },
    });
    expect(link.deliveryIncarnation()).toBeNull();
    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1" });
    expect(link.deliveryIncarnation()).toBeNull();
    link.reportDeliveryStage({ incarnation: "invented", delivery_seq: 1, stage: "queued", at: "T" });
    expect(mock.pushes.some(push => push.event === "delivery_stage")).toBe(false);
    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "server-incarnation" });
    expect(link.deliveryIncarnation()).toBe("server-incarnation");
    expect(link.reportDeliveryStage({
      incarnation: "invented", delivery_seq: 1, stage: "queued", at: "T",
    })).toBe(false);
    expect(mock.pushes.some(push => push.event === "delivery_stage")).toBe(false);
    expect(link.reportDeliveryStage({ incarnation: link.deliveryIncarnation()!, delivery_seq: 1, stage: "queued", at: "T" })).toBe(true);
    expect(mock.lastPush).toMatchObject({ event: "delivery_stage", payload: { incarnation: "server-incarnation", generation: expect.any(String) } });
  });

  it.each(["error", "timeout"] as const)("retains a %s stage report until the same-identity rejoin acknowledges it", status => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      interAgentDeliveryModes: { version: "v1", early: "none", yield: "none", stage_reports: true },
    });
    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "inc-a" });
    const report = { incarnation: "inc-a", generation: link.deliveryGeneration(), delivery_seq: 8, stage: "submitted" as const, at: "T" };
    expect(link.reportDeliveryStage(report)).toBe(true);
    const first = mock.lastPush!;
    expect(first.event).toBe("delivery_stage");
    first.receivers.get(status)?.({});

    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "inc-a" });
    const second = mock.lastPush!;
    expect(second.event).toBe("delivery_stage");
    expect(second.payload).toMatchObject(report);
    second.receivers.get("ok")?.({});

    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "inc-a" });
    expect(mock.pushes.filter(push => push.event === "delivery_stage")).toHaveLength(2);
  });

  it("holds a handoff reported while disconnected and resends its captured identity after rejoin", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      interAgentDeliveryModes: { version: "v1", early: "none", yield: "none", stage_reports: true },
    });
    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "inc-a" });
    mock.pushes = [];
    mock.channelState = "errored";
    mock.onClose?.({ code: 1006 });
    expect(link.reportDeliveryStage({
      incarnation: "inc-a", generation: link.deliveryGeneration(), delivery_seq: 9, stage: "submitted", at: "T",
    })).toBe(true);
    expect(mock.pushes).toEqual([]);

    mock.channelState = "joined";
    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "inc-a" });
    expect(mock.lastPush).toMatchObject({
      event: "delivery_stage",
      payload: { incarnation: "inc-a", generation: link.deliveryGeneration(), delivery_seq: 9, stage: "submitted" },
    });
  });

  it("retires unconfirmed reports when a rejoin replaces the incarnation", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      interAgentDeliveryModes: { version: "v1", early: "none", yield: "none", stage_reports: true },
    });
    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "inc-old" });
    link.reportDeliveryStage({
      incarnation: "inc-old", generation: link.deliveryGeneration(), delivery_seq: 7, stage: "queued", at: "T",
    });
    mock.pushes = [];
    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "inc-new" });
    expect(mock.pushes.filter(push => push.event === "delivery_stage")).toEqual([]);
    expect(link.reportDeliveryStage({
      incarnation: "inc-new", generation: link.deliveryGeneration(), delivery_seq: 7, stage: "queued", at: "T2",
    })).toBe(true);
    expect(mock.lastPush).toMatchObject({
      event: "delivery_stage",
      payload: { incarnation: "inc-new", generation: link.deliveryGeneration(), delivery_seq: 7, at: "T2" },
    });
  });

  it("reclaims pending-report capacity when a rejoin replaces the incarnation", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      interAgentDeliveryModes: { version: "v1", early: "none", yield: "none", stage_reports: true },
    });
    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "inc-old" });
    for (let sequence = 1; sequence <= MAX_PENDING_DELIVERY_STAGE_REPORTS; sequence += 1) {
      expect(link.reportDeliveryStage({
        incarnation: "inc-old", generation: link.deliveryGeneration(), delivery_seq: sequence, stage: "queued", at: "T",
      })).toBe(true);
    }
    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "inc-new" });
    expect(link.reportDeliveryStage({
      incarnation: "inc-new", generation: link.deliveryGeneration(), delivery_seq: 1, stage: "queued", at: "T2",
    })).toBe(true);
  });

  it("bounds retained unconfirmed stage reports and accepts new work after an acknowledgement", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      interAgentDeliveryModes: { version: "v1", early: "none", yield: "none", stage_reports: true },
    });
    mock.joinReceivers.get("ok")?.({ inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "inc-a" });
    for (let sequence = 1; sequence <= MAX_PENDING_DELIVERY_STAGE_REPORTS; sequence += 1) {
      expect(link.reportDeliveryStage({
        incarnation: "inc-a", generation: link.deliveryGeneration(), delivery_seq: sequence, stage: "queued", at: "T",
      })).toBe(true);
    }
    expect(link.reportDeliveryStage({
      incarnation: "inc-a", generation: link.deliveryGeneration(), delivery_seq: MAX_PENDING_DELIVERY_STAGE_REPORTS + 1, stage: "queued", at: "T",
    })).toBe(false);
    expect(mock.pushes.filter(push => push.event === "delivery_stage")).toHaveLength(MAX_PENDING_DELIVERY_STAGE_REPORTS);
    mock.lastPush!.receivers.get("ok")?.({});
    expect(link.reportDeliveryStage({
      incarnation: "inc-a", generation: link.deliveryGeneration(), delivery_seq: MAX_PENDING_DELIVERY_STAGE_REPORTS + 1, stage: "queued", at: "T",
    })).toBe(true);
  });

  it("T1-4: control call site は funnel を迂回しない", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/transport.ts", import.meta.url), "utf8"));
    expect((source.match(/this\.\#channel\.push\(/g) ?? [])).toHaveLength(2);
  });

  it("waits for the disconnect intent acknowledgement", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const accepted = link.reportDisconnectIntent("crash");
    expect(mock.lastPush).toMatchObject({
      event: "disconnect_intent",
      payload: { version: "0", reason: "crash" },
    });
    mock.lastPush!.receivers.get("ok")!({});
    await expect(accepted).resolves.toBe(true);

    const rejected = link.reportDisconnectIntent("stop");
    mock.lastPush!.receivers.get("error")!({ reason: "stale_disconnect_owner" });
    await expect(rejected).resolves.toBe(false);
  });
});

describe("ServerLink — requestDirectory の users projection (issue #197 段階2)", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.lastPush = null;
    mock.pushes = [];
  });

  it("users entry を narrow する", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    mock.lastPush!.receivers.get("ok")!({
      agents: [],
      users: [
        { id: "1", kind: "user", display_name: "Ao", role: "operator" },
      ],
    });

    const { users } = await pending;
    expect(users).toEqual([
      { id: "1", kind: "user", display_name: "Ao", role: "operator" },
    ]);
  });

  it("malformed な user entry を 1 件だけ落とし他の user / agent は保持する", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    mock.lastPush!.receivers.get("ok")!({
      agents: [{ agent_id: "peer.1", persona: {}, state: "idle" }],
      users: [
        { id: "1", kind: "user", display_name: "Ao", role: "operator" },
        // id 欠落
        { kind: "user", display_name: "Bad", role: "viewer" },
        // display_name が空文字
        { id: "2", kind: "user", display_name: "", role: "viewer" },
        // role が数値 (型違反)
        { id: "3", kind: "user", display_name: "Bad2", role: 1 },
        // kind が未知の値 (issue #197 段階2 M2 レビュー指摘: 型は
        // string で一致するが allow-list 外の値)
        { id: "5", kind: "agent", display_name: "Bad3", role: "operator" },
        // role が未知の値 (同上、passthrough は却下)。`admin` はこの
        // ケースの題材だったが issue #198 で実在の role になったため、
        // どの role 表にも無い綴りへ差し替えた
        { id: "6", kind: "user", display_name: "Bad4", role: "root" },
        // id が charset (issue #61) 違反
        { id: "has space", kind: "user", display_name: "Bad5", role: "viewer" },
        { id: "4", kind: "user", display_name: "Viewer", role: "viewer" },
      ],
    });

    const { agents, users } = await pending;
    expect(agents).toEqual([
      { agent_id: "peer.1", persona: {}, state: "idle" },
    ]);
    expect(users).toEqual([
      { id: "1", kind: "user", display_name: "Ao", role: "operator" },
      { id: "4", kind: "user", display_name: "Viewer", role: "viewer" },
    ]);
  });

  // admin は valid role なので、unknown role として落としてはならない。
  // ここで落ちると、サーバが送っていても admin だけ users から消え、
  // operator / viewer は通るという非対称な欠落になる (issue #198)。
  // 「users を agent へ出すかどうか」自体は別軸で、
  // KAOIRO_EXPOSE_USERS_TO_AGENTS=false なら admin 含め全員出ない。
  it("admin role の user entry を落とさない", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    mock.lastPush!.receivers.get("ok")!({
      agents: [],
      users: [
        { id: "1", kind: "user", display_name: "Admin", role: "admin" },
        { id: "2", kind: "user", display_name: "Op", role: "operator" },
      ],
    });

    const { users } = await pending;
    expect(users).toEqual([
      { id: "1", kind: "user", display_name: "Admin", role: "admin" },
      { id: "2", kind: "user", display_name: "Op", role: "operator" },
    ]);
  });

  it("users が非配列なら空配列に narrow する", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    mock.lastPush!.receivers.get("ok")!({ agents: [], users: { not: "array" } });

    const { users } = await pending;
    expect(users).toEqual([]);
  });

  // issue #197 段階2 ふじ MF-1 レビュー指摘: 旧実装は display_name を
  // non-empty string としてしか検証しておらず、server 側 M5
  // (`valid_display_name/1`: trim 後 non-empty / 64 grapheme cluster
  // 以下 / 制御文字禁止) がこの narrow に反映されていなかった。overlong
  // / 制御文字混入の user が個別に drop され、正当な sibling は残る
  // ことを固定する。
  it("display_name が 64 grapheme 超・制御文字混入の user を個別に drop する", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    const overlong = "a".repeat(65);
    const withControlChar = `bad${String.fromCharCode(0x01)}name`;
    mock.lastPush!.receivers.get("ok")!({
      agents: [],
      users: [
        { id: "1", kind: "user", display_name: overlong, role: "operator" },
        { id: "2", kind: "user", display_name: withControlChar, role: "viewer" },
        { id: "3", kind: "user", display_name: "OK", role: "operator" },
      ],
    });

    const { users } = await pending;
    expect(users).toEqual([
      { id: "3", kind: "user", display_name: "OK", role: "operator" },
    ]);
  });

  // grapheme cluster での数え方だけが server (`String.length/1`) と
  // 一致する — この narrow が UTF-16 code unit 数や Unicode code point
  // 数で数えていたら、server が「64 以下」として実際に通した ZWJ
  // 絵文字の名前を誤って drop してしまう。境界ちょうど (64 grapheme)
  // の値が生き残ることを pin する (実効性は mutation で確認: grapheme
  // 判定を素の `.length` に戻すとこのテストが red になる)。
  it("結合文字/ZWJ絵文字で server の 64 grapheme 境界ちょうどの display_name を drop しない", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    // "👨‍👩‍👧‍👦" is 1 grapheme cluster but 7 code points / 11 UTF-16
    // code units (ZWJ-joined family emoji) — 64 repeats is exactly the
    // server's grapheme boundary while being far over 64 in either of
    // the other two units.
    const boundaryName = "👨‍👩‍👧‍👦".repeat(64);
    expect([...boundaryName].length).toBeGreaterThan(64);
    expect(boundaryName.length).toBeGreaterThan(64);
    mock.lastPush!.receivers.get("ok")!({
      agents: [],
      users: [
        { id: "1", kind: "user", display_name: boundaryName, role: "operator" },
      ],
    });

    const { users } = await pending;
    expect(users).toEqual([
      { id: "1", kind: "user", display_name: boundaryName, role: "operator" },
    ]);
  });

  // code-review round finding, issue #197 段階2 MF-1 follow-up:
  // isValidDisplayName validated the TRIMMED name but the entry carried
  // the untrimmed original back — a display_name that only becomes
  // valid after trimming (leading/trailing whitespace) was accepted but
  // forwarded with the padding still attached, diverging from the
  // trim-then-validate contract this narrow claims to mirror.
  it("前後に空白を含む display_name は trim 済みの値で forward される", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    mock.lastPush!.receivers.get("ok")!({
      agents: [],
      users: [
        { id: "1", kind: "user", display_name: " Ao ", role: "operator" },
      ],
    });

    const { users } = await pending;
    expect(users).toEqual([
      { id: "1", kind: "user", display_name: "Ao", role: "operator" },
    ]);
  });
});

describe("ServerLink — question_response (ADR-0027)", () => {
  beforeEach(() => mock.handlers.clear());

  it("answers を onQuestionResponse へ渡す", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onQuestionResponse: (r) => seen.push(r),
    });
    emit("question_response", {
      request_id: "q-1",
      answers: { "どれ?": "A" },
    });
    expect(seen).toEqual([{ request_id: "q-1", answers: { "どれ?": "A" } }]);
  });

  it("cancelled を伝える", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onQuestionResponse: (r) => seen.push(r),
    });
    emit("question_response", { request_id: "q-2", answers: {}, cancelled: true });
    expect(seen).toEqual([
      { request_id: "q-2", answers: {}, cancelled: true },
    ]);
  });

  it("request_id 欠落 / answers 非オブジェクトは頑健に扱う", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao",
      onQuestionResponse: (r) => seen.push(r),
    });
    emit("question_response", { answers: {} }); // no request_id -> dropped
    emit("question_response", { request_id: "q-3", answers: "wrong" });
    expect(seen).toEqual([{ request_id: "q-3", answers: {} }]);
  });
});

describe("hydrationVerdictFrom (ADR-0051 D2)", () => {
  it("replay_required: true は replay_id とともに返す", () => {
    expect(
      hydrationVerdictFrom({
        hydration: { replay_required: true, replay_id: "hydr-1" },
      }),
    ).toEqual({ replay_required: true, replay_id: "hydr-1" });
  });

  it("replay_required: false は id 無しで返す", () => {
    expect(hydrationVerdictFrom({ hydration: { replay_required: false } })).toEqual(
      { replay_required: false },
    );
  });

  it("hydration が無い応答 (旧 server) は null = legacy fallback", () => {
    expect(hydrationVerdictFrom({})).toBeNull();
    expect(hydrationVerdictFrom(null)).toBeNull();
    expect(hydrationVerdictFrom({ hydration: "yes" })).toBeNull();
  });

  it("required なのに replay_id が使えない応答は null に潰す", () => {
    // 推測で wrapper 採番の id を使うと server の in_flight 記録と一致せず
    // replay_ia が stale_replay で全部弾かれる。legacy 扱いのほうが安全。
    expect(
      hydrationVerdictFrom({ hydration: { replay_required: true } }),
    ).toBeNull();
    expect(
      hydrationVerdictFrom({ hydration: { replay_required: true, replay_id: "" } }),
    ).toBeNull();
    expect(
      hydrationVerdictFrom({ hydration: { replay_required: 1 } }),
    ).toBeNull();
  });
});

// ふじ 30-10 must-fix M4 の境界。budget は JSON の実 byte 長で測る。
describe("chunkReplayIaItems (ADR-0051 D3-3 / 8MB frame 対策)", () => {
  function row(seq: number, bodyBytes: number): {
    ingress_stamp: [number, number];
    envelope: Envelope;
  } {
    return {
      ingress_stamp: [seq, 0],
      envelope: {
        version: "0",
        agent_id: "host-1.self",
        persona: { id: "ao", name: "あお", sprite_set: "ao" },
        display_name: "あお",
        ts: "2026-08-08T00:00:00Z",
        type: "inter_agent_message",
        state: "idle",
        payload: { body: "x".repeat(bodyBytes) },
        ext: {},
      } as unknown as Envelope,
    };
  }

  it("budget 以内なら 1 chunk のまま", () => {
    const items = [row(1, 10), row(2, 10)];
    expect(chunkReplayIaItems(items, 10_000)).toEqual([items]);
  });

  it("budget ちょうどでは分割せず、1 byte 超えた行から次 chunk へ回す", () => {
    const first = row(1, 100);
    const size = Buffer.byteLength(JSON.stringify(first), "utf8") + 1;

    // 2 行ぶんちょうどの budget: 3 行目だけが溢れる。
    const chunks = chunkReplayIaItems([first, row(2, 100), row(3, 100)], size * 2);

    expect(chunks.map((c) => c.length)).toEqual([2, 1]);
  });

  // ふじ 30-10 2 巡目 should: 単独でも budget に収まらない行を送ると、
  // frame reject → complete 未達 → 再 join で同じ行を送り直す loop に戻る。
  // 破損 sidecar 行と同じく fail-closed で落とし、残りは通す。
  it("budget 単体で超える 1 行は落とし、残りの行は通す", () => {
    const huge = row(1, 5_000);
    const small = row(2, 10);
    const chunks = chunkReplayIaItems([huge, small], 1_000);
    expect(chunks).toEqual([[small]]);
  });

  it("全行が budget 超なら chunk なし (push を出さない)", () => {
    expect(chunkReplayIaItems([row(1, 5_000)], 100)).toEqual([]);
  });

  it("空入力は chunk なし (push を 1 本も出さないため)", () => {
    expect(chunkReplayIaItems([])).toEqual([]);
  });

  it("既定 budget は 8MB frame 上限より十分小さい", () => {
    expect(MAX_REPLAY_IA_PUSH_BYTES).toBeLessThanOrEqual(8_000_000 / 4);
  });
});

describe("ServerLink — hydration verdict と IA acceptance ack (ADR-0051)", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.lastPush = null;
    mock.pushes = [];
    mock.joinReceivers.clear();
  });

  /** An IA envelope whose body fills most of the server's 64 KiB
   *  per-envelope budget — the size the M4 frame-overflow was measured at. */
  function bulkyInterAgentEnvelope(bodyBytes: number): Envelope {
    const envelope = interAgentEnvelope() as unknown as {
      payload: { body: string };
    };
    envelope.payload = { ...envelope.payload, body: "x".repeat(bodyBytes) };
    return envelope as unknown as Envelope;
  }

  function interAgentEnvelope(): Envelope {
    return {
      version: "0",
      agent_id: "host-1.self",
      persona: { id: "ao", name: "あお", sprite_set: "ao" },
      display_name: "あお",
      ts: "2026-08-08T00:00:00Z",
      type: "inter_agent_message",
      state: "idle",
      payload: {
        to: "host-1.peer",
        conversation_id: "cid-1",
        turn_number: 1,
        kind: "inform",
        body: "hi",
        meta: { done: false, propose_next: "" },
        owner: { kind: "user", id: "operator" },
      },
      ext: {},
    } as unknown as Envelope;
  }

  it("join 応答の hydration を onHydration へ渡す (再 join のたび)", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
      onHydration: (verdict) => seen.push(verdict),
    });

    const ok = mock.joinReceivers.get("ok");
    expect(ok).toBeDefined();
    ok?.({ hydration: { replay_required: true, replay_id: "hydr-1" } });
    ok?.({ hydration: { replay_required: false } });
    // 旧 server の join 応答 (hydration 無し) は legacy fallback の null。
    ok?.({});

    expect(seen).toEqual([
      { replay_required: true, replay_id: "hydr-1" },
      { replay_required: false },
      null,
    ]);
  });

  it("IA 送信は acceptance ack の ingress_stamp で onInterAgentAck を呼ぶ", () => {
    const acks: { seq: unknown; stamp: [number, number] }[] = [];
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
      onInterAgentAck: (envelope, stamp) =>
        acks.push({ seq: (envelope as unknown as { seq: unknown }).seq, stamp }),
    });
    link.setSessionId("sess-1");
    link.send(interAgentEnvelope());

    mock.lastPush?.receivers.get("ok")?.({ ingress_stamp: [42, 7] });

    // 記録されるのは実際に wire に乗った envelope (seq / session_id 付き)。
    expect(acks).toEqual([{ seq: 1, stamp: [42, 7] }]);
  });

  it("stamp の無い ack (旧 server) では記録しない", () => {
    const acks: unknown[] = [];
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
      onInterAgentAck: () => acks.push("recorded"),
    });
    link.send(interAgentEnvelope());

    mock.lastPush?.receivers.get("ok")?.({});
    mock.lastPush?.receivers.get("ok")?.({ ingress_stamp: [1] });

    expect(acks).toEqual([]);
  });

  it("IA 以外の envelope には ack hook を張らない", () => {
    const acks: unknown[] = [];
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
      onInterAgentAck: () => acks.push("recorded"),
    });
    link.send({
      version: "0",
      agent_id: "host-1.self",
      persona: { id: "ao", name: "あお", sprite_set: "ao" },
      display_name: "あお",
      ts: "2026-08-08T00:00:00Z",
      type: "log",
      state: "idle",
      payload: { kind: "assistant", text: "x" },
      ext: {},
    } as unknown as Envelope);

    expect(mock.lastPush?.receivers.size).toBe(0);
    expect(acks).toEqual([]);
  });

  it("sendHistoryReset は server 採番 id を使い、省略時のみ wrapper 採番する", () => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
    });

    expect(link.sendHistoryReset("hydr-server")).toBe("hydr-server");
    expect(mock.lastPush).toMatchObject({
      event: "history_reset",
      payload: { replay_id: "hydr-server" },
    });

    const legacyId = link.sendHistoryReset();
    expect(legacyId).toMatch(/^resume-/);
  });

  it("sendReplayIa は replay_id と items をそのまま push する", () => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
    });
    const items = [
      { ingress_stamp: [1, 0] as [number, number], envelope: interAgentEnvelope() },
    ];

    link.sendReplayIa("hydr-1", items);

    expect(mock.lastPush).toMatchObject({
      event: "replay_ia",
      payload: { replay_id: "hydr-1", items },
    });
    expect(mock.pushes.filter((p) => p.event === "replay_ia")).toHaveLength(1);
  });

  // ふじ 30-10 must-fix M5: the acceptance ack has three legs and the tool
  // result depends on which one fires. `send()` only ever read "ok".
  it("sendInterAgent は ok で accepted + stamp を返し、sidecar も記録する", async () => {
    const acks: [number, number][] = [];
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
      onInterAgentAck: (_envelope, stamp) => acks.push(stamp),
    });

    const pending = link.sendInterAgent(interAgentEnvelope());
    mock.lastPush?.receivers.get("ok")?.({ ingress_stamp: [9, 1] });

    await expect(pending).resolves.toEqual({ kind: "accepted", stamp: [9, 1] });
    expect(acks).toEqual([[9, 1]]);
  });

  it("sends a waiter registration outside the envelope, keeps it out of the recorded wire, and reads its id", async () => {
    const recorded: Envelope[] = [];
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
      onInterAgentAck: (envelope) => recorded.push(envelope),
    });
    const registration = { token: "a".repeat(32), call_token: "turn-1", expires_in_ms: 5_000 };
    const pending = link.sendInterAgent(interAgentEnvelope(), undefined, { waiter_registration: registration });
    expect(mock.lastPush).toMatchObject({ event: "envelope", payload: { waiter_registration: registration } });
    expect((mock.lastPush!.payload as Record<string, unknown>).payload).not.toHaveProperty("waiter_registration");
    mock.lastPush?.receivers.get("ok")?.({ ingress_stamp: [9, 3], waiter_registration_id: "reg-1" });
    await expect(pending).resolves.toMatchObject({ kind: "accepted", waiter_registration_id: "reg-1" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).not.toHaveProperty("waiter_registration");
  });

  it("decodes advisory fields additively and normalizes unknown mechanisms", async () => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", { personaId: "ao" });
    const pending = link.sendInterAgent(interAgentEnvelope());
    mock.lastPush?.receivers.get("ok")?.({
      ingress_stamp: [9, 2],
      delivery_authority: { requested: "early", granted: "normal", downgrade: "early_quota" },
      delivery: { advisory: { recipient_state: "thinking", granted: "normal", mechanism: "future-mechanism", unresolved_count: 4, guidance: "accepted; do not resend" } },
      work_control_result: { op: "revise", operation_id: "op_1_abcdefghijklmnopqrstuv", outcome: "applied" },
    });
    await expect(pending).resolves.toMatchObject({
      kind: "accepted", stamp: [9, 2],
      delivery_authority: { requested: "early", granted: "normal" },
      delivery: { advisory: { mechanism: "unknown", guidance: "accepted; do not resend" } },
      work_control_result: { op: "revise", outcome: "applied" },
    });
  });

  it("decodes the yield-token-unavailable downgrade reason", async () => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", { personaId: "ao" });
    const pending = link.sendInterAgent(interAgentEnvelope());
    mock.lastPush?.receivers.get("ok")?.({
      ingress_stamp: [9, 3],
      delivery_authority: { requested: "yield", granted: "early", downgrade: "yield_token_unavailable" },
    });
    await expect(pending).resolves.toMatchObject({
      kind: "accepted",
      delivery_authority: { requested: "yield", granted: "early", downgrade: "yield_token_unavailable" },
    });
  });

  it("projects work-transfer acknowledgements without exposing extra server fields", async () => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
      workControl: "v1",
    });
    mock.joinReceivers.get("ok")?.({ work_control: "v1" });
    const pending = link.acknowledgeWorkTransfer({ work_id: "wrk_1", transfer_id: "trf_1" });
    mock.lastPush?.receivers.get("ok")?.({
      work_id: "wrk_1",
      transfer_id: "trf_1",
      state: "acknowledged",
      work: { secret: "must not reach the tool" },
    });
    await expect(pending).resolves.toEqual({
      work_id: "wrk_1",
      transfer_id: "trf_1",
      state: "acknowledged",
    });
  });

  it.each([
    { work_id: "other", transfer_id: "trf_1", state: "acknowledged" },
    { work_id: "wrk_1", transfer_id: "other", state: "acknowledged" },
    { work_id: "wrk_1", transfer_id: "trf_1", state: "pending" },
  ])("rejects a malformed work-transfer acknowledgement result", async reply => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
      workControl: "v1",
    });
    mock.joinReceivers.get("ok")?.({ work_control: "v1" });
    const pending = link.acknowledgeWorkTransfer({ work_id: "wrk_1", transfer_id: "trf_1" });
    mock.lastPush?.receivers.get("ok")?.(reply);
    await expect(pending).rejects.toThrow("work_transfer_ack returned an invalid result");
  });

  it("sendInterAgent は error で rejected + reason を返し、記録はしない", async () => {
    const acks: unknown[] = [];
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
      onInterAgentAck: () => acks.push("recorded"),
    });

    const pending = link.sendInterAgent(interAgentEnvelope());
    mock.lastPush?.receivers.get("error")?.({ reason: "unknown_agent" });

    await expect(pending).resolves.toEqual({
      kind: "rejected",
      reason: "unknown_agent",
    });
    expect(acks).toEqual([]);
  });

  it.each([
    {
      reason: "work_operation_deduplicated",
      details: {
        operation_id: "op_1_abcdefghijklmnopqrstuv",
        delivery: "recorded",
        work_control_result: { op: "assign", operation_id: "op_1_abcdefghijklmnopqrstuv", outcome: "applied", deduplicated: true },
      },
    },
    {
      reason: "work_outcome_unknown",
      details: { operation_id: "op_2_abcdefghijklmnopqrstuv" },
    },
    {
      reason: "work_applied_message_rejected",
      details: {
        operation_id: "op_3_abcdefghijklmnopqrstuv",
        delivery: "not_recorded",
        work_control_result: { op: "assign", operation_id: "op_3_abcdefghijklmnopqrstuv", outcome: "applied" },
      },
    },
  ])("decodes the structured $reason rejection without manufacturing acceptance", async ({ reason, details }) => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", { personaId: "ao" });
    const pending = link.sendInterAgent(interAgentEnvelope());
    mock.lastPush?.receivers.get("error")?.({ reason, send_not_attempted: true, details });
    const acceptance = await pending;
    expect(acceptance).toMatchObject({ kind: "rejected", reason, send_not_attempted: true, details });
    expect(acceptance).not.toHaveProperty("stamp");
  });

  it("narrowly carries disconnect attribution on a preflight rejection", async () => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
    });

    const pending = link.sendInterAgent(interAgentEnvelope());
    mock.lastPush?.receivers.get("error")?.({
      reason: "disconnected",
      disconnect: { origin: "unplanned", reason: "socket_lost" },
    });

    await expect(pending).resolves.toEqual({
      kind: "rejected",
      reason: "disconnected",
      disconnect: { origin: "unplanned", reason: "socket_lost" },
    });
  });

  // issue #177 / こはく合意の Stage 3 回帰: server が :conversation_closed を
  // 返したときも、既存 reason (unknown_agent 等) と同じ pushRejectReason()
  // 実コード経路で rejected + reason に写ることを確認する。「他 reason で
  // 通っているから通るはず」の推定に留めない (こはく条件1)。
  it("sendInterAgent は conversation_closed も他の reject reason と同じ経路で返す (#177)", async () => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
    });

    const pending = link.sendInterAgent(interAgentEnvelope());
    mock.lastPush?.receivers.get("error")?.({ reason: "conversation_closed" });

    await expect(pending).resolves.toEqual({
      kind: "rejected",
      reason: "conversation_closed",
    });
  });

  it("sendInterAgent は peer_reconnecting を sidecar に記録せず機械識別可能に返す", async () => {
    const acks: unknown[] = [];
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
      onInterAgentAck: () => acks.push("recorded"),
    });

    const pending = link.sendInterAgent(interAgentEnvelope());
    mock.lastPush?.receivers.get("error")?.({ reason: "peer_reconnecting" });

    await expect(pending).resolves.toEqual({
      kind: "rejected",
      reason: "peer_reconnecting",
    });
    expect(acks).toEqual([]);
  });

  it("sendInterAgent は timeout を unknown として返す (配送されたかは不明)", async () => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
    });

    const pending = link.sendInterAgent(interAgentEnvelope());
    mock.lastPush?.receivers.get("timeout")?.({});

    await expect(pending).resolves.toEqual({ kind: "unknown", reason: "timeout" });
  });

  it("reason の無い / 壊れた error 応答は unknown に正規化する", async () => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
    });

    for (const payload of [{}, { reason: "" }, { reason: 7 }, null]) {
      const pending = link.sendInterAgent(interAgentEnvelope());
      mock.lastPush?.receivers.get("error")?.(payload);
      await expect(pending).resolves.toEqual({
        kind: "rejected",
        reason: "unknown",
      });
    }
  });

  it("stamp 無し ack でも accepted (旧 server): 配送は成功、復元だけ不可", async () => {
    const acks: unknown[] = [];
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
      onInterAgentAck: () => acks.push("recorded"),
    });

    const pending = link.sendInterAgent(interAgentEnvelope());
    mock.lastPush?.receivers.get("ok")?.({});

    await expect(pending).resolves.toEqual({ kind: "accepted", stamp: null });
    expect(acks).toEqual([]);
  });

  // ふじ 30-10 must-fix M4: 200 行 × 最大 64 KiB envelope = 約 12 MB。
  // wrapper socket の max_frame_size は 8 MB なので、単一 push だと frame
  // ごと reject → complete 未達 → 再 join で同じ batch を無限に送り直す。
  it("sendReplayIa は 8MB frame を超えない大きさに分割し、同じ replay_id で送る", () => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
    });

    // 実測に合わせた最悪ケース: 上限いっぱいの envelope が 200 行。
    const items = Array.from({ length: 200 }, (_, i) => ({
      ingress_stamp: [1000 + i, 0] as [number, number],
      envelope: bulkyInterAgentEnvelope(60_000),
    }));
    // 前提の pin: 分割しなければ 8MB frame 上限を実際に超える入力である。
    expect(
      Buffer.byteLength(JSON.stringify({ replay_id: "hydr-1", items }), "utf8"),
    ).toBeGreaterThan(8_000_000);

    link.sendReplayIa("hydr-1", items);

    const pushes = mock.pushes.filter((p) => p.event === "replay_ia");
    expect(pushes.length).toBeGreaterThan(1);
    for (const push of pushes) {
      const payload = push.payload as { replay_id: string; items: unknown[] };
      expect(payload.replay_id).toBe("hydr-1");
      expect(Buffer.byteLength(JSON.stringify(push.payload), "utf8")).toBeLessThan(
        8_000_000,
      );
      // 1 push あたりの行数も server の @max_replay_ia_items 内に収まる。
      expect(payload.items.length).toBeLessThanOrEqual(200);
    }
    // 1 行も落とさない。
    expect(
      pushes.reduce(
        (n, p) => n + (p.payload as { items: unknown[] }).items.length,
        0,
      ),
    ).toBe(200);
  });

  it("空の items は push しない (server の hydration 状態を触らない)", () => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
    });
    link.sendReplayIa("hydr-1", []);
    expect(mock.pushes.filter((p) => p.event === "replay_ia")).toEqual([]);
  });

  it("currentSessionId は未報告なら null (fresh session = 空 replay)", () => {
    const link = new ServerLink("ws://localhost:4000/wrapper", "host-1.self", {
      personaId: "ao",
    });
    expect(link.currentSessionId()).toBeNull();
    link.setSessionId("sess-1");
    expect(link.currentSessionId()).toBe("sess-1");
  });
});

// ADR-0015 receiver check, structurally (issue #218). The per-event
// warn-then-accept behaviour was previously pinned for `persona_sync` /
// `display_name_sync` only — the two events that happened to carry the
// check. #218 moved the check into `#bindServerEvent`, so what needs
// pinning now is the STRUCTURE: every event this transport binds either
// runs the check or is a declared carve-out. A raw `channel.on` added
// later fails the first test here rather than going quietly unchecked.
describe("ServerLink — server -> wrapper version check の構造 (issue #218)", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.lastPush = null;
    mock.pushes = [];
  });

  /** Every event name actually registered on the channel by a fresh link. */
  function registeredEvents(): string[] {
    mock.handlers.clear();
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    return [...mock.handlers.keys()].sort();
  }

  it("登録済み event はすべて policy 表に載っている (checked か carve-out)", () => {
    const declared = Object.keys(SERVER_EVENT_VERSION_POLICY).sort();
    expect(registeredEvents()).toEqual(declared);
  });

  // 表に無い event を足す迂回は上のテストが拾うが、**既存 event の上に**
  // 素の channel.on を重ねる迂回は event 名の集合を変えないので拾えない
  // (ふじ #218 レビュー MF-4)。Phoenix は同一 event の全 callback を呼ぶ
  // ので、その handler は check を通らずに payload を受け取る。登録数を
  // 直接 assert してその経路を塞ぐ。
  it("各 declared event はちょうど 1 回だけ bind される", () => {
    mock.handlers.clear();
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });

    const counts = [...mock.handlers.entries()].map(
      ([event, bound]) => [event, bound.length] as const,
    );
    expect(counts.filter(([, n]) => n !== 1)).toEqual([]);
    // 表が空になって vacuously green になっていないことの担保。
    expect(counts.length).toBe(Object.keys(SERVER_EVENT_VERSION_POLICY).length);
  });

  it("checked な event は version 不一致で警告し、処理は継続する", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const checked = Object.entries(SERVER_EVENT_VERSION_POLICY)
      .filter(([, policy]) => policy === "checked")
      .map(([event]) => event);
    // Guard against the table silently emptying out — an all-carve-out
    // table would make this test vacuously green.
    expect(checked.length).toBeGreaterThan(10);

    for (const event of checked) {
      mock.handlers.clear();
      new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
      stderr.mockClear();
      emit(event, { version: "9" });
      expect(stderr, `${event} は不一致を警告する`).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0]![0]).toContain(event);
      expect(stderr.mock.calls[0]![0]).toContain('"9"');

      stderr.mockClear();
      emit(event, {});
      expect(stderr, `${event} は欠落を警告する`).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0]![0]).toContain("(absent)");

      stderr.mockClear();
      emit(event, { version: "0" });
      expect(stderr, `${event} は一致なら無警告`).not.toHaveBeenCalled();
    }
    stderr.mockRestore();
  });

  it("binaryFrame の carve-out は version を検査しない", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const carveOuts = Object.entries(SERVER_EVENT_VERSION_POLICY)
      .filter(([, policy]) => policy === "binaryFrame")
      .map(([event]) => event);
    expect(carveOuts).toEqual(["attach_chunk"]);

    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    for (const event of carveOuts) {
      stderr.mockClear();
      emit(event, new Uint8Array([1, 2, 3]).buffer);
      expect(stderr, `${event} は binary frame なので検査しない`).not.toHaveBeenCalled();
    }
    stderr.mockRestore();
  });
});


it("captures a read-only replay fence invalidated by disconnection, channel loss and replacement join", () => {
  mock.connected = true;mock.channelState = "joined";mock.pushes = [];
  const link = new ServerLink("ws://x/wrapper", "history.agent", { personaId: "p" });
  const beforeJoin = link.captureHistoryReplayFence();expect(beforeJoin()).toBe(false);
  mock.joinReceivers.get("ok")?.({});
  const first = link.captureHistoryReplayFence(), pushes = [...mock.pushes];expect(first()).toBe(true);
  mock.connected = false;expect(first()).toBe(false);
  mock.connected = true;mock.channelState = "joining";expect(first()).toBe(false);
  mock.channelState = "joined";mock.joinReceivers.get("ok")?.({});
  expect(first()).toBe(false);expect(link.captureHistoryReplayFence()()).toBe(true);
  expect(beforeJoin()).toBe(false);expect(mock.pushes).toEqual(pushes);
});

describe("reply-basis negotiation", () => {
  it("uses the notice attribution echo only for the current joined channel", () => {
    const modes: string[] = [];
    const link = new ServerLink("ws://test", "self", { personaId: "p", noticeAttribution: "v1",
      onNoticeAttributionMode: mode => modes.push(mode) });
    try {
      expect(mock.lastChannelParams).toMatchObject({ notice_attribution: "v1" });
      expect(link.noticeAttributionMode()).toBe("pending");
      mock.joinReceivers.get("ok")?.({ notice_attribution: "v1" });
      expect(link.noticeAttributionMode()).toBe("v1");
      mock.joinReceivers.get("ok")?.({});
      expect(link.noticeAttributionMode()).toBe("legacy");
      expect(modes).toEqual(["v1", "legacy"]);
    } finally { link.close(); }
  });
  it("advertises v1, waits for the echo, and reports a legacy rejoin", async () => {
    const modes: string[] = [];
    const link = new ServerLink("ws://test", "self", { personaId: "p", interAgentReplyBasis: "v1", onReplyBasisMode: mode => modes.push(mode) });
    try {
      expect(mock.lastChannelParams).toMatchObject({ inter_agent_reply_basis: "v1" });
      let resolved = false;
      const waiting = link.waitForReplyBasisMode().then(mode => { resolved = true; return mode; });
      await Promise.resolve(); expect(resolved).toBe(false);
      mock.joinReceivers.get("ok")?.({ inter_agent_reply_basis: "v1" });
      expect(await waiting).toBe("v1");
      mock.joinReceivers.get("ok")?.({}); expect(await link.waitForReplyBasisMode()).toBe("legacy");
      expect(modes).toEqual(["v1", "legacy"]);
    } finally { link.close(); }
  });
  it("cancels a pending negotiation without authorizing a send", async () => {
    const link = new ServerLink("ws://test", "self", { personaId: "p", interAgentReplyBasis: "v1" });
    try { const abort = new AbortController(); const waiting = link.waitForReplyBasisMode(abort.signal); abort.abort(); expect(await waiting).toBe("pending"); }
    finally { link.close(); }
  });
});

describe("delivery ACK reconnect through production ServerLink", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.lastPush = null;
    mock.pushes = [];
    mock.joinReceivers.clear();
    mock.connected = true;
    mock.channelState = "joined";
    mock.onClose = null;
  });

  function setup({ identity = true } = {}) {
    let link!: ServerLink;
    const envelope = {
      version: "0", agent_id: "a.agent", persona: { id: "p", name: "P", sprite_set: "p" },
      display_name: "P", ts: "T", type: "inter_agent_message", state: "idle",
      payload: { to: "self", conversation_id: "cid", turn_number: 1, kind: "inform", body: "hi" },
      delivery_seq: 1,
    } as unknown as Envelope;
    let turnEnvelopes = [envelope];
    const delivered: Envelope[] = [];
    const runtime = createDeliveryAcknowledgementRuntime(
      seq => link.acknowledgeInterAgentDelivery(seq),
      { deliverySequencesForTurn: () => [1], deliveryEnvelopesForTurn: () => turnEnvelopes },
      // Antigravity builds its runtime without this callback.
      identity
        ? () => {
          const incarnation = link?.deliveryIncarnation() ?? null;
          return incarnation === null ? null : { incarnation, generation: link.deliveryGeneration() };
        }
        : undefined,
    );
    const options: ServerLinkOptions = runtime.withServerLinkOptions({
      personaId: "p",
      onInterAgentMessage: (received: Envelope) => {
        delivered.push(received);
        runtime.captureDelivery(received);
      },
    });
    link = new ServerLink("ws://x/wrapper", "a.agent", options);
    const joined = (incarnation: string, issuedSeq = 1) => {
      mock.connected = true;
      mock.channelState = "joined";
      mock.joinReceivers.get("ok")?.({
        delivery_resync: "skip-v1",
        inter_agent_delivery_incarnation: incarnation,
        delivery: {
          issued_seq: issuedSeq,
          acked_seq: 0,
          lost_count: 0,
          ...(issuedSeq === 0 ? {} : { pending_since: "T" }),
        },
      });
    };
    const disconnect = () => {
      mock.connected = false;
      mock.channelState = "closed";
      mock.onClose?.({ code: 1006 });
    };
    const joinedWith = (incarnation: string | null, delivery: Record<string, unknown>) => {
      mock.connected = true;
      mock.channelState = "joined";
      mock.joinReceivers.get("ok")?.({
        delivery_resync: "skip-v1",
        ...(incarnation === null ? {} : { inter_agent_delivery_incarnation: incarnation }),
        delivery: { lost_count: 0, ...delivery },
      });
    };
    const setTurnEnvelopes = (envelopes: Envelope[]) => {
      turnEnvelopes = envelopes;
    };
    const withSeq = (seq: number) => ({ ...envelope, delivery_seq: seq }) as unknown as Envelope;
    return { delivered, disconnect, envelope, joined, joinedWith, link, runtime, setTurnEnvelopes, withSeq };
  }

  it("replays the completed turn watermark after same-identity socket rejoin", async () => {
    const { disconnect, envelope, joined, link, runtime } = setup();
    try {
      joined("same", 0);
      expect(link.deliveryIncarnation()).toBe("same");
      emit("envelope", envelope);
      disconnect();
      expect(link.deliveryIncarnation()).toBeNull();
      runtime.withHostOptions({}).onTurnStart({ turnToken: "turn" });
      expect(mock.pushes.filter(push => push.event === "delivery_ack")).toEqual([]);

      joined("same");
      await Promise.resolve();
      expect(mock.pushes.filter(push => push.event === "delivery_ack").map(push => push.payload))
        .toEqual([expect.objectContaining({ delivery_seq: 1 })]);
    } finally {
      link.close();
    }
  });

  it("does not replay a pending old-identity watermark after replacement join", async () => {
    const { disconnect, envelope, joined, link, runtime } = setup();
    try {
      joined("old", 0);
      emit("envelope", envelope);
      disconnect();
      runtime.withHostOptions({}).onTurnStart({ turnToken: "turn" });

      joined("new");
      await Promise.resolve();
      expect(mock.pushes.filter(push => push.event === "delivery_ack")).toEqual([]);
    } finally {
      link.close();
    }
  });

  const ackedSeqs = (): unknown[] => mock.pushes
    .filter(push => push.event === "delivery_ack")
    .map(push => (push.payload as { delivery_seq: unknown }).delivery_seq);

  it("sends the outstanding watermark once per join across repeated same-identity rejoins", async () => {
    const { disconnect, envelope, joined, link, runtime } = setup();
    try {
      joined("same", 0);
      emit("envelope", envelope);
      disconnect();
      runtime.withHostOptions({}).onTurnStart({ turnToken: "turn" });
      joined("same");
      await Promise.resolve();
      expect(ackedSeqs()).toEqual([1]);

      // The server has not acknowledged that push when the socket drops again.
      mock.pushes = [];
      disconnect();
      joined("same");
      await Promise.resolve();
      expect(ackedSeqs()).toEqual([1]);
    } finally {
      link.close();
    }
  });

  it("sends one watermark when a rejoin baseline closes an out-of-order gap", async () => {
    const { disconnect, envelope, joined, link, runtime } = setup();
    try {
      joined("same", 0);
      (envelope as unknown as { delivery_seq: number }).delivery_seq = 2;
      emit("envelope", envelope);
      disconnect();
      runtime.withHostOptions({}).onTurnStart({ turnToken: "turn" });
      expect(ackedSeqs()).toEqual([]);

      mock.connected = true;
      mock.channelState = "joined";
      mock.joinReceivers.get("ok")?.({
        delivery_resync: "skip-v1",
        inter_agent_delivery_incarnation: "same",
        delivery: { issued_seq: 2, acked_seq: 1, lost_count: 0, pending_since: "T" },
      });
      await Promise.resolve();
      expect(ackedSeqs()).toEqual([2]);
    } finally {
      link.close();
    }
  });

  it("resends the watermark after a channel-only rejoin on an open socket", async () => {
    const { envelope, joined, link, runtime } = setup();
    try {
      joined("same", 0);
      emit("envelope", envelope);
      runtime.withHostOptions({}).onTurnStart({ turnToken: "turn" });
      expect(ackedSeqs()).toEqual([1]);

      // The channel errors and rejoins; the socket never closes.
      mock.pushes = [];
      emit("phx_error", {});
      joined("same");
      await Promise.resolve();
      expect(ackedSeqs()).toEqual([1]);
    } finally {
      link.close();
    }
  });

  it("starts a fresh sequence space when the rejoin reports a new incarnation", async () => {
    const { delivered, disconnect, envelope, joinedWith, link, runtime, setTurnEnvelopes, withSeq } = setup();
    try {
      joinedWith("old", { issued_seq: 2, acked_seq: 2 });
      (envelope as unknown as { delivery_seq: number }).delivery_seq = 3;
      emit("envelope", envelope);
      runtime.withHostOptions({}).onTurnStart({ turnToken: "old-turn" });
      expect(ackedSeqs()).toEqual([3]);

      // The server lost its ledger entry and restarted the sequence space.
      mock.pushes = [];
      disconnect();
      joinedWith("new", { issued_seq: 0, acked_seq: 0 });
      await Promise.resolve();
      expect(ackedSeqs()).toEqual([]);

      const fresh = withSeq(1);
      emit("envelope", fresh);
      expect(delivered.at(-1)).toBe(fresh);
      setTurnEnvelopes([fresh]);
      runtime.withHostOptions({}).onTurnStart({ turnToken: "new-turn" });
      expect(ackedSeqs()).toEqual([1]);
    } finally {
      link.close();
    }
  });

  it("keeps the received ledger across a same-incarnation rejoin", () => {
    const { delivered, disconnect, joinedWith, link, withSeq } = setup();
    try {
      joinedWith("same", { issued_seq: 0, acked_seq: 0 });
      emit("envelope", withSeq(1));
      expect(delivered).toHaveLength(1);

      disconnect();
      joinedWith("same", { issued_seq: 1, acked_seq: 0, pending_since: "T" });
      // A replaced ledger would request seq 1, received but not yet
      // dispatched, as missing.
      expect(mock.pushes.filter(push => push.event === "delivery_resync")).toEqual([]);
      emit("envelope", withSeq(1));
      expect(delivered).toHaveLength(1);
    } finally {
      link.close();
    }
  });

  it("keeps the ledger across a join that reports no incarnation", () => {
    const { delivered, disconnect, joinedWith, link, withSeq } = setup();
    try {
      joinedWith("old", { issued_seq: 0, acked_seq: 0 });
      emit("envelope", withSeq(1));
      disconnect();
      joinedWith(null, { issued_seq: 1, acked_seq: 0, pending_since: "T" });
      disconnect();
      joinedWith("old", { issued_seq: 1, acked_seq: 0, pending_since: "T" });
      expect(mock.pushes.filter(push => push.event === "delivery_resync")).toEqual([]);
      emit("envelope", withSeq(1));
      expect(delivered).toHaveLength(1);
    } finally {
      link.close();
    }
  });

  it("does not resync the replaced ledger's gap into the new incarnation", async () => {
    vi.useFakeTimers();
    const { delivered, joinedWith, link, withSeq } = setup();
    try {
      joinedWith("old", { issued_seq: 1, acked_seq: 1 });
      emit("envelope", withSeq(3));
      expect(delivered).toHaveLength(1);

      // Channel-only rejoin: the socket stays open, so nothing calls
      // DeliveryRecovery.disconnected() on the old ledger's gap timer.
      emit("phx_error", {});
      joinedWith("new", { issued_seq: 0, acked_seq: 0 });
      mock.pushes = [];
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mock.pushes.filter(push => push.event === "delivery_resync")).toEqual([]);
    } finally {
      link.close();
      vi.useRealTimers();
    }
  });

  it("admits a join-time ACK when a new incarnation continues the sequence", () => {
    const { disconnect, envelope, joinedWith, link, runtime } = setup({ identity: false });
    try {
      joinedWith("old", { issued_seq: 2, acked_seq: 2 });
      (envelope as unknown as { delivery_seq: number }).delivery_seq = 4;
      emit("envelope", envelope);
      runtime.withHostOptions({}).onTurnStart({ turnToken: "turn" });
      expect(ackedSeqs()).toEqual([]);

      // The server re-minted its incarnation but kept the sequence; the join
      // baseline closes the gap and the status callback acknowledges 4.
      disconnect();
      joinedWith("new", { issued_seq: 4, acked_seq: 3, pending_since: "T" });
      expect(ackedSeqs()).toEqual([4]);
      expect(mock.pushes.filter(push => push.event === "delivery_resync")).toEqual([]);
    } finally {
      link.close();
    }
  });

  it("drops a watermark beyond every sequence the current ledger has seen", async () => {
    const { delivered, disconnect, envelope, joinedWith, link, runtime, withSeq } = setup({ identity: false });
    try {
      joinedWith("old", { issued_seq: 2, acked_seq: 2 });
      (envelope as unknown as { delivery_seq: number }).delivery_seq = 3;
      emit("envelope", envelope);

      // An old-space input reaches its turn only after the new join. With no
      // identity callback the acknowledgement ledger cannot tell it is stale.
      disconnect();
      joinedWith("new", { issued_seq: 0, acked_seq: 0 });
      await Promise.resolve();
      mock.pushes = [];
      runtime.withHostOptions({}).onTurnStart({ turnToken: "late-old-turn" });
      expect(ackedSeqs()).toEqual([]);

      const fresh = withSeq(1);
      emit("envelope", fresh);
      expect(delivered.at(-1)).toBe(fresh);
    } finally {
      link.close();
    }
  });
});

describe("ServerLink — inter-agent queue join (credit-v1)", () => {
  const policy = { batch_max_items: 10, backlog_max_items: 100, backlog_max_bytes: 524_288 };

  beforeEach(() => {
    mock.handlers.clear();
    mock.lastPush = null;
    mock.pushes = [];
    mock.joinReceivers.clear();
    mock.channelState = "joined";
    mock.onClose = null;
    mock.lastChannelParams = null;
  });

  function link(declare = true) {
    const refused = vi.fn();
    const hydration = vi.fn();
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      ...(declare ? { interAgentQueuePolicy: policy } : {}),
      onInterAgentQueueRefused: refused,
      onHydration: hydration,
    });
    return { refused, hydration };
  }

  it("declares the queue and its policy in the join params", () => {
    link();
    expect(mock.lastChannelParams).toMatchObject({
      inter_agent_queue: "credit-v1",
      inter_agent_queue_policy: policy,
    });
  });

  it("declares nothing when no policy is given", () => {
    link(false);
    expect(mock.lastChannelParams).not.toHaveProperty("inter_agent_queue");
    expect(mock.lastChannelParams).not.toHaveProperty("inter_agent_queue_policy");
  });

  it.each([
    { reason: "invalid_queue_policy", field: "backlog_max_bytes", detail: "above_ceiling", limit: 16_384 },
    { reason: "queue_capability_required", missing: ["delivery_resync"] },
  ])("treats the join refusal $reason as terminal", (reason) => {
    const { refused } = link();
    mock.joinReceivers.get("error")!(reason);
    expect(refused).toHaveBeenCalledOnce();
    expect(refused).toHaveBeenCalledWith(reason);
  });

  it("leaves other join errors to the client's own retry", () => {
    const { refused } = link();
    mock.joinReceivers.get("error")!({ reason: "unknown_persona" });
    expect(refused).not.toHaveBeenCalled();
  });

  it("does not proceed when the join reply lacks the queue echo", () => {
    const { refused, hydration } = link();
    mock.joinReceivers.get("ok")!({ delivery_resync: "skip-v1" });
    expect(refused).toHaveBeenCalledWith({ reason: "queue_not_acknowledged" });
    expect(hydration).not.toHaveBeenCalled();
  });

  it("proceeds when the join reply echoes the queue", () => {
    const { refused, hydration } = link();
    mock.joinReceivers.get("ok")!({
      inter_agent_queue: "credit-v1",
      inter_agent_queue_policy: policy,
      inter_agent_queue_epoch: "epoch",
      inter_agent_queue_resume_required: false,
      inter_agent_delivery_incarnation: "inc-1",
    });
    expect(refused).not.toHaveBeenCalled();
    expect(hydration).toHaveBeenCalledOnce();
  });

  it("refuses an echo without a ledger incarnation to bind to", () => {
    const { refused, hydration } = link();
    mock.joinReceivers.get("ok")!({
      inter_agent_queue: "credit-v1",
      inter_agent_queue_policy: policy,
      inter_agent_queue_epoch: "epoch",
      inter_agent_queue_resume_required: false,
    });
    expect(refused).toHaveBeenCalledWith({ reason: "queue_not_acknowledged" });
    expect(hydration).not.toHaveBeenCalled();
  });

  it("routes delivery_batch to the queue lease and resumes when asked", async () => {
    const offers: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      interAgentQueuePolicy: policy,
      onQueueOffer: (offer) => offers.push(offer),
    });
    mock.joinReceivers.get("ok")!({
      inter_agent_queue: "credit-v1",
      inter_agent_queue_policy: policy,
      inter_agent_queue_epoch: "epoch",
      inter_agent_queue_resume_required: true,
      inter_agent_delivery_incarnation: "inc-1",
    });
    expect(mock.lastPush).toMatchObject({ event: "delivery_queue_control", payload: { op: "resume", version: "0" } });

    const generation = (mock.lastChannelParams as { delivery_generation: string }).delivery_generation;
    emit("delivery_batch", {
      version: "0", queue_epoch: "epoch", incarnation: "inc-1", generation, lease_id: "1",
      kind: "root", credit_revision: "1",
      items: [{ queue_id: "1", attempt_id: "1.1", delivery_seq: 1, class: "ordinary", byte_charge: 1,
        envelope: { type: "inter_agent_message" } }],
    });
    emit("delivery_batch", { version: "0", queue_epoch: "other" });
    expect(offers).toHaveLength(1);
  });

  it("feeds offered sequences to the receipt ledger, so they are never reported missing", async () => {
    vi.useFakeTimers();
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao", interAgentQueuePolicy: policy });
    try {
      mock.joinReceivers.get("ok")!({
        inter_agent_queue: "credit-v1",
        inter_agent_queue_policy: policy,
        inter_agent_queue_epoch: "epoch",
        inter_agent_queue_resume_required: false,
        inter_agent_delivery_incarnation: "inc-1",
        delivery_resync: "skip-v1",
        delivery: { issued_seq: 0, acked_seq: 0, pending_since: null },
      });
      const generation = (mock.lastChannelParams as { delivery_generation: string }).delivery_generation;
      emit("delivery_batch", {
        version: "0", queue_epoch: "epoch", incarnation: "inc-1", generation, lease_id: "1",
        kind: "root", credit_revision: "1",
        items: [{ queue_id: "1", attempt_id: "1.1", delivery_seq: 1, class: "ordinary", byte_charge: 1,
          envelope: { type: "inter_agent_message" } }],
      });
      emit("delivery_status", { version: "0", issued_seq: 2, acked_seq: 0, pending_since: "T" });
      await vi.advanceTimersByTimeAsync(30_000);
      const resyncs = mock.pushes.filter((push) => push.event === "delivery_resync");
      expect(resyncs.map((push) => (push.payload as { missing_ranges: unknown }).missing_ranges)).toEqual([[[2, 2]]]);
    } finally {
      link.close();
      vi.useRealTimers();
    }
  });

  it("logs a queue refusal that proves a wrapper bug to stderr", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const offers: QueueOffer[] = [];
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      interAgentQueuePolicy: policy,
      onQueueOffer: (offer) => offers.push(offer),
    });
    try {
      mock.joinReceivers.get("ok")!({
        inter_agent_queue: "credit-v1",
        inter_agent_queue_policy: policy,
        inter_agent_queue_epoch: "epoch",
        inter_agent_queue_resume_required: false,
        inter_agent_delivery_incarnation: "inc-1",
      });
      const generation = (mock.lastChannelParams as { delivery_generation: string }).delivery_generation;
      emit("delivery_batch", {
        version: "0", queue_epoch: "epoch", incarnation: "inc-1", generation, lease_id: "1",
        kind: "root", credit_revision: "1",
        items: [{ queue_id: "1", attempt_id: "1.1", delivery_seq: 1, class: "ordinary", byte_charge: 1,
          envelope: { type: "inter_agent_message" } }],
      });
      const settled = offers[0]!.dispose([{ queue_id: "1", outcome: "intentional_non_injection", reason: "stale_skip" }]);
      mock.lastPush!.receivers.get("error")!({ reason: "conflicting_disposition" });
      expect(await settled).toMatchObject({ ok: false });
      expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain("dispose refused");
    } finally {
      link.close();
      stderr.mockRestore();
    }
  });

  it("tells the engine after each join's reconciliation, with and without a resume", async () => {
    const rejoined = vi.fn();
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      interAgentQueuePolicy: policy,
      onQueueRejoined: rejoined,
    });
    const join = (resumeRequired: boolean) => mock.joinReceivers.get("ok")!({
      inter_agent_queue: "credit-v1",
      inter_agent_queue_policy: policy,
      inter_agent_queue_epoch: "epoch",
      inter_agent_queue_resume_required: resumeRequired,
      inter_agent_delivery_incarnation: "inc-1",
    });
    try {
      join(false);
      await link.queueReady();
      expect(rejoined).toHaveBeenCalledTimes(1);
      join(true);
      const resume = mock.lastPush!;
      expect(resume).toMatchObject({ event: "delivery_queue_control", payload: { op: "resume" } });
      await Promise.resolve();
      expect(rejoined).toHaveBeenCalledTimes(1);
      resume.receivers.get("ok")!({
        op: "resume", operation_id: (resume.payload as { operation_id: string }).operation_id,
        queue: { queued: 0, offered: 0, native_pending: 0, waiter: 0, control: 0, charged_bytes: 0, policy },
        leases: [], registrations: [],
      });
      await link.queueReady();
      expect(rejoined).toHaveBeenCalledTimes(2);
    } finally {
      link.close();
    }
  });

  it("declares inline recovery only with the queue, reply basis v1 and the option", () => {
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao", interAgentQueuePolicy: policy, interAgentReplyBasis: "v1", interAgentInlineRecovery: true,
    });
    expect(mock.lastChannelParams).toMatchObject({ inter_agent_inline_recovery: "v1" });
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao", interAgentQueuePolicy: policy, interAgentReplyBasis: "v1" });
    expect(mock.lastChannelParams).not.toHaveProperty("inter_agent_inline_recovery");
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao", interAgentReplyBasis: "v1", interAgentInlineRecovery: true });
    expect(mock.lastChannelParams).not.toHaveProperty("inter_agent_inline_recovery");
  });

  it("hands a stale_reply_basis refusal's queue_recovery to the lease and returns its offer", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao", interAgentQueuePolicy: policy });
    mock.joinReceivers.get("ok")!({
      inter_agent_queue: "credit-v1", inter_agent_queue_policy: policy, inter_agent_queue_epoch: "epoch",
      inter_agent_queue_resume_required: false, inter_agent_delivery_incarnation: "inc-1",
    });
    try {
      const pending = link.sendInterAgent({
        version: "0", agent_id: "a.agent", persona: { id: "ao", name: "ao", sprite_set: "ao" }, display_name: "ao",
        ts: "2026-10-04T00:00:00Z", type: "inter_agent_message", state: "idle",
        payload: { to: "b.agent", conversation_id: "cnv", turn_number: 2, kind: "response", body: "late", meta: { done: false, propose_next: "" } },
      } as unknown as Envelope);
      mock.lastPush?.receivers.get("error")?.({
        reason: "stale_reply_basis", conversation_id: "cnv", expected_peer_turn: 3, supplied_basis: 1,
        queue_recovery: { lease_id: "5", items: [{ queue_id: "q1", attempt_id: "q1.1", delivery_seq: 7, class: "ordinary", byte_charge: 1, envelope: { type: "inter_agent_message" } }] },
      });
      const acceptance = await pending;
      expect(acceptance).toMatchObject({ kind: "rejected", reason: "stale_reply_basis" });
      expect((acceptance as { queue_recovery?: QueueOffer }).queue_recovery).toMatchObject({ leaseId: "5", kind: "recovery" });
    } finally {
      link.close();
    }
  });

  it("needs no echo from a wrapper that declared no queue", () => {
    const { refused, hydration } = link(false);
    mock.joinReceivers.get("ok")!({});
    expect(refused).not.toHaveBeenCalled();
    expect(hydration).toHaveBeenCalledOnce();
  });
});
