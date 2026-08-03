import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CONTROL_EVENT_BY_CALLBACK,
  PhoenixHeartbeatLogFilter,
  RUNNER_PROTOCOL_VERSION,
  bindControlEvents,
  createPhoenixWireLogger,
  warnOnVersionMismatch,
} from "../src/transport.js";

const CHANNEL_TOPIC = "runner:dev-host";

describe("受信 version の不一致検査 (ADR-0015 / issue #181)", () => {
  function capture(payload: unknown, event = "spawn"): string[] {
    const lines: string[] = [];
    warnOnVersionMismatch(event, payload, (line) => lines.push(line));
    return lines;
  }

  it("自 version と一致すれば何も出さない", () => {
    expect(capture({ version: RUNNER_PROTOCOL_VERSION, agent_id: "h.a" }))
      .toEqual([]);
  });

  it("不一致なら event 名と受信値を添えて warn する", () => {
    const [line, ...rest] = capture({ version: "1" }, "switch_session");

    expect(rest).toEqual([]);
    expect(line).toContain("switch_session");
    expect(line).toContain('server declared protocol version "1"');
    expect(line).toContain('accepting as "0"');
    expect(line).toContain("ADR-0015 best-effort accept");
    expect(line?.endsWith("\n")).toBe(true);
  });

  // server は runner 宛の全メッセージに "0" を stamp するので、欠落は
  // 「まだ追随していない送信者がいる」ではなく不変条件が壊れた印。
  it("version が無ければ (absent) として warn する", () => {
    const [line] = capture({ agent_id: "h.a" });

    expect(line).toContain("protocol version (absent)");
  });

  it("payload が object でなくても落ちずに warn する", () => {
    for (const payload of [null, undefined, "0", 0, []]) {
      expect(capture(payload)).toHaveLength(1);
    }
  });

  it("非文字列の version も型を保って出す", () => {
    expect(capture({ version: 0 })[0]).toContain("protocol version 0");
    expect(capture({ version: null })[0]).toContain("protocol version null");
    expect(capture({ version: { a: 1 } })[0]).toContain(
      'protocol version {"a":1}',
    );
  });

  it("長すぎる version は切り詰める (未検証の wire 入力なので)", () => {
    const [line] = capture({ version: "v".repeat(500) });

    expect(line).toContain("(truncated)");
    expect(line?.length).toBeLessThan(200);
  });

  // ADR-0015 のベストエフォート受理: warn は出しても処理は止めない。
  it("不一致でも例外を投げない", () => {
    expect(() => capture({ version: "1" })).not.toThrow();
  });
});

describe("CONTROL_EVENT_BY_CALLBACK", () => {
  // issue #181 の要求は「runner が受け取る全メッセージ」。checkが漏れる
  // 経路が生まれないよう、対応表そのものを固定する。
  it("server → runner の 7 コマンドを漏れなく対応づける", () => {
    expect(CONTROL_EVENT_BY_CALLBACK).toEqual({
      onSpawn: "spawn",
      onStop: "stop",
      onRestart: "restart",
      onEnumerateSessions: "enumerate_sessions",
      onSwitchSession: "switch_session",
      onResetSession: "reset_session",
      onRefreshEngineCatalog: "refresh_engine_catalog",
    });
  });

  it("event 名は重複しない", () => {
    const events = Object.values(CONTROL_EVENT_BY_CALLBACK);

    expect(new Set(events).size).toBe(events.length);
  });
});

