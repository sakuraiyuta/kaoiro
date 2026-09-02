// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  saveSettings,
  settings,
  updateSettings,
} from "../src/lib/settings.svelte";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("loadSettings", () => {
  it("未設定なら default を返す", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("保存済み値を round-trip で復元する", () => {
    saveSettings({
      notificationSoundEnabled: false,
      notificationSoundVolume: 0.3,
      agentCardStatsEnabled: false,
      hideNonMessageLogEntries: true,
    });
    expect(loadSettings()).toEqual({
      notificationSoundEnabled: false,
      notificationSoundVolume: 0.3,
      agentCardStatsEnabled: false,
      hideNonMessageLogEntries: true,
    });
  });

  it("壊れた JSON なら default にフォールバックする", () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, "{not json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("欠損キーは default で補う", () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({}));
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("volume を 0.0-1.0 に clamp する", () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ notificationSoundEnabled: true, notificationSoundVolume: 1.5 }),
    );
    expect(loadSettings().notificationSoundVolume).toBe(1);

    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ notificationSoundEnabled: true, notificationSoundVolume: -0.5 }),
    );
    expect(loadSettings().notificationSoundVolume).toBe(0);
  });

  it("volume が数値でなければ default に戻す", () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ notificationSoundEnabled: true, notificationSoundVolume: "loud" }),
    );
    expect(loadSettings().notificationSoundVolume).toBe(
      DEFAULT_SETTINGS.notificationSoundVolume,
    );
  });

  it("agentCardStatsEnabled の保存値を復元する", () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ agentCardStatsEnabled: false }),
    );
    expect(loadSettings().agentCardStatsEnabled).toBe(false);
  });

  it("agentCardStatsEnabled が boolean でなければ default に戻す", () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ agentCardStatsEnabled: "yes" }),
    );
    expect(loadSettings().agentCardStatsEnabled).toBe(
      DEFAULT_SETTINGS.agentCardStatsEnabled,
    );
  });

  it("hideNonMessageLogEntries の保存値を復元する (issue #228)", () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ hideNonMessageLogEntries: true }),
    );
    expect(loadSettings().hideNonMessageLogEntries).toBe(true);
  });

  it("hideNonMessageLogEntries が boolean でなければ default に戻す (issue #228)", () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ hideNonMessageLogEntries: "yes" }),
    );
    expect(loadSettings().hideNonMessageLogEntries).toBe(
      DEFAULT_SETTINGS.hideNonMessageLogEntries,
    );
  });
});

describe("updateSettings", () => {
  it("設定を更新して永続化する", () => {
    updateSettings({
      notificationSoundEnabled: false,
      notificationSoundVolume: 0.2,
      agentCardStatsEnabled: true,
    });
    expect(settings.notificationSoundEnabled).toBe(false);
    expect(settings.notificationSoundVolume).toBe(0.2);
    expect(loadSettings()).toEqual({
      notificationSoundEnabled: false,
      notificationSoundVolume: 0.2,
      agentCardStatsEnabled: true,
      hideNonMessageLogEntries: false,
    });
  });

  it("volume の clamp を適用する", () => {
    updateSettings({ notificationSoundVolume: 2 });
    expect(settings.notificationSoundVolume).toBe(1);
  });

  it("片方のみの更新はもう一方を保持する", () => {
    updateSettings({ notificationSoundEnabled: true, notificationSoundVolume: 0.5 });
    updateSettings({ notificationSoundEnabled: false });
    expect(settings.notificationSoundEnabled).toBe(false);
    expect(settings.notificationSoundVolume).toBe(0.5);
  });

  it("agentCardStatsEnabled を更新して永続化する", () => {
    updateSettings({ agentCardStatsEnabled: false });
    expect(settings.agentCardStatsEnabled).toBe(false);
    expect(loadSettings().agentCardStatsEnabled).toBe(false);
  });

  it("agentCardStatsEnabled のみの更新は他の設定を保持する", () => {
    updateSettings({ notificationSoundEnabled: false, notificationSoundVolume: 0.5 });
    updateSettings({ agentCardStatsEnabled: false });
    expect(settings.notificationSoundEnabled).toBe(false);
    expect(settings.notificationSoundVolume).toBe(0.5);
    expect(settings.agentCardStatsEnabled).toBe(false);
  });

  it("hideNonMessageLogEntries を更新して永続化する (issue #228)", () => {
    updateSettings({ hideNonMessageLogEntries: true });
    expect(settings.hideNonMessageLogEntries).toBe(true);
    expect(loadSettings().hideNonMessageLogEntries).toBe(true);
  });

  it("hideNonMessageLogEntries のみの更新は他の設定を保持する (issue #228)", () => {
    updateSettings({ notificationSoundEnabled: false, notificationSoundVolume: 0.5 });
    updateSettings({ hideNonMessageLogEntries: true });
    expect(settings.notificationSoundEnabled).toBe(false);
    expect(settings.notificationSoundVolume).toBe(0.5);
    expect(settings.hideNonMessageLogEntries).toBe(true);
  });
});
