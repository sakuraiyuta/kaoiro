import { describe, expect, it } from "vitest";
import {
  expressionFor,
  isFatigued,
  KNOWN_STATES,
  spriteStateFor,
  spriteUrlFor,
} from "../src/lib/expression";
import type { Envelope, PersonaManifest } from "../src/lib/protocol";

function fatigueEnvelope(
  supportsContextUsage: boolean | undefined,
  usedPercentage: unknown,
  includeCapabilities = true,
): Envelope {
  const ext: Record<string, unknown> = { context: { used_percentage: usedPercentage } };
  if (includeCapabilities) {
    ext.session_capabilities = {
      supports_attachments: true,
      supports_user_input_dialog: true,
      ...(supportsContextUsage === undefined
        ? {}
        : { supports_context_usage: supportsContextUsage }),
    };
  }
  return { version: "0", agent_id: "a", ts: "t", type: "state_change", state: "idle", ext };
}

describe("expressionFor", () => {
  it("全状態に固有の表情バリアントを返す", () => {
    const variants = KNOWN_STATES.map((s) => expressionFor(s).variant);
    expect(new Set(variants).size).toBe(KNOWN_STATES.length);
    for (const state of KNOWN_STATES) {
      expect(expressionFor(state).variant).toBe(state);
    }
  });

  it("未知の状態は idle 表情へフォールバックする(前方互換)", () => {
    expect(expressionFor("future_state").variant).toBe("idle");
  });
});

describe("spriteUrlFor", () => {
  const entry = (url: string) => ({ url, hash: "sha256:0" });
  const manifest: PersonaManifest = {
    version: "abc",
    personas: {
      ao: {
        states: {
          idle: entry("/personas/ao/idle.png?v=1"),
          thinking: entry("/personas/ao/thinking.png?v=2"),
        },
      },
      noidle: { states: {} },
    },
  };

  it("状態に対応するスプライト URL を返す", () => {
    expect(spriteUrlFor(manifest, "ao", "thinking")).toBe(
      "/personas/ao/thinking.png?v=2",
    );
  });

  it("スプライトのない状態は idle へフォールバックする", () => {
    // disconnected has no image by spec (personas.md); unknown states
    // are forward compat.
    expect(spriteUrlFor(manifest, "ao", "disconnected")).toBe(
      "/personas/ao/idle.png?v=1",
    );
    expect(spriteUrlFor(manifest, "ao", "future_state")).toBe(
      "/personas/ao/idle.png?v=1",
    );
  });

  it("解決できない場合は null(CSS 顔フォールバック)", () => {
    expect(spriteUrlFor(null, "ao", "idle")).toBeNull();
    expect(spriteUrlFor(manifest, undefined, "idle")).toBeNull();
    expect(spriteUrlFor(manifest, "unknown_set", "idle")).toBeNull();
    expect(spriteUrlFor(manifest, "noidle", "thinking")).toBeNull();
  });
});

describe("isFatigued", () => {
  it("TB-1: capability=true かつ used_percentage=60 は疲労と判定する", () => {
    expect(isFatigued(fatigueEnvelope(true, 60))).toBe(true);
  });

  it("TB-2: capability=true かつ used_percentage=59 は疲労と判定しない", () => {
    expect(isFatigued(fatigueEnvelope(true, 59))).toBe(false);
  });

  it.each([
    ["false", fatigueEnvelope(false, 90)],
    ["未報告", fatigueEnvelope(undefined, 90)],
    ["session_capabilities 無し", fatigueEnvelope(true, 90, false)],
  ])("TB-3: capability=%s は高使用率でも fail-closed", (_label, envelope) => {
    expect(isFatigued(envelope)).toBe(false);
  });

  it.each([
    ["context 無し", { ...fatigueEnvelope(true, 90), ext: { session_capabilities: { supports_attachments: true, supports_user_input_dialog: true, supports_context_usage: true } } }],
    ["null", fatigueEnvelope(true, null)],
    ["文字列", fatigueEnvelope(true, "90")],
    ["NaN", fatigueEnvelope(true, Number.NaN)],
  ])("TB-4: %s の context は fail-closed", (_label, envelope) => {
    expect(isFatigued(envelope)).toBe(false);
  });
});

describe("spriteStateFor", () => {
  it.each(["idle", "waiting_input"])("TB-5: %s の疲労は fatigued sprite を選ぶ", (state) => {
    expect(spriteStateFor(state, true)).toBe("fatigued");
  });

  it.each([
    "thinking",
    "tool_running",
    "done",
    "error",
    "waiting_permission",
    "waiting_question",
    "sending",
  ])("TB-6: %s は疲労でも元の state を保つ", (state) => {
    expect(spriteStateFor(state, true)).toBe(state);
  });

  it("TB-7: disconnected は疲労より優先する", () => {
    expect(spriteStateFor("disconnected", true)).toBe("disconnected");
  });
});

describe("fatigued sprite URL", () => {
  const entry = (url: string) => ({ url, hash: "sha256:0" });
  const withoutFatigued: PersonaManifest = {
    version: "v",
    personas: { ao: { states: { idle: entry("/idle.png") } } },
  };
  const withFatigued: PersonaManifest = {
    version: "v",
    personas: { ao: { states: { idle: entry("/idle.png"), fatigued: entry("/fatigued.png") } } },
  };

  it("TB-8: fatigued を持たない pack は idle sprite へフォールバックする", () => {
    expect(spriteUrlFor(withoutFatigued, "ao", "fatigued")).toBe("/idle.png");
  });

  it("TB-9: fatigued を持つ pack は fatigued sprite を返す", () => {
    expect(spriteUrlFor(withFatigued, "ao", "fatigued")).toBe("/fatigued.png");
  });
});