describe("bindControlEvents", () => {
  function fakeChannel(): {
    channel: { on(event: string, cb: (payload: unknown) => void): unknown };
    deliver(event: string, payload: unknown): void;
    boundEvents(): string[];
  } {
    const handlers = new Map<string, (payload: unknown) => void>();
    return {
      channel: {
        on(event, cb) {
          handlers.set(event, cb);
          return 0;
        },
      },
      deliver(event, payload) {
        const handler = handlers.get(event);
        if (handler === undefined) throw new Error(`unbound event: ${event}`);
        handler(payload);
      },
      boundEvents: () => [...handlers.keys()],
    };
  }

  function emptyCallbacks(): Record<string, undefined> {
    return Object.fromEntries(
      Object.keys(CONTROL_EVENT_BY_CALLBACK).map((key) => [key, undefined]),
    );
  }

  it("7 コマンドすべてを bind する", () => {
    const fake = fakeChannel();

    bindControlEvents(fake.channel, () => emptyCallbacks() as never);

    expect(fake.boundEvents().sort()).toEqual(
      Object.values(CONTROL_EVENT_BY_CALLBACK).sort(),
    );
  });

  // これが本命の回帰: 受信口の全 event で version 検査が実際に走ること。
  // 検査を bind から外すと、この test だけが落ちる。
  it("どの event でも version 不一致で warn が出る", () => {
    const fake = fakeChannel();
    const lines: string[] = [];

    bindControlEvents(fake.channel, () => emptyCallbacks() as never, (line) =>
      lines.push(line),
    );

    for (const event of Object.values(CONTROL_EVENT_BY_CALLBACK)) {
      fake.deliver(event, { version: "9" });
    }

    expect(lines).toHaveLength(
      Object.values(CONTROL_EVENT_BY_CALLBACK).length,
    );
    for (const event of Object.values(CONTROL_EVENT_BY_CALLBACK)) {
      expect(lines.some((line) => line.includes(`runner: ${event}:`))).toBe(
        true,
      );
    }
  });

  it("version が一致すれば warn は出ない", () => {
    const fake = fakeChannel();
    const lines: string[] = [];

    bindControlEvents(fake.channel, () => emptyCallbacks() as never, (line) =>
      lines.push(line),
    );

    for (const event of Object.values(CONTROL_EVENT_BY_CALLBACK)) {
      fake.deliver(event, { version: RUNNER_PROTOCOL_VERSION });
    }

    expect(lines).toEqual([]);
  });

  // ベストエフォート受理 (ADR-0015): warn を出しても handler は必ず呼ぶ。
  it("不一致でも payload をそのまま handler へ渡す", () => {
    const fake = fakeChannel();
    const seen: Array<[string, unknown]> = [];
    const callbacks = Object.fromEntries(
      Object.keys(CONTROL_EVENT_BY_CALLBACK).map((key) => [
        key,
        (payload: unknown) => seen.push([key, payload]),
      ]),
    );

    bindControlEvents(fake.channel, () => callbacks as never, () => {});

    const payload = { version: "9", agent_id: "lab-pc-1.claude-a" };
    for (const event of Object.values(CONTROL_EVENT_BY_CALLBACK)) {
      fake.deliver(event, payload);
    }

    expect(seen).toHaveLength(Object.keys(CONTROL_EVENT_BY_CALLBACK).length);
    for (const [, delivered] of seen) expect(delivered).toBe(payload);
  });

  // bindControlEvents 単体をいくら検証しても、受信口 (RunnerLink.#wire) が
  // それを通ることは担保されない。#wire に生の channel.on が 1 本増えれば
  // その event は検査を素通りし、しかも全テストは緑のまま — issue #181 が
  // 潰そうとした形そのものが復活する。RunnerLink は constructor で
  // `new Socket` を直に組むので注入点が無く、代わりにソースを読んで
  // 「生 bind が無いこと」を固定する。変数名を変えられるとすり抜ける弱い
  // ガードだが、seam を掘るより安く、狙いは正確に射抜ける。
  it("受信口は bindControlEvents だけを通す (検査を迂回する生 bind を増やさない)", async () => {
    const source = await readFile(
      new URL("../src/transport.ts", import.meta.url),
      "utf8",
    );

    expect(source.match(/channel\.on\(/g) ?? []).toHaveLength(1);
    expect(source).toContain(
      "bindControlEvents(channel, () => this.#callbacks)",
    );
  });

  it("callback は配送時に解決される (bind 時ではない)", () => {
    const fake = fakeChannel();
    let callbacks = emptyCallbacks() as Record<string, unknown>;

    bindControlEvents(fake.channel, () => callbacks as never, () => {});

    const calls: unknown[] = [];
    callbacks = { ...callbacks, onSpawn: (p: unknown) => calls.push(p) };
    fake.deliver("spawn", { version: RUNNER_PROTOCOL_VERSION });

    expect(calls).toHaveLength(1);
  });
});

describe("PhoenixHeartbeatLogFilter", () => {
  it("socket / runner channel heartbeat push と対応 reply だけを抑止する", () => {
    const filter = new PhoenixHeartbeatLogFilter(CHANNEL_TOPIC, false);

    expect(
      filter.shouldWrite("push", "phoenix heartbeat (undefined, 101)", {}),
    ).toBe(false);
    expect(
      filter.shouldWrite("receive", "ok phoenix phx_reply (101)", {
        status: "ok",
      }),
    ).toBe(false);

    expect(
      filter.shouldWrite("push", "runner:dev-host heartbeat (3, 102)", {}),
    ).toBe(false);
    expect(
      filter.shouldWrite("receive", "ok runner:dev-host phx_reply (102)", {
        status: "ok",
      }),
    ).toBe(false);
  });

  it("同じ topic の非 heartbeat phx_reply と通常 wire log は残す", () => {
    const filter = new PhoenixHeartbeatLogFilter(CHANNEL_TOPIC, false);

    // heartbeat reply でない ref は、同じ runner topic でも必ず残す。
    expect(
      filter.shouldWrite(
        "receive",
        "ok runner:dev-host phx_reply (instruction-ref)",
        { status: "ok" },
      ),
    ).toBe(true);
    expect(
      filter.shouldWrite("push", "runner:dev-host instruction (3, 103)", {}),
    ).toBe(true);
    expect(filter.shouldWrite("transport", "WebSocket connected", {})).toBe(
      true,
    );
  });

  it("他 topic の heartbeat は記録も抑止もしない", () => {
    const filter = new PhoenixHeartbeatLogFilter(CHANNEL_TOPIC, false);

    expect(
      filter.shouldWrite("push", "agents:lobby heartbeat (4, other-ref)", {}),
    ).toBe(true);
    expect(
      filter.shouldWrite("receive", "ok agents:lobby phx_reply (other-ref)", {
        status: "ok",
      }),
    ).toBe(true);
  });

  it("65 ref を超えると最古だけを忘れ、最新 heartbeat reply は抑止する", () => {
    const filter = new PhoenixHeartbeatLogFilter(CHANNEL_TOPIC, false);
    for (let ref = 1; ref <= 65; ref += 1) {
      expect(
        filter.shouldWrite(
          "push",
          `runner:dev-host heartbeat (3, ${ref})`,
          {},
        ),
      ).toBe(false);
    }

    // Bound を越えて eviction された ref=1 は、reply を消さない。
    expect(
      filter.shouldWrite("receive", "ok runner:dev-host phx_reply (1)", {
        status: "ok",
      }),
    ).toBe(true);
    // 65 個目はまだ追跡されているため、成功 reply だけ抑止される。
    expect(
      filter.shouldWrite("receive", "ok runner:dev-host phx_reply (65)", {
        status: "ok",
      }),
    ).toBe(false);
  });
});

describe("createPhoenixWireLogger", () => {
  it("デフォルト相当では heartbeat pair を書かず、通常 reply は書く", () => {
    const lines: string[] = [];
    const logger = createPhoenixWireLogger(CHANNEL_TOPIC, {
      includeHeartbeats: false,
      write: (line) => lines.push(line),
    });

    logger("push", "runner:dev-host heartbeat (3, heartbeat-ref)", {});
    logger("receive", "ok runner:dev-host phx_reply (heartbeat-ref)", {
      status: "ok",
    });
    logger("receive", "ok runner:dev-host phx_reply (instruction-ref)", {
      status: "ok",
    });

    expect(lines).toEqual([
      'runner: phoenix receive: ok runner:dev-host phx_reply (instruction-ref) {"status":"ok"}\n',
    ]);
  });

  it("heartbeat logging 有効時は push/reply を含む全量を出力する", () => {
    const lines: string[] = [];
    const logger = createPhoenixWireLogger(CHANNEL_TOPIC, {
      includeHeartbeats: true,
      write: (line) => lines.push(line),
    });

    logger("push", "phoenix heartbeat (undefined, 201)", {});
    logger("receive", "ok phoenix phx_reply (201)", { status: "ok" });

    expect(lines).toEqual([
      "runner: phoenix push: phoenix heartbeat (undefined, 201) {}\n",
      'runner: phoenix receive: ok phoenix phx_reply (201) {"status":"ok"}\n',
    ]);
  });

  it("heartbeat の error reply は異常兆候としてデフォルトでも出力する", () => {
    const lines: string[] = [];
    const logger = createPhoenixWireLogger(CHANNEL_TOPIC, {
      includeHeartbeats: false,
      write: (line) => lines.push(line),
    });

    logger("push", "runner:dev-host heartbeat (3, error-ref)", {});
    logger("receive", "error runner:dev-host phx_reply (error-ref)", {
      status: "error",
      response: { reason: "unmatched topic" },
    });

    expect(lines).toEqual([
      'runner: phoenix receive: error runner:dev-host phx_reply (error-ref) {"status":"error","response":{"reason":"unmatched topic"}}\n',
    ]);
  });

  it("抑止以外の token redaction を維持する", () => {
    const lines: string[] = [];
    const logger = createPhoenixWireLogger(CHANNEL_TOPIC, {
      includeHeartbeats: false,
      write: (line) => lines.push(line),
    });

    logger(
      "transport",
      "WebSocket connected to ws://host/runner/websocket?token=secret-value&vsn=2.0.0",
      {},
    );

    expect(lines).toEqual([
      "runner: phoenix transport: WebSocket connected to ws://host/runner/websocket?token=<REDACTED>&vsn=2.0.0 {}\n",
    ]);
  });
});
