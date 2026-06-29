import { beforeEach, describe, expect, it, vi } from "vitest";

// ServerLink wraps phoenix Socket/Channel; mock the module so the channel
// event handlers can be invoked directly. `handlers` captures every
// channel.on(event, cb) registration so a test can fire a synthetic push.
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
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
    push(): void {}
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

function emit(event: string, payload: unknown): void {
  const handler = mock.handlers.get(event);
  if (!handler) throw new Error(`no handler registered for ${event}`);
  handler(payload);
}

describe("ServerLink — ファイルアップロード wire (ADR-0025)", () => {
  beforeEach(() => mock.handlers.clear());

  it("attach_open は payload を onAttachOpen に渡す", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
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
    new ServerLink("ws://x/wrapper", "a.agent", {
      onAttachOpen: (msg) => seen.push(msg),
    });
    emit("attach_open", { upload_id: "u1" }); // missing fields
    expect(seen).toEqual([]);
  });

  it("attach_chunk は ArrayBuffer をそのまま渡す", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      onAttachChunk: (p) => seen.push(p),
    });
    const buf = new ArrayBuffer(4);
    emit("attach_chunk", buf);
    expect(seen).toEqual([buf]);
  });

  it("attach_chunk は ArrayBufferView も透過する(Node ws)", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      onAttachChunk: (p) => seen.push(p),
    });
    const view = new Uint8Array([1, 2, 3]);
    emit("attach_chunk", view);
    expect(seen).toEqual([view]);
  });

  it("attach_chunk が JSON のときはドロップ", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      onAttachChunk: (p) => seen.push(p),
    });
    emit("attach_chunk", { not: "binary" });
    expect(seen).toEqual([]);
  });

  it("attach_close は upload_id を onAttachClose に渡す", () => {
    const seen: string[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      onAttachClose: (id) => seen.push(id),
    });
    emit("attach_close", { upload_id: "u1" });
    expect(seen).toEqual(["u1"]);
  });

  it("instruction の attachment_ids を onInstruction に渡す", () => {
    const seen: Array<{ text: string; ids?: string[] }> = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      onInstruction: (text, ids) =>
        seen.push(ids === undefined ? { text } : { text, ids }),
    });
    emit("instruction", { text: "見て", attachment_ids: ["u1", "u2"] });
    expect(seen).toEqual([{ text: "見て", ids: ["u1", "u2"] }]);
  });

  it("instruction の attachment_ids が空 / 非配列なら undefined", () => {
    const seen: Array<{ text: string; ids?: string[] }> = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
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
    new ServerLink("ws://x/wrapper", "a.agent", {
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
    new ServerLink("ws://x/wrapper", "a.agent", {
      onSetModel: (value) => seen.push(value),
    });
    emit("set_model", { model: "opus[1m]" });
    expect(seen).toEqual(["opus[1m]"]);
  });

  it("set_effort は payload.effort を onSetEffort へ渡す", () => {
    const seen: string[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
      onSetEffort: (level) => seen.push(level),
    });
    emit("set_effort", { effort: "max" });
    expect(seen).toEqual(["max"]);
  });

  it("誤フィールド / 非文字列の payload は無視する", () => {
    const model: string[] = [];
    const effort: string[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
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

describe("ServerLink — inter_agent_message inbound (protocol-inter-agent, phase-8)", () => {
  beforeEach(() => mock.handlers.clear());

  it("type=inter_agent_message の envelope を onInterAgentMessage に渡す", () => {
    const seen: unknown[] = [];
    new ServerLink("ws://x/wrapper", "a.agent", {
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
    new ServerLink("ws://x/wrapper", "a.agent", {
      onInterAgentMessage: (env) => seen.push(env),
    });
    emit("envelope", { type: "state_change", agent_id: "a.agent" });
    emit("envelope", "not a map");
    expect(seen).toEqual([]);
  });
});
