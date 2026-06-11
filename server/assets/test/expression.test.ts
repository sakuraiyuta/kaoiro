import { describe, expect, it } from "vitest";
import {
  expressionFor,
  KNOWN_STATES,
  spriteUrlFor,
} from "../src/lib/expression";
import type { PersonaManifest } from "../src/lib/protocol";

describe("expressionFor", () => {
  it("全 8 状態に固有の表情バリアントを返す", () => {
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
