import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMON_FOOTER, ConfigError, resolvePersonaAppend } from "../src/persona.js";
import type { WrapperConfig } from "../src/types.js";

/** Personality resolution for the SDK systemPrompt.append (ADR-0026). */
describe("resolvePersonaAppend", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kaoiro-persona-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const baseConfig = (
    id: string,
    extra: Partial<WrapperConfig["persona"]> = {},
  ): WrapperConfig => ({
    agent_id: "lab-pc-1.claude-a",
    persona: { id, name: id, sprite_set: id, ...extra },
  });

  it("同梱デフォルト md を読み、末尾に共通フッターを付ける", () => {
    const packageRoot = tmpRoot;
    mkdirSync(join(packageRoot, "personas"));
    writeFileSync(join(packageRoot, "personas", "ao.md"), "口調ガイド", "utf8");

    const out = resolvePersonaAppend(
      baseConfig("ao"),
      join(packageRoot, "agent.ao.json"),
      { packageRoot },
    );

    expect(out).toBe(`口調ガイド\n\n${COMMON_FOOTER}`);
  });

  it("同梱デフォルト不在なら共通フッターのみ (default ペルソナ相当)", () => {
    // No personas/ directory at all — nothing to read.
    const out = resolvePersonaAppend(
      baseConfig("default"),
      join(tmpRoot, "agent.default.json"),
      { packageRoot: tmpRoot },
    );

    expect(out).toBe(COMMON_FOOTER);
  });

  it("config 指定パスは config ファイルのディレクトリ基準で解決する", () => {
    // Custom personality lives next to a config file in a subdirectory,
    // NOT under the packageRoot's personas/ tree — proving the basedir is
    // the config dir, not the package root.
    const configDir = join(tmpRoot, "custom-config");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "my-personality.md"), "カスタム口調", "utf8");

    const out = resolvePersonaAppend(
      baseConfig("ao", { personality_prompt_file: "./my-personality.md" }),
      join(configDir, "agent.ao.json"),
      { packageRoot: tmpRoot },
    );

    expect(out).toBe(`カスタム口調\n\n${COMMON_FOOTER}`);
  });

  it("絶対パス指定は config dir を無視して読む", () => {
    const abs = join(tmpRoot, "abs-personality.md");
    writeFileSync(abs, "絶対パス口調", "utf8");

    const out = resolvePersonaAppend(
      baseConfig("ao", { personality_prompt_file: abs }),
      "/nowhere/agent.ao.json",
      { packageRoot: tmpRoot },
    );

    expect(out).toBe(`絶対パス口調\n\n${COMMON_FOOTER}`);
  });

  it("config 指定パスが存在しない場合は ConfigError (fail-fast)", () => {
    expect(() =>
      resolvePersonaAppend(
        baseConfig("ao", {
          personality_prompt_file: "./does-not-exist.md",
        }),
        join(tmpRoot, "agent.ao.json"),
        { packageRoot: tmpRoot },
      ),
    ).toThrow(ConfigError);
  });

  it("md 内の前後空白は trim して 1 段の空行でフッターに繋ぐ", () => {
    const packageRoot = tmpRoot;
    mkdirSync(join(packageRoot, "personas"));
    writeFileSync(
      join(packageRoot, "personas", "ao.md"),
      "\n\n口調本文\n\n",
      "utf8",
    );

    const out = resolvePersonaAppend(
      baseConfig("ao"),
      join(packageRoot, "agent.ao.json"),
      { packageRoot },
    );

    expect(out).toBe(`口調本文\n\n${COMMON_FOOTER}`);
  });
});
