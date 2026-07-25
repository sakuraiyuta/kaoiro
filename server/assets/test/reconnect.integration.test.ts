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

// open-then-stuck fake (ふじ round 3 must-fix 1): constructor で次 tick に
// onopen を発火し Phoenix の onConnOpen → resetHeartbeat を実際に arm する。
// その後 send / close event を返さない stuck 状態になるので、Phoenix 側は
// heartbeatIntervalMs × 2 (test では 200ms) で heartbeatTimeout 経路に落ち、
// 破棄した旧 Socket が clearHeartbeats されないと reconnectTimer.scheduleTimeout
// で自己復活してしまう (これが本 issue の実 macOS スリープ再現)。
// teardown() の waitForSocketClosed は readyState=CLOSED を polling するので
// close() で CLOSED にセットするだけで teardown callback は 150ms 後に発火する。
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
    // Fire onopen on the next tick so Phoenix's onConnOpen runs (which arms
    // resetHeartbeat/heartbeatTimer). vi.useFakeTimers means the caller must
    // advance timers to trigger it — advanceTimersByTimeAsync(1) suffices.
    setTimeout(() => {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    this.sentFrames.push(data);
    // stuck: heartbeat push を含めて何も応答しない。
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

describe("connectKaoiro reconnect against real Phoenix (issue #123 round 3+4)", () => {
  it("(A) reconnect() 後、open-then-stuck transport の heartbeatTimeout でも 3 本目 transport が生えない", async () => {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers, {
      // 案 A: Socket は 1 instance のまま cycle される。
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    // 初回 transport 生成。onopen は次 tick に発火 (round 4 must-fix 1)。
    expect(FakeWebSocket.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    // Phoenix onConnOpen → resetHeartbeat が arm 済。

    conn.reconnect();
    // teardown は FakeWebSocket.close で readyState=CLOSED になった時点で
    // waitForSocketClosed が即 callback → cb 内で drain + subscribeChannel
    // + socket.connect() が同期実行。新 transport 生成もこの tick で行われる。
    // 次 tick で新 transport の onopen が発火するので 1ms 進める。
    await vi.advanceTimersByTimeAsync(1);

    // 2 本目 transport (WS 張り直し) が生成される。案 A の期待挙動。
    expect(FakeWebSocket.instances.length).toBe(2);

    // ここから 199ms 進めて heartbeat cycle 前 window で 3 本目が生えて
    // いないことを assert (旧 socket 由来の残余 chain がない pin)。
    // heartbeatIntervalMs=100 の 2 回検知 (~200ms) に達すると Phoenix 標準
    // self-healing で新 transport が更に生えるので、そのスコープ外を狙う。
    await vi.advanceTimersByTimeAsync(199);
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
    await vi.advanceTimersByTimeAsync(1); // open trigger

    conn.disconnect();
    // teardown + heartbeat 2 回検知 window を過ぎさせる。drainPhoenixTimers
    // で timer 停止済み + disposed guard で cb は no-op。2 本目は生えない。
    await vi.advanceTimersByTimeAsync(2000);

    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("(A') reconnect() 連打 (同一 tick) でも cycle は 1 つだけ (cycleInFlight guard)", async () => {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers, {
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    expect(FakeWebSocket.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // open trigger

    conn.reconnect();
    conn.reconnect(); // guard で no-op
    conn.reconnect(); // no-op

    // 新 transport 生成後の onopen 発火だけ進める (heartbeat cycle 前 window)。
    await vi.advanceTimersByTimeAsync(1);
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
    await vi.advanceTimersByTimeAsync(1);

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1); // teardown 同期完了 + 新 open
    expect(FakeWebSocket.instances.length).toBe(2);

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);
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
    await vi.advanceTimersByTimeAsync(1);
    conn.disconnect();

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("(D) invert-test: clearHeartbeats を no-op 化すると heartbeatTimeout 経由で 3 本目以降 transport が生える (drain 実効性 pin)", async () => {
    // ふじ round 3 must-fix 1 (round 4 対応): drain 実装をうっかり削っても
    // 前 test 群が緑のまま通ってしまう構造的弱点を塞ぐ。Socket.prototype の
    // clearHeartbeats を monkeypatch で no-op 化し、Phoenix 内蔵の
    // heartbeatTimer が生き残るケースをシミュレート。この invert 状態では
    // 旧 socket の heartbeatTimeout → reconnectTimer.scheduleTimeout の
    // 自己復活経路が働き、3 本目以降の transport が生えることを assert。
    // drainPhoenixTimers の実装本体を消したりバイパスすると、この test が
    // 「3 本目が生える」を pin できず fail する — drain が実効していること
    // を間接 pin する。
    const proto = Socket.prototype as unknown as {
      clearHeartbeats: () => void;
    };
    const origClear = proto.clearHeartbeats;
    proto.clearHeartbeats = () => {
      // no-op: heartbeatTimer を clear しない
    };
    try {
      const handlers = makeHandlers();
      const conn = connectKaoiro("ws://test/client", handlers, {
        transport: FakeWebSocket as unknown,
        heartbeatIntervalMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1); // open trigger → heartbeat arm

      conn.reconnect();
      await vi.advanceTimersByTimeAsync(1); // teardown 同期 + 新 transport open
      expect(FakeWebSocket.instances.length).toBe(2);

      // heartbeatTimer が clear されていないため旧 arm が生き残り、Phoenix
      // の cycle と重なって transport が短時間で複数生成される。500ms までに
      // 3 本目以降が生えることを invert-test として pin (drain 実装が消えたら
      // この test が「3 本目が生えている」を pin できない = 実効性の regression
      // 検出)。
      await vi.advanceTimersByTimeAsync(500);
      expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(3);

      conn.disconnect();
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      proto.clearHeartbeats = origClear;
    }
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
