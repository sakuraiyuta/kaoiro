// @vitest-environment jsdom
// Regression tests for issue #123 round 3 (macOS sleep resume auto-reconnect).
// Runs against the REAL phoenix client — only the WebSocket transport is
// swapped for a stuck fake, and Phoenix's heartbeat interval is shortened
// so heartbeatTimeout paths fit in bounded wall-clock. ふじ再レビュー
// must-fix 1 のカバレッジ:
//   (A) reconnect() 後、stuck transport の heartbeatTimeout でも 3 本目
//       transport が生えない (旧 socket の自己復活防止)
//   (B) terminal disconnect() 後、heartbeat timeout でも 2 本目 transport が
//       生えない
//   (C) Phoenix Socket prototype に clearHeartbeats / reconnectTimer.reset
//       が存在する (Phoenix upgrade で消えたら loud fail)
// および must-fix 2 の wake lifecycle helper pin:
//   (a) online + disconnected → reconnect
//   (b) 短時間 hidden→visible + disconnected → reconnect
//   (c) 60_000ms hidden→visible + connected → force-reconnect
//   (境界) shouldForceReconnectOnVisible の 59_999 / 60_000 ms + null +
//   threshold 引数上書き
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Socket } from "phoenix";
import {
  connectKaoiro,
  decideWakeAction,
  shouldForceReconnectOnVisible,
} from "../src/lib/protocol";

// stuck fake: send は無視、close は readyState を CLOSED にするだけで
// close event を発火しない。Phoenix teardown() の waitForSocketClosed は
// 150 ms 毎に readyState を polling するので、advanceTimersByTimeAsync で
// 200ms ほど進めれば teardown callback は発火する。heartbeat 応答は決して
// 返さないので Phoenix 内部の heartbeatTimeout 経路を通ることになる。
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sentFrames: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    // Note: onclose is NOT invoked. issue #123 のシナリオは close event が
    // 届かない (stuck transport) ケースを模擬する。
  }
}

function makeHandlers() {
  return {
    onStatus: vi.fn(),
    onSnapshot: vi.fn(),
    onEnvelope: vi.fn(),
    onHosts: vi.fn(),
  };
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Phoenix Socket internal API existence (issue #123 round 3)", () => {
  it("(C) Socket prototype に clearHeartbeats / reconnectTimer.reset が存在する", () => {
    // ふじ条件: Phoenix 内部 API 直触りは silent に壊れず明示的に検知でき
    // るよう typeof チェックを test で pin する。Phoenix upgrade で消え
    // たらこの test が最初に落ちる。
    const s = new Socket("ws://dummy", {});
    const proto = s as unknown as {
      clearHeartbeats?: unknown;
      reconnectTimer?: { reset?: unknown };
    };
    expect(typeof proto.clearHeartbeats).toBe("function");
    expect(proto.reconnectTimer).toBeTruthy();
    expect(typeof proto.reconnectTimer?.reset).toBe("function");
  });
});

