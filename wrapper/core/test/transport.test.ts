import { beforeEach, describe, expect, it, vi } from "vitest";

// ServerLink wraps phoenix Socket/Channel; mock the module so the channel
// event handlers can be invoked directly. `handlers` captures every
// channel.on(event, cb) registration so a test can fire a synthetic push.
// `lastPush` exposes the most recent channel.push() so a test can drive
// its receive("ok") / receive("error") / receive("timeout") branches.
type PushReceivers = Map<string, (payload: unknown) => void>;
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  lastPush: null as { event: string; payload: unknown; receivers: Map<string, (payload: unknown) => void> } | null,
}));

vi.mock("phoenix", () => {
  class Channel {
    on(event: string, cb: (payload: unknown) => void): void {
      mock.handlers.set(event, cb);
    }
    join(): { receive: (...args: unknown[]) => unknown } {
      const chain = { receive: () => chain };
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
    channel(): Channel {
      return new Channel();
    }
    onOpen(): void {}
    disconnect(): void {}
  }
  return { Channel, Socket };
});

// transport.ts reads the global `WebSocket` as the phoenix transport; stub it
// so the constructor does not depend on the node version's global.
vi.stubGlobal("WebSocket", class {});

import { ServerLink } from "../src/transport.js";
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
  });

  it("first send は seq=1 を付与し ext を透過する", () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    link.send({
      version: "0", agent_id: "a.agent",
      persona: { id: "ao", name: "あお", sprite_set: "ao" },
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

describe("ServerLink — requestDirectory (protocol-inter-agent companion)", () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.lastPush = null;
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

    const directory = await pending;
    expect(directory).toEqual([
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
  });

  it("agents が無い reply でも空配列で resolve する", async () => {
    const link = new ServerLink("ws://x/wrapper", "a.agent", { personaId: "ao" });
    const pending = link.requestDirectory();
    mock.lastPush!.receivers.get("ok")!({});
    expect(await pending).toEqual([]);
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
