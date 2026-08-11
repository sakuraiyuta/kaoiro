import { beforeEach, describe, expect, it, vi } from "vitest";

// ServerLink wraps phoenix Socket/Channel; mock the module so the channel
// event handlers can be invoked directly. `handlers` captures every
// channel.on(event, cb) registration so a test can fire a synthetic push.
// `lastPush` exposes the most recent channel.push() so a test can drive
// its receive("ok") / receive("error") / receive("timeout") branches.
type PushReceivers = Map<string, (payload: unknown) => void>;
// `lastChannelParams` exposes the join params the channel was opened with,
// so a test can assert what rides the handshake (persona_id / transition_id).
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  lastPush: null as { event: string; payload: unknown; receivers: Map<string, (payload: unknown) => void> } | null,
  // Every push in order — `replay_ia` is chunked into several (M4), so a
  // test asserting the split cannot look at `lastPush` alone.
  pushes: [] as { event: string; payload: unknown }[],
  lastChannelParams: null as unknown,
  onOpen: null as (() => void) | null,
  // ADR-0051 D2: the hydration verdict rides the JOIN reply, so a test has
  // to be able to fire the join push's receive("ok") the way the phoenix
  // client does on every (re)join.
  joinReceivers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("phoenix", () => {
  class Channel {
    on(event: string, cb: (payload: unknown) => void): void {
      mock.handlers.set(event, cb);
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
    connect(): void {}
    channel(_topic: string, params?: unknown): Channel {
      mock.lastChannelParams = params;
      return new Channel();
    }
    onOpen(cb: () => void): void {
      mock.onOpen = cb;
    }
    disconnect(): void {}
  }
  return { Channel, Socket };
});

// transport.ts reads the global `WebSocket` as the phoenix transport; stub it
// so the constructor does not depend on the node version's global.
vi.stubGlobal("WebSocket", class {});

import {
  MAX_ACTIVE_TASK_CACHE_BYTES,
  MAX_ACTIVE_TASK_CACHE_ENTRIES,
  MAX_REPLAY_IA_PUSH_BYTES,
  ServerLink,
  chunkReplayIaItems,
  hydrationVerdictFrom,
} from "../src/transport.js";
import type { Envelope } from "@kaoiro/protocol";

function emit(event: string, payload: unknown): void {
  const handler = mock.handlers.get(event);
  if (!handler) throw new Error(`no handler registered for ${event}`);
  handler(payload);
}

describe("ServerLink — initial envelope sequence (#107)", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.lastPush = null;
    mock.pushes = [];
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

    expect(mock.lastChannelParams).toEqual({
      persona_id: "ao",
      transition_id: "tr-1",
    });
  });

  it("transitionId 未指定なら key ごと省略する", () => {
    new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });

    expect(mock.lastChannelParams).toEqual({ persona_id: "ao" });
  });

  it("空文字の transitionId も key ごと省略する", () => {
    // The server reads a blank transition_id as a mismatch, not as the
    // legacy absent case, so a blank must never reach the handshake.
    new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
      transitionId: "",
    });

    expect(mock.lastChannelParams).toEqual({ persona_id: "ao" });
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

  function push(): { link: ServerLink; pending: Promise<void> } {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
    });
    const pending = link.requestSessionReset("new", "理由");
    return { link, pending };
  }

  it("mode と reason を session_reset_request として送る", async () => {
    const { pending } = push();
    expect(mock.lastPush?.event).toBe("session_reset_request");
    expect(mock.lastPush?.payload).toEqual({ mode: "new", reason: "理由" });
    mock.lastPush!.receivers.get("ok")!({});
    await expect(pending).resolves.toBeUndefined();
  });

  it("reason 省略時は field ごと送らない", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", {
      personaId: "ao",
    });
    void link.requestSessionReset("clear").catch(() => {});
    expect(mock.lastPush?.payload).toEqual({ mode: "clear" });
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

  it("directory_request の reply から agents 配列を返す", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();

    expect(mock.lastPush?.event).toBe("directory_request");
    expect(mock.lastPush?.payload).toEqual({});

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
        // role が未知の値 (同上、将来の admin 等の passthrough は却下)
        { id: "6", kind: "user", display_name: "Bad4", role: "admin" },
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
