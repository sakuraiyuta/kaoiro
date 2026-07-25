// @vitest-environment jsdom
// Regression tests for issue #123 (macOS sleep resume auto-reconnect).
// Covers ふじ review must-fix 1/2 and the wake-guard boundary:
//   (a) close event が来ないケースでも新 Socket+Channel が完全再構築される
//   (b) reconnect 中の terminal disconnect 後に teardown cb が socket を復活させない
//   (c) visibility/online 近接連発で socket が複数化しない (直列化 guard)
//   (d) shouldForceReconnectOnVisible の 59_999 / 60_000 ms 境界
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted with the FakeSocket definitions so vi.mock's factory (hoisted
// to top-of-file) can reference them without the "cannot access before
// initialization" error. The `createdSockets` array is shared with the tests
// below so each test can reset and inspect it.
const { FakeSocket, createdSockets } = vi.hoisted(() => {
  class FakePush {
    receive(_status: string, _cb: (resp?: unknown) => void): FakePush {
      return this;
    }
  }

  class FakeChannel {
    joinCalled = 0;
    leaveCalled = 0;
    handlers: Record<string, ((p: unknown) => void)[]> = {};
    constructor(public topic: string) {}
    on(evt: string, cb: (p: unknown) => void): number {
      (this.handlers[evt] ??= []).push(cb);
      return this.handlers[evt].length;
    }
    join(): FakePush {
      this.joinCalled += 1;
      return new FakePush();
    }
    leave(): FakePush {
      this.leaveCalled += 1;
      return new FakePush();
    }
    push(_evt: string, _payload?: unknown): FakePush {
      return new FakePush();
    }
    fire(evt: string, payload: unknown): void {
      for (const cb of this.handlers[evt] ?? []) cb(payload);
    }
  }

  const created: FakeSocketInstance[] = [];

  interface FakeSocketInstance {
    channels: FakeChannel[];
    onOpenCallbacks: (() => void)[];
    onCloseCallbacks: (() => void)[];
    onErrorCallbacks: (() => void)[];
    connectCalled: number;
    disconnectCalled: number;
    onOpen(cb: () => void): void;
    onClose(cb: () => void): void;
    onError(cb: () => void): void;
    connect(): void;
    disconnect(cb?: () => void): void;
    fireClose(): void;
    channel(topic: string): FakeChannel;
  }

  class FakeSocket implements FakeSocketInstance {
    channels: FakeChannel[] = [];
    onOpenCallbacks: (() => void)[] = [];
    onCloseCallbacks: (() => void)[] = [];
    onErrorCallbacks: (() => void)[] = [];
    connectCalled = 0;
    disconnectCalled = 0;
    constructor(public url: string, public opts: unknown) {
      created.push(this);
    }
    onOpen(cb: () => void): void {
      this.onOpenCallbacks.push(cb);
    }
    onClose(cb: () => void): void {
      this.onCloseCallbacks.push(cb);
    }
    onError(cb: () => void): void {
      this.onErrorCallbacks.push(cb);
    }
    connect(): void {
      this.connectCalled += 1;
      for (const cb of this.onOpenCallbacks) cb();
    }
    disconnect(cb?: () => void): void {
      this.disconnectCalled += 1;
      if (cb !== undefined) setTimeout(cb, 1500);
      // Note: onClose is NOT fired here — the whole point of issue #123 is
      // the case where close events never arrive. Individual tests that want
      // to model a graceful close call `fireClose()` explicitly.
    }
    fireClose(): void {
      for (const cb of this.onCloseCallbacks) cb();
    }
    channel(topic: string): FakeChannel {
      const c = new FakeChannel(topic);
      this.channels.push(c);
      return c;
    }
  }

  return { FakeSocket, createdSockets: created };
});

vi.mock("phoenix", () => ({ Socket: FakeSocket }));

// Import AFTER vi.mock so connectKaoiro binds to FakeSocket.
import { connectKaoiro, shouldForceReconnectOnVisible } from "../src/lib/protocol";

function makeHandlers() {
  return {
    onStatus: vi.fn(),
    onSnapshot: vi.fn(),
    onEnvelope: vi.fn(),
    onHosts: vi.fn(),
  };
}

