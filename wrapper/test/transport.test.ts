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
