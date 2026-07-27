import { describe, expect, it } from "vitest";
import {
  PhoenixHeartbeatLogFilter,
  createPhoenixWireLogger,
} from "../src/transport.js";

const CHANNEL_TOPIC = "runner:dev-host";

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
