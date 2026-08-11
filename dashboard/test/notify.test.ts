import { describe, expect, it } from "vitest";
import {
  isWaitTransition,
  notifyWait,
  requestNotificationPermission,
  soundUrlFor,
  waitNotificationContent,
} from "../src/lib/notify";
import type { Envelope } from "../src/lib/protocol";

const envelope = (over: Partial<Envelope> = {}): Envelope => ({
  version: "0",
  agent_id: "a1",
  ts: "2026-06-16T00:00:00Z",
  type: "state",
  state: "waiting_input",
  ...over,
});

describe("isWaitTransition", () => {
  it("非待ち → 待ち状態の遷移で true", () => {
    expect(isWaitTransition("thinking", "waiting_input")).toBe(true);
    expect(isWaitTransition("tool_running", "waiting_permission")).toBe(true);
  });

  it("初出(prev undefined)で待ち状態なら true", () => {
    expect(isWaitTransition(undefined, "waiting_permission")).toBe(true);
  });

  it("待ち状態の継続・待ち間の移動では false(再アラートしない)", () => {
    expect(isWaitTransition("waiting_input", "waiting_input")).toBe(false);
    expect(isWaitTransition("waiting_input", "waiting_permission")).toBe(false);
  });

  it("待ち状態以外への遷移では false", () => {
    expect(isWaitTransition("waiting_input", "thinking")).toBe(false);
    expect(isWaitTransition(undefined, "idle")).toBe(false);
  });
});

describe("waitNotificationContent", () => {
  it("display_name と状態ラベルを使う", () => {
    const content = waitNotificationContent(
      envelope({
        state: "waiting_permission",
        persona: { id: "ao", name: "蒼", sprite_set: "ao" },
        display_name: "蒼",
      }),
    );
    expect(content.title).toBe("蒼");
    expect(content.body).toBe("permission?");
  });

  it("ペルソナ未設定なら agent_id にフォールバック", () => {
    expect(waitNotificationContent(envelope()).title).toBe("a1");
  });
});

describe("soundUrlFor", () => {
  it("待ち状態ごとに別の音 URL を返す", () => {
    const input = soundUrlFor("waiting_input");
    const permission = soundUrlFor("waiting_permission");
    expect(typeof input).toBe("string");
    expect(typeof permission).toBe("string");
    expect(input).not.toBe(permission);
  });

  it("待ち状態以外は undefined", () => {
    expect(soundUrlFor("thinking")).toBeUndefined();
    expect(soundUrlFor("idle")).toBeUndefined();
  });
});

describe("notifyWait / requestNotificationPermission", () => {
  it("Notification/Audio 不在環境でも例外を投げない(fail-soft)", () => {
    expect(() => requestNotificationPermission()).not.toThrow();
    expect(() => notifyWait(envelope())).not.toThrow();
  });
});