describe("connectKaoiro reconnect against real Phoenix (issue #123 round 3)", () => {
  it("(A) reconnect() 後、stuck transport の heartbeatTimeout でも 3 本目 transport が生えない", async () => {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers, {
      // 案 A: Socket は 1 instance のまま cycle される。
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    // 初回 transport が生成される
    expect(FakeWebSocket.instances.length).toBe(1);

    conn.reconnect();
    // Phoenix teardown() の waitForSocketClosed polling (150ms 起点) を
    // 通過させる。FakeWebSocket.close で readyState=CLOSED になるので
    // 次の polling tick で teardown callback が発火する。
    await vi.advanceTimersByTimeAsync(500);

    // 2 本目 transport (WS 張り直し) は生成される。ここは案 A の期待挙動。
    expect(FakeWebSocket.instances.length).toBe(2);

    // heartbeatIntervalMs=100 の 2 回検知 (200ms 相当) を超えて更に待つ。
    // 案 A の drainPhoenixTimers() が旧 socket の heartbeatTimer を clear
    // 済のため、heartbeatTimeout → reconnectTimer.scheduleTimeout は発火
    // せず、3 本目 transport は生えない (ふじ再レビュー must-fix 1)。
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances.length).toBe(2);

    conn.disconnect();
    await vi.advanceTimersByTimeAsync(500);
  });

  it("(B) terminal disconnect() 後、heartbeat timeout でも 2 本目 transport が生えない", async () => {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers, {
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    expect(FakeWebSocket.instances.length).toBe(1);

    conn.disconnect();
    // teardown + heartbeat 2 回検知 window を過ぎさせる。drainPhoenixTimers
    // で timer 停止済み + disposed guard で cb は no-op。2 本目は生えない。
    await vi.advanceTimersByTimeAsync(1500);

    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("(A') reconnect() 連打でも cycle は 1 つだけ (cycleInFlight guard)", async () => {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers, {
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    expect(FakeWebSocket.instances.length).toBe(1);

    conn.reconnect();
    conn.reconnect(); // guard で no-op
    conn.reconnect(); // no-op

    await vi.advanceTimersByTimeAsync(500);
    // 2 本目のみ生成される
    expect(FakeWebSocket.instances.length).toBe(2);

    conn.disconnect();
    await vi.advanceTimersByTimeAsync(500);
  });

  it("(A'') teardown 完了後の reconnect は再走 (guard がリセットされる)", async () => {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers, {
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances.length).toBe(2);

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances.length).toBe(3);

    conn.disconnect();
    await vi.advanceTimersByTimeAsync(500);
  });

  it("disconnect 後の reconnect は no-op (terminal)", async () => {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers, {
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    conn.disconnect();

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances.length).toBe(1);
  });
});

describe("decideWakeAction (issue #123 round 3, must-fix 2)", () => {
  it("(a) online + disconnected → reconnect", () => {
    expect(decideWakeAction("online", "disconnected", null, 0)).toBe("reconnect");
  });

  it("online + connected → noop (誤検知回避)", () => {
    expect(decideWakeAction("online", "connected", null, 0)).toBe("noop");
  });

  it("(b) 短時間 hidden→visible + disconnected → reconnect", () => {
    // hidden 500ms → visible 1000ms: gap=500ms<60000 なので force ではなく
    // 通常の disconnected 判定経路。
    expect(
      decideWakeAction("visibility-visible", "disconnected", 500, 1000),
    ).toBe("reconnect");
  });

  it("短時間 hidden→visible + connected → noop", () => {
    expect(
      decideWakeAction("visibility-visible", "connected", 500, 1000),
    ).toBe("noop");
  });

  it("(c) 60_000ms hidden→visible + connected → force-reconnect", () => {
    // heartbeat 途絶 (見かけ上 connected のまま WS が死んでいるケース) の
    // 救済経路。status に関わらず force reconnect。
    expect(decideWakeAction("visibility-visible", "connected", 0, 60_000)).toBe(
      "force-reconnect",
    );
  });

  it("60_000ms hidden→visible + disconnected → force-reconnect (閾値超え優先)", () => {
    expect(
      decideWakeAction("visibility-visible", "disconnected", 0, 60_000),
    ).toBe("force-reconnect");
  });

  it("visibility-hidden → record-hidden (status 問わず)", () => {
    expect(decideWakeAction("visibility-hidden", "connected", null, 0)).toBe(
      "record-hidden",
    );
    expect(
      decideWakeAction("visibility-hidden", "disconnected", 500, 1000),
    ).toBe("record-hidden");
  });
});

describe("shouldForceReconnectOnVisible boundary (issue #123)", () => {
  it("hiddenAt が null なら false (未 hidden で visible)", () => {
    expect(shouldForceReconnectOnVisible(null, 100_000)).toBe(false);
  });

  it("59_999 ms は false (閾値未満はタブ切替として無視)", () => {
    expect(shouldForceReconnectOnVisible(1_000, 60_999)).toBe(false);
  });

  it("60_000 ms は true (閾値ちょうどで force reconnect)", () => {
    expect(shouldForceReconnectOnVisible(1_000, 61_000)).toBe(true);
  });

  it("60_001 ms は true (閾値超え)", () => {
    expect(shouldForceReconnectOnVisible(1_000, 61_001)).toBe(true);
  });

  it("threshold 引数で境界を上書きできる", () => {
    expect(shouldForceReconnectOnVisible(0, 30_000, 30_000)).toBe(true);
    expect(shouldForceReconnectOnVisible(0, 29_999, 30_000)).toBe(false);
  });
});
