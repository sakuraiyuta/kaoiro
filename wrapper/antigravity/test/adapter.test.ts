import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reduceStates } from "@kaoiro/agent-common";
import {
  agyEventToErrorDetail,
  agyEventToEvents,
  agyEventIsSuccessfulResult,
  agyEventToLogs,
  agyEventToQuotaExhaustion,
  agyEventToResult,
  agyEventToSessionId,
  parseAgyStreamLine,
  type AgyStreamEvent,
} from "../src/adapter.js";

function fixture(name: string): AgyStreamEvent[] {
  return readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map(parseAgyStreamLine)
    .filter((event): event is AgyStreamEvent => event !== null);
}

describe("agy stream-json adapter", () => {
  it("実測 pong fixtureをsending→thinking→doneに導出し、init id と最終文を保つ", () => {
    const events = fixture("pong");
    expect(agyEventToSessionId(events[0]!)).toBe("8bb5af2f-a5ad-432b-9484-57de753b0824");
    expect(reduceStates([{ kind: "user_send" }, ...events.flatMap(agyEventToEvents)], "idle")).toEqual([
      "sending",
      "thinking",
      "thinking",
      "done",
      "waiting_input",
    ]);
    expect(agyEventToResult(events.at(-1)!)).toEqual({ text: "PONG\n" });
    expect(agyEventIsSuccessfulResult(events.at(-1)!)).toBe(true);
  });

  it("実測 tool fixtureをtool_runningからthinkingへ戻し、入力とhook denyをrelayする", () => {
    const events = fixture("tool");
    expect(reduceStates([{ kind: "user_send" }, ...events.flatMap(agyEventToEvents)], "idle")).toEqual([
      "sending",
      "thinking",
      "tool_running",
      "thinking",
      "done",
      "waiting_input",
    ]);
    expect(events.flatMap(agyEventToLogs)).toContainEqual({
      kind: "tool_use",
      tool_use_id: "agy:ca0121a0-4da1-4069-8aa5-58b3b4ea62f2:2",
      tool_name: "list_dir",
      input: { DirectoryPath: "/home/yuta/.gemini/antigravity-cli" },
    });
    expect(events.flatMap(agyEventToLogs)).toContainEqual({
      kind: "tool_result",
      tool_use_id: "agy:ca0121a0-4da1-4069-8aa5-58b3b4ea62f2:2",
      output: "permission denied",
    });
  });

  it("実測 resume fixtureのsystem_messageを無視し、同じconversation idを保つ", () => {
    const events = fixture("resume");
    expect(agyEventToSessionId(events[0]!)).toBe("8bb5af2f-a5ad-432b-9484-57de753b0824");
    expect(events.flatMap(agyEventToLogs)).toEqual([
      { kind: "assistant", text: "PONG" },
      { kind: "assistant", text: "\n" },
    ]);
  });

  it("実測 ERROR resultをerror detail付きの失敗結果にする", () => {
    const result = fixture("sigterm").at(-1)!;
    expect(agyEventToEvents(result)).toEqual([
      { kind: "result", subtype: "error_during_execution" },
    ]);
    expect(agyEventToResult(result)).toEqual({
      is_error: true,
      error_subtype: "error_during_execution",
      error_detail: "timeout waiting for response",
    });
    expect(agyEventToErrorDetail(result)).toBe("timeout waiting for response");
    expect(agyEventIsSuccessfulResult(result)).toBe(false);
  });

  it.each([
    ["RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 148h49m28s.", 535_768],
    ["HTTP 429: quota exhausted. Resets in 148h49m28s\n", 535_768],
    ["HTTP 429: quota exhausted. Resets in 5m)", 300],
    ["HTTP 429: quota exhausted. Resets in 30s. Please upgrade your plan.", 30],
    ["RESOURCE_EXHAUSTED: quota exhausted. Resets in 52m13s", 3_133],
  ])("structures the quota reset delay: %s", (error, resetDelaySeconds) => {
    expect(agyEventToQuotaExhaustion({
      event: "result",
      result: { status: "ERROR", error },
    })).toEqual({ resetDelaySeconds });
  });

  it.each([
    "HTTP 500: Resets in 1h2m3s",
    "RESOURCE_EXHAUSTED (code 429): reset time unavailable",
    "RESOURCE_EXHAUSTED (code 429): Resets in tomorrow",
    "RESOURCE_EXHAUSTED (code 429): Resets in 1h60m0s",
    "HTTP 429: Resets in 1h 2m 3ms",
    "HTTP 429: Resets in 1h 2.5m",
    "HTTP 429: Resets in 1h,2m",
    "HTTP 429: Resets in 1h)2m",
    "HTTP 429: Resets in 1h.5m",
    "HTTP 429: Resets in 2h 3m 4s",
    "HTTP 429: Resets in 28s49m",
    "NOT_RESOURCE_EXHAUSTED: Resets in 1h",
    "RESOURCE_EXHAUSTED: Resets in",
  ])("does not classify an unproven quota/reset format: %s", (error) => {
    expect(agyEventToQuotaExhaustion({
      event: "result",
      result: { status: "ERROR", error },
    })).toBeNull();
  });

  it("壊れた行と未知eventは安全に無視する", () => {
    expect(parseAgyStreamLine("not json")).toBeNull();
    expect(parseAgyStreamLine('{"event":"vendor_future"}')).toBeNull();
  });
});
