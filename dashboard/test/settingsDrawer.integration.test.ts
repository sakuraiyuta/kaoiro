// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsDrawer from "../src/lib/SettingsDrawer.svelte";
import {
  SETTINGS_STORAGE_KEY,
  settings,
  updateSettings,
} from "../src/lib/settings.svelte";

const mounted: object[] = [];

beforeEach(() => {
  localStorage.clear();
  // Reset the shared settings singleton (module-level $state persists
  // across tests in this file) to a known baseline before each case.
  updateSettings({ notificationSoundEnabled: true, notificationSoundVolume: 0.7 });
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

async function renderDrawer(onClose = vi.fn()) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(SettingsDrawer, { target, props: { onClose } });
  mounted.push(component);
  await tick();
  return { target, onClose };
}

describe("SettingsDrawer", () => {
  it("現在の設定値を反映して表示する", async () => {
    updateSettings({ notificationSoundEnabled: false, notificationSoundVolume: 0.25 });
    const { target } = await renderDrawer();
    const checkbox = target.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const range = target.querySelector<HTMLInputElement>('input[type="range"]');
    expect(checkbox?.checked).toBe(false);
    expect(range?.value).toBe("0.25");
  });

  it("通知音 ON/OFF を切り替えると即座に永続化する", async () => {
    const { target } = await renderDrawer();
    const checkbox = target.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();

    expect(settings.notificationSoundEnabled).toBe(false);
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!);
    expect(stored.notificationSoundEnabled).toBe(false);
  });

  it("音量スライダーを動かすと即座に永続化する", async () => {
    const { target } = await renderDrawer();
    const range = target.querySelector<HTMLInputElement>('input[type="range"]')!;
    range.value = "0.4";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    expect(settings.notificationSoundVolume).toBe(0.4);
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!);
    expect(stored.notificationSoundVolume).toBe(0.4);
  });

  it("非メッセージ非表示トグルを切り替えると即座に永続化する (issue #228)", async () => {
    const { target } = await renderDrawer();
    const checkboxes = target.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    const checkbox = checkboxes[checkboxes.length - 1]!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();

    expect(settings.hideNonMessageLogEntries).toBe(true);
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!);
    expect(stored.hideNonMessageLogEntries).toBe(true);
  });

  it("閉じるボタンで onClose を呼ぶ", async () => {
    const onClose = vi.fn();
    const { target } = await renderDrawer(onClose);
    target
      .querySelector<HTMLButtonElement>("button.close")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