beforeEach(() => {
  createdSockets.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connectKaoiro reconnect (issue #123)", () => {
  it("(a) close event が来なくても新 Socket+Channel が完全再構築される", () => {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers);

    expect(createdSockets.length).toBe(1);
    const socket1 = createdSockets[0]!;
    expect(socket1.connectCalled).toBe(1);
    expect(socket1.channels.length).toBe(1);
    const channel1 = socket1.channels[0]!;
    expect(channel1.joinCalled).toBe(1);

    conn.reconnect();
    // 旧 channel は fire-and-forget leave 済 (dead transport でも block しない)
    expect(channel1.leaveCalled).toBe(1);
    // teardown cb 発火前は socket はまだ1つ
    expect(createdSockets.length).toBe(1);

    // Phoenix teardown 相当の 1500 ms を進める。fireClose は呼ばない
    // (close event が届かないケースを模擬)。
    vi.advanceTimersByTime(1500);

    // 新 socket / 新 channel が丸ごと作られる (implicit rejoin 依存を廃止)
    expect(createdSockets.length).toBe(2);
    const socket2 = createdSockets[1]!;
    expect(socket2.connectCalled).toBe(1);
    expect(socket2.channels.length).toBe(1);
    const channel2 = socket2.channels[0]!;
    expect(channel2.joinCalled).toBe(1);

    // snapshot handler が新 channel に登録されており live 経路が生きている
    channel2.fire("snapshot", { agents: {} });
    expect(handlers.onSnapshot).toHaveBeenCalledTimes(1);
  });

  it("(b) reconnect 中の disconnect 後に teardown cb が socket を復活させない", () => {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers);
    expect(createdSockets.length).toBe(1);

    conn.reconnect();
    vi.advanceTimersByTime(700); // teardown 途中
    expect(createdSockets.length).toBe(1);

    conn.disconnect();
    // teardown timer 発火まで進める
    vi.advanceTimersByTime(1000);

    // disposed で早期 return するため新 socket は作られない
    expect(createdSockets.length).toBe(1);
  });

  it("(c) reconnect 連打でも cycle は 1 つだけ (直列化 guard)", () => {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers);
    expect(createdSockets.length).toBe(1);

    conn.reconnect();
    conn.reconnect(); // cycleInFlight で no-op
    conn.reconnect(); // no-op
    conn.reconnect(); // no-op

    const socket1 = createdSockets[0]!;
    // disconnect が複数回呼ばれていないこと
    expect(socket1.disconnectCalled).toBe(1);

    vi.advanceTimersByTime(1500);
    // 新 socket は 1 つだけ
    expect(createdSockets.length).toBe(2);
  });

  it("(c') teardown 完了後の reconnect は再び走る (guard がリセットされる)", () => {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers);

    conn.reconnect();
    vi.advanceTimersByTime(1500);
    expect(createdSockets.length).toBe(2);

    conn.reconnect();
    vi.advanceTimersByTime(1500);
    expect(createdSockets.length).toBe(3);
  });

  it("disconnect 後の reconnect は no-op (terminal)", () => {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers);
    conn.disconnect();

    conn.reconnect();
    vi.advanceTimersByTime(1500);
    expect(createdSockets.length).toBe(1);
  });
});

describe("shouldForceReconnectOnVisible boundary (issue #123)", () => {
  it("(d) hiddenAt が null なら false (未 hidden で visible)", () => {
    expect(shouldForceReconnectOnVisible(null, 100_000)).toBe(false);
  });

  it("(d) 59_999 ms は false (閾値未満はタブ切替として無視)", () => {
    expect(shouldForceReconnectOnVisible(1_000, 60_999)).toBe(false);
  });

  it("(d) 60_000 ms は true (閾値ちょうどで force reconnect)", () => {
    expect(shouldForceReconnectOnVisible(1_000, 61_000)).toBe(true);
  });

  it("(d) 60_001 ms は true (閾値超え)", () => {
    expect(shouldForceReconnectOnVisible(1_000, 61_001)).toBe(true);
  });

  it("(d) threshold 引数で境界を上書きできる", () => {
    expect(shouldForceReconnectOnVisible(0, 30_000, 30_000)).toBe(true);
    expect(shouldForceReconnectOnVisible(0, 29_999, 30_000)).toBe(false);
  });
});
