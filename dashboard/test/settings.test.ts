import "./isolation.setup";
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
      gridSort: "recent",
      locale: "en",
      detailTab: "kaoiro",
    });
    expect(loadSettings()).toEqual({
      notificationSoundEnabled: false,
      notificationSoundVolume: 0.3,
      agentCardStatsEnabled: false,
      hideNonMessageLogEntries: true,
      gridSort: "recent",
      locale: "en",
      detailTab: "kaoiro",
    });
  });

  it("gridSort の不正値は default の name に戻す", () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ gridSort: "random" }),
    );
    expect(loadSettings().gridSort).toBe("name");
  });

  it("loads an unknown or missing detailTab as engine (issue 1075)", () => {
    for (const detailTab of ["claude", "", 1, null, "KAOIRO"]) {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ detailTab }));
      expect(loadSettings().detailTab).toBe("engine");
    }
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ gridSort: "recent" }));
    expect(loadSettings().detailTab).toBe("engine");
  });

  it("locale の不正値と locale の無い保存値は default の auto に戻す (issue #269)", () => {
    for (const locale of ["fr", "", 1, null, "AUTO"]) {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ locale }));
      expect(loadSettings().locale).toBe("auto");
    }
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ gridSort: "recent" }),
    );
    expect(loadSettings().locale).toBe("auto");
  });

  it("locale の auto / ja / en は保存値から復元する (issue #269)", () => {
    for (const locale of ["auto", "ja", "en"]) {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ locale }));
      expect(loadSettings().locale).toBe(locale);
    }
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
      gridSort: "name",
      // The shared test setup pins the UI language to ja.
      locale: "ja",
      detailTab: "engine",
    });
  });

  it("gridSort を更新して永続化する", () => {
    updateSettings({ gridSort: "recent" });
    expect(settings.gridSort).toBe("recent");
    expect(loadSettings().gridSort).toBe("recent");
    updateSettings({ gridSort: "name" });
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
