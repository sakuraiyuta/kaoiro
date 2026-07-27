import { describe, expect, it } from "vitest";
import {
  PhoenixHeartbeatLogFilter,
  createPhoenixWireLogger,
} from "../src/transport.js";

const CHANNEL_TOPIC = "runner:dev-host";

describe("PhoenixHeartbeatLogFilter", () => {
  it("socket / runner channel heartbeat push と対応 reply だけを抑止する", () => {
    const filter = new PhoenixHeartbeatLogFilter(CHANNEL_TOPIC, false);

    expect(filter.shouldWrite("push", "phoenix heartbeat (null, 101)")).toBe(
      false,
    );
    expect(
      filter.shouldWrite("receive", "ok phoenix phx_reply (101)"),
    ).toBe(false);

    expect(
      filter.shouldWrite("push", "runner:dev-host heartbeat (3, 102)"),
    ).toBe(false);
    expect(
      filter.shouldWrite("receive", "ok runner:dev-host phx_reply (102)"),
    ).toBe(false);
  });

  it("同じ topic の非 heartbeat phx_reply と通常 wire log は残す", () => {
    const filter = new PhoenixHeartbeatLogFilter(CHANNEL_TOPIC, false);

    // heartbeat reply でない ref は、同じ runner topic でも必ず残す。
    expect(
      filter.shouldWrite(
        "receive",
        "ok runner:dev-host phx_reply (instruction-ref)",
      ),
    ).toBe(true);
    expect(
      filter.shouldWrite("push", "runner:dev-host instruction (3, 103)"),
    ).toBe(true);
    expect(filter.shouldWrite("transport", "WebSocket connected")).toBe(true);
  });

  it("他 topic の heartbeat は記録も抑止もしない", () => {
    const filter = new PhoenixHeartbeatLogFilter(CHANNEL_TOPIC, false);

    expect(
      filter.shouldWrite("push", "agents:lobby heartbeat (4, other-ref)"),
    ).toBe(true);
    expect(
      filter.shouldWrite("receive", "ok agents:lobby phx_reply (other-ref)"),
    ).toBe(true);
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

    logger("push", "phoenix heartbeat (null, 201)", {});
    logger("receive", "ok phoenix phx_reply (201)", { status: "ok" });

    expect(lines).toEqual([
      "runner: phoenix push: phoenix heartbeat (null, 201) {}\n",
      'runner: phoenix receive: ok phoenix phx_reply (201) {"status":"ok"}\n',
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
