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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  it("期限切れ ticket を明示 reconnect 前に更新し、新しい ticket で WS を張る", async () => {
    const handlers = makeHandlers();
    const refreshTicket = vi.fn().mockResolvedValue({
      kind: "ok" as const,
      ticket: "renewed-ticket",
    });
    const conn = connectKaoiro("ws://test/client", handlers, {
      ticket: "expired-ticket",
      refreshTicket,
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1); // WS 1 open

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);

    expect(refreshTicket).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(FakeWebSocket.instances[1]?.url).toContain("ticket=renewed-ticket");

    conn.disconnect();
    await vi.advanceTimersByTimeAsync(500);
  });

  it("Phoenix の heartbeat 自動再接続も stale ticket を使わない", async () => {
    const handlers = makeHandlers();
    const refreshTicket = vi.fn().mockResolvedValue({
      kind: "ok" as const,
      ticket: "native-retry-ticket",
    });
    const conn = connectKaoiro("ws://test/client", handlers, {
      ticket: "expired-ticket",
      refreshTicket,
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1); // WS 1 open

    // heartbeat timeout -> Phoenix reconnectTimer -> socket.connect() の
    // 経路。connect() を更新 gate しているので、ここも renewal 後まで
    // transportConnect されない。
    await vi.advanceTimersByTimeAsync(300);

    expect(refreshTicket).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(FakeWebSocket.instances[1]?.url).toContain(
      "ticket=native-retry-ticket",
    );

    conn.disconnect();
    await vi.advanceTimersByTimeAsync(500);
  });

  it("ticket 更新の 401 は session expiry を通知し、再接続を止める", async () => {
    const handlers = makeHandlers();
    const refreshTicket = vi.fn().mockResolvedValue({
      kind: "unauthorized" as const,
    });
    const onTicketRefreshUnauthorized = vi.fn();
    const conn = connectKaoiro("ws://test/client", handlers, {
      ticket: "expired-ticket",
      refreshTicket,
      onTicketRefreshUnauthorized,
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1); // WS 1 open

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);

    expect(refreshTicket).toHaveBeenCalledTimes(1);
    expect(onTicketRefreshUnauthorized).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.length).toBe(1);

    // terminal 化しているため、Phoenix の timer / 後続 wake reconnect で
    // stale ticket の追加試行が発生しない。
    conn.reconnect();
    await vi.advanceTimersByTimeAsync(2000);
    expect(refreshTicket).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("ticket 更新の一時的な通信失敗は stale ticket を送らずに再試行する", async () => {
    const handlers = makeHandlers();
    const refreshTicket = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        kind: "ok" as const,
        ticket: "retry-ticket",
      });
    const conn = connectKaoiro("ws://test/client", handlers, {
      ticket: "expired-ticket",
      refreshTicket,
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1); // WS 1 open

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTicket).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.length).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshTicket).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(FakeWebSocket.instances[1]?.url).toContain("ticket=retry-ticket");

    conn.disconnect();
    await vi.advanceTimersByTimeAsync(500);
  });

  it("hung ticket fetch は deadline 後に abort され、次の ticket fetch へ進む", async () => {
    const handlers = makeHandlers();
    let firstSignal: AbortSignal | undefined;
    const refreshTicket = vi
      .fn()
      // AbortSignal を無視して永久 pending する proxy / custom callback の
      // 再現。protocol 側の Promise.race が gate を開ける必要がある。
      .mockImplementationOnce((signal: AbortSignal) => {
        firstSignal = signal;
        return new Promise<never>(() => {});
      })
      .mockResolvedValueOnce({
        kind: "ok" as const,
        ticket: "after-timeout-ticket",
      });
    const conn = connectKaoiro("ws://test/client", handlers, {
      ticket: "expired-ticket",
      refreshTicket,
      ticketRefreshTimeoutMs: 100,
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1); // WS 1 open

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTicket).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.length).toBe(1);

    // deadline (100ms) -> retry first step (1000ms) -> fresh ticket -> WS 2.
    await vi.advanceTimersByTimeAsync(100);
    expect(firstSignal?.aborted).toBe(true);
    expect(FakeWebSocket.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshTicket).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(FakeWebSocket.instances[1]?.url).toContain(
      "ticket=after-timeout-ticket",
    );

    conn.disconnect();
    await vi.advanceTimersByTimeAsync(500);
  });

  it("ticket refresh の retry は 1s, 2s, 5s と指数 backoff する", async () => {
    const handlers = makeHandlers();
    const refreshTicket = vi.fn().mockRejectedValue(new Error("offline"));
    const conn = connectKaoiro("ws://test/client", handlers, {
      ticket: "expired-ticket",
      refreshTicket,
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1); // WS 1 open

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTicket).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(refreshTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshTicket).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshTicket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshTicket).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(2500);
    expect(refreshTicket).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2500);
    expect(refreshTicket).toHaveBeenCalledTimes(4);

    conn.disconnect();
    await vi.advanceTimersByTimeAsync(30_000);
  });

  it("browser online は待機中の ticket retry を即時再開し backoff を reset する", async () => {
    const handlers = makeHandlers();
    const refreshTicket = vi.fn().mockRejectedValue(new Error("offline"));
    const conn = connectKaoiro("ws://test/client", handlers, {
      ticket: "expired-ticket",
      refreshTicket,
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1); // WS 1 open

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTicket).toHaveBeenCalledTimes(1);

    conn.notifyOnline();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTicket).toHaveBeenCalledTimes(2);

    // online で reset 済みなので、次の retry は 2 秒ではなく先頭の 1 秒。
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshTicket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshTicket).toHaveBeenCalledTimes(3);

    conn.disconnect();
    await vi.advanceTimersByTimeAsync(30_000);
  });

  it("pending refresh 中の別 wake reconnect は旧 fetch を abort して 1 transport に収束する", async () => {
    const handlers = makeHandlers();
    const first = deferred<{ kind: "ok"; ticket: string }>();
    const second = deferred<{ kind: "ok"; ticket: string }>();
    const refreshTicket = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const conn = connectKaoiro("ws://test/client", handlers, {
      ticket: "expired-ticket",
      refreshTicket,
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1); // WS 1 open

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTicket).toHaveBeenCalledTimes(1);

    // online と visibility-visible のような別 wake task。先の mint は
    // generation 更新で abort され、finally が最新 generation のみを再開。
    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTicket).toHaveBeenCalledTimes(2);
    second.resolve({ kind: "ok", ticket: "wake-race-ticket" });
    await vi.advanceTimersByTimeAsync(1);

    expect(FakeWebSocket.instances.length).toBe(2);
    expect(FakeWebSocket.instances[1]?.url).toContain(
      "ticket=wake-race-ticket",
    );

    // Late completion of the aborted mint must not create WS 3.
    first.resolve({ kind: "ok", ticket: "stale-ticket" });
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances.length).toBe(2);

    conn.disconnect();
    await vi.advanceTimersByTimeAsync(500);
  });

  it("pending refresh と 401 が競合しても session expiry は一度だけ", async () => {
    const handlers = makeHandlers();
    const first = deferred<{ kind: "ok"; ticket: string }>();
    const refreshTicket = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ kind: "unauthorized" as const });
    const onTicketRefreshUnauthorized = vi.fn();
    const conn = connectKaoiro("ws://test/client", handlers, {
      ticket: "expired-ticket",
      refreshTicket,
      onTicketRefreshUnauthorized,
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1); // WS 1 open

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);
    conn.reconnect(); // abort first mint, then latest mint reports 401
    await vi.advanceTimersByTimeAsync(1);

    expect(refreshTicket).toHaveBeenCalledTimes(2);
    expect(onTicketRefreshUnauthorized).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.length).toBe(1);

    first.resolve({ kind: "ok", ticket: "late-ticket" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(onTicketRefreshUnauthorized).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("retry timer 待機中の terminal disconnect は ticket fetch を再開しない", async () => {
    const handlers = makeHandlers();
    const refreshTicket = vi.fn().mockRejectedValue(new Error("offline"));
    const conn = connectKaoiro("ws://test/client", handlers, {
      ticket: "expired-ticket",
      refreshTicket,
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1); // WS 1 open

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTicket).toHaveBeenCalledTimes(1);

    conn.disconnect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshTicket).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("Phoenix heartbeat 自動再接続での ticket 401 も terminal にする", async () => {
    const handlers = makeHandlers();
    const refreshTicket = vi
      .fn()
      .mockResolvedValue({ kind: "unauthorized" as const });
    const onTicketRefreshUnauthorized = vi.fn();
    const conn = connectKaoiro("ws://test/client", handlers, {
      ticket: "expired-ticket",
      refreshTicket,
      onTicketRefreshUnauthorized,
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1); // WS 1 open

    await vi.advanceTimersByTimeAsync(300);

    expect(refreshTicket).toHaveBeenCalledTimes(1);
    expect(onTicketRefreshUnauthorized).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.length).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshTicket).toHaveBeenCalledTimes(1);
  });

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

  it("(E1) delayed teardown chain: terminal disconnect() 後も transport は増えない (round 6)", async () => {
    // レビュー probe pin (round 6 must-fix): heartbeatTimeout → teardown(cb=
    // scheduleTimeout) の cb が 2000ms 遅れて発火する状況を模擬する。post-drain
    // より後に scheduleTimeout が armed されるため time-dependent な drain だけ
    // では塞げず、round 5 (aaa50cb) 実測では transportsCreated:3 が観測された。
    // round 6 の構造ガード (disposed || cycleGeneration !== allowedScheduleGen)
    // が scheduleTimeout を無効化することを pin する。
    const teardownProto = Socket.prototype as unknown as {
      teardown: (cb: () => void, code?: number, reason?: string) => void;
    };
    const originalTeardown = teardownProto.teardown;
    teardownProto.teardown = function (
      this: Socket,
      callback: () => void,
      code?: number,
      reason?: string,
    ) {
      return originalTeardown.call(
        this,
        () => setTimeout(callback, 2000),
        code,
        reason,
      );
    };
    try {
      const handlers = makeHandlers();
      const conn = connectKaoiro("ws://test/client", handlers, {
        transport: FakeWebSocket as unknown,
        heartbeatIntervalMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1); // WS 1 onopen
      expect(FakeWebSocket.instances.length).toBe(1);

      // heartbeat push (t≈101) → 未返信 timeout → teardown (t≈201) が
      // 進行中の 2000ms 遅延 cb 待ちに入る。その間 (t=249) に terminal
      // disconnect() を投げる。
      await vi.advanceTimersByTimeAsync(248);
      conn.disconnect();

      // Phoenix 標準 backoff (最大 ~5s) を丸ごとまたいでも scheduleTimeout は
      // disposed で block され新 transport が生えないこと。
      await vi.advanceTimersByTimeAsync(5000);
      expect(FakeWebSocket.instances.length).toBe(1);
    } finally {
      teardownProto.teardown = originalTeardown;
    }
  });

  it("(E2) delayed teardown chain: reconnect() 後は正規 rebuild の 1 本以外 transport は増えない (round 6)", async () => {
    // レビュー probe pin (round 6 must-fix): reconnect() の pre-drain 後に
    // 旧 teardown chain の scheduleTimeout が発火する状況の pin。
    // allowedScheduleGen が rebuild cb 内で cycleGeneration に再 baseline
    // されるまで、旧 chain 由来の scheduleTimeout は cycleGeneration mismatch
    // で block される。rebuild cb 後は新 socket の Phoenix 通常 self-healing
    // は許可される (テストでは WS 2 の heartbeat cycle が回る前に terminal
    // disconnect で締める)。
    const teardownProto = Socket.prototype as unknown as {
      teardown: (cb: () => void, code?: number, reason?: string) => void;
    };
    const originalTeardown = teardownProto.teardown;
    teardownProto.teardown = function (
      this: Socket,
      callback: () => void,
      code?: number,
      reason?: string,
    ) {
      return originalTeardown.call(
        this,
        () => setTimeout(callback, 2000),
        code,
        reason,
      );
    };
    try {
      const handlers = makeHandlers();
      const conn = connectKaoiro("ws://test/client", handlers, {
        transport: FakeWebSocket as unknown,
        heartbeatIntervalMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances.length).toBe(1);

      await vi.advanceTimersByTimeAsync(248);
      conn.reconnect();

      // 進行 timeline (heartbeatIntervalMs=100):
      //   t=2201ms: 旧 teardown cb → scheduleTimeout — 構造ガードで block
      //   t=2249ms: reconnect cb → subscribeChannel + socket.connect() で WS 2
      //   t=2349ms: WS 2 heartbeat push (未返信)
      //   t=2449ms: WS 2 heartbeat timeout → teardown 開始 (cb は t=4449)
      // WS 2 の Phoenix 標準 self-healing (scope 外) が発火するより前、
      // かつ旧 chain 由来の余分 transport が生まれる window を跨いで
      // assertion を打つ。
      await vi.advanceTimersByTimeAsync(2300);
      expect(FakeWebSocket.instances.length).toBe(2);

      // WS 2 の heartbeat self-healing (t=4449 の scheduleTimeout) が発火
      // する前に terminal disconnect で確定 stop し、以降 disposed により
      // scheduleTimeout が永続 no-op になり transport が生えないこと。
      conn.disconnect();
      await vi.advanceTimersByTimeAsync(5000);
      expect(FakeWebSocket.instances.length).toBe(2);
    } finally {
      teardownProto.teardown = originalTeardown;
    }
  });

  it("(E3) stale heartbeat teardown chain が reconnect() の re-baseline を跨いで発火しても transport は増えない (round 7)", async () => {
    // レビュー probe pin (round 7 must-fix): 発火時の live 比較だけでは
    // 「完走した reconnect() が baseline を戻した後に、旧世代 chain の
    // scheduleTimeout が発火する」ケースを区別できない。arm-time
    // provenance (teardown 呼び出し時点の cycleGeneration を closure
    // capture) が chain 出自で block することを pin。
    //
    // Phoenix teardown の reason で 2 chain の遅延を独立制御:
    //   reason="heartbeat timeout" → 6000ms 遅延 (stuck transport の chain)
    //   それ以外                    → 遅延なし (reconnect() 側の chain)
    // これにより stuck chain の完了と reconnect の rebuild を時間的に分離
    // できる。前実装 (fedbb9f, round 6) ではこの scenario で transports が
    // 3 本に膨らむ (レビュー実測)。
    const teardownProto = Socket.prototype as unknown as {
      teardown: (cb: () => void, code?: number, reason?: string) => void;
    };
    const originalTeardown = teardownProto.teardown;
    teardownProto.teardown = function (
      this: Socket,
      callback: () => void,
      code?: number,
      reason?: string,
    ) {
      const delayMs = reason === "heartbeat timeout" ? 6000 : 0;
      return originalTeardown.call(
        this,
        delayMs > 0 ? () => setTimeout(callback, delayMs) : callback,
        code,
        reason,
      );
    };
    try {
      const handlers = makeHandlers();
      const conn = connectKaoiro("ws://test/client", handlers, {
        transport: FakeWebSocket as unknown,
        heartbeatIntervalMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1); // WS 1 onopen
      expect(FakeWebSocket.instances.length).toBe(1);

      // heartbeat push t=101 → timeout t=201 → teardown(reason="heartbeat
      // timeout") → 6000ms 遅延 → 旧 chain の scheduleTimeoutFn 発火予定
      // が t≈6201。t=300 で reconnect() を投げる: reason=undefined の
      // teardown は遅延なし → 即 cbR → rebuild → WS 2 が生える。
      // rebuild 後の WS 2 の自 heartbeat cycle は
      //   push t=400 → timeout t=500 → teardown(heartbeat, 6000ms 遅延)
      //   → 正規 self-heal scheduleTimeoutFn は t≈6500 →
      //   Timer(10ms 後) t≈6510 で WS 3 生成 — これは round 7 で許容される
      //   Phoenix 標準経路 (F test で pin)。
      await vi.advanceTimersByTimeAsync(299);
      conn.reconnect();

      // t=6400 で assertion: 旧 chain の scheduleTimeoutFn (t≈6201) 発火
      // 後 かつ 正規 self-heal (t≈6510) 発火前の window。
      //   round 7 (arm-time guard): 旧 chain の cb は teardownGen(0) !==
      //     cycleGeneration(1) で skip → transports=2 (WS 1 + WS 2 のみ)
      //   round 6 (fire-time compare): allowedScheduleGen が rebuild cb で
      //     1 に再 baseline されるため、t=6201 の scheduleTimeoutFn 素通り
      //     → Timer(10ms) → t=6211 で connect() → transports=3
      // ここで disconnect() を挟むと disposed=true で救われて round 6 の
      // bug が masked されるため、assertion 前には呼ばない。
      await vi.advanceTimersByTimeAsync(6100); // t=6400
      expect(FakeWebSocket.instances.length).toBe(2);

      // Cleanup: 以降の WS 2 正規 self-heal / 累積 heartbeat cycle を止める
      // (transport 数の後続断定は F test の責務、この test は round 7 の
      // arm-time guard そのものを pin する)。
      conn.disconnect();
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      teardownProto.teardown = originalTeardown;
    }
  });

  it("(F) reconnect()/disconnect() を呼ばない通常経路: Phoenix 標準 self-heal で transport が再生成される (round 7)", async () => {
    // レビュー probe pin (round 7 must-fix): round 6/7 の構造ガードが
    // 「本番の主要フォールバック経路 = Phoenix 標準 self-heal」を塞いで
    // いないことを常設 pin。reconnect() も disconnect() も呼ばず、単に
    // stuck transport の heartbeatTimeout → teardown → scheduleTimeout
    // → connect() が走って WS 2 が生えることを確認する。arm-time guard
    // (teardownGen === cycleGeneration) と disposed 未セットの条件が
    // どちらも満たされるので正規経路は通る。
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers, {
      transport: FakeWebSocket as unknown,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1); // WS 1 onopen
    expect(FakeWebSocket.instances.length).toBe(1);

    // Phoenix 標準タイムライン (heartbeatIntervalMs=100,
    // socketWaitTimeoutMs=0 相当, timerCalc(1)=10):
    //   t=101: heartbeat push (未返信)
    //   t=201: heartbeat timeout → teardown(reason="heartbeat timeout")
    //   t=201+ε: waitForSocketClosed → scheduleTimeoutFn
    //   t=~211: Timer callback → teardown → connect() → WS 2 生成
    await vi.advanceTimersByTimeAsync(300); // t=301
    expect(FakeWebSocket.instances.length).toBe(2);

    // WS 2 も同じ stuck 挙動なので次の self-heal cycle が更に fire する
    // より前に確定 stop。
    conn.disconnect();
    await vi.advanceTimersByTimeAsync(2000);
  });

  it("(D) reconnect() / disconnect() が Socket.prototype.clearHeartbeats を実際に呼ぶ (drain call-site pin)", async () => {
    // ふじ round 4 レビュー must-fix 2: 前 D 実装は自前 monkeypatch で
    // production の drainPhoenixTimers 経路と切断されていた (drain 実装を
    // no-op 化しても pass する false-positive)。spy に置き換え、
    // production の reconnect() / disconnect() が実際に Socket.prototype の
    // clearHeartbeats を呼ぶことを直接 pin する。drainPhoenixTimers 実装が
    // 消えたり clearHeartbeats を呼ばなくなればこの test が fail する
    // (drain call-site の regression 検出)。
    const spy = vi.spyOn(
      Socket.prototype as unknown as { clearHeartbeats: () => void },
      "clearHeartbeats",
    );
    try {
      const handlers = makeHandlers();
      const conn = connectKaoiro("ws://test/client", handlers, {
        transport: FakeWebSocket as unknown,
        heartbeatIntervalMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1);
      // initial connect 中に Phoenix 自身が resetHeartbeat 経由で
      // clearHeartbeats を呼ぶことがあるので基点を clear してから測る。
      spy.mockClear();

      conn.reconnect();
      // reconnect() は pre-drain (即時) と teardown cb の post-drain
      // (round 3 hardening) を呼ぶ。Phoenix teardown() の waitForSocketClosed
      // は readyState=CLOSED なら synchronous に callback を呼ぶため、
      // reconnect() 呼び出し直後で既に 2 回 called (+ Phoenix 内部の追加
      // clear も来得るので >= 2 で assert)。
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
      const afterReconnect = spy.mock.calls.length;

      await vi.advanceTimersByTimeAsync(1);

      conn.disconnect();
      // disconnect() の pre-drain + round 5 の teardown cb 内 post-drain で
      // 2 回追加される (ふじ round 4 must-fix 1 hardening)。
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(afterReconnect + 2);

      await vi.advanceTimersByTimeAsync(500);
    } finally {
      spy.mockRestore();
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
