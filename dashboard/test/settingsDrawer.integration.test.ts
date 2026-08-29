// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsDrawer from "../src/lib/SettingsDrawer.svelte";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  settings,
  updateSettings,
} from "../src/lib/settings.svelte";
import type { ConversationSummary, KaoiroConnection } from "../src/lib/protocol";

const mounted: object[] = [];

beforeEach(() => {
  localStorage.clear();
  // Reset the shared settings singleton (module-level $state persists
  // across tests in this file) to a known baseline before each case.
  // ふじ round-1 should-fix S2: this used to reset only
  // notificationSoundEnabled/notificationSoundVolume by name, so a test
  // that flipped agentCardStatsEnabled or hideNonMessageLogEntries left
  // that value to leak into whichever test ran next — an order-dependent
  // fixture. Resetting the whole object (not naming fields) also means a
  // FUTURE field added to Settings is reset automatically.
  updateSettings(DEFAULT_SETTINGS);
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

async function renderDrawer(
  onClose = vi.fn(),
  connection?: KaoiroConnection,
) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(SettingsDrawer, {
    target,
    props: { onClose, connection },
  });
  mounted.push(component);
  await tick();
  return { target, onClose };
}

/** issue #276: stub whose listConversations() resolves/rejects under test
 *  control (mirrors launchDefaults.integration.test.ts's makeConnection). */
function makeConnection(list: () => Promise<ConversationSummary[]>) {
  return { listConversations: vi.fn(list) } as unknown as KaoiroConnection;
}

// ふじ round-1 should-fix S2: selecting a checkbox by its position among
// `input[type="checkbox"]` (first/last) breaks the moment a checkbox is
// inserted or reordered — select by the row's own label text instead, the
// same contract an operator reads.
function checkboxByLabel(
  target: HTMLElement,
  labelText: string,
): HTMLInputElement {
  const label = Array.from(target.querySelectorAll("label")).find((el) =>
    el.textContent?.includes(labelText),
  );
  const checkbox = label?.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (!checkbox) {
    throw new Error(`checkbox not found for label containing: ${labelText}`);
  }
  return checkbox;
}

describe("SettingsDrawer", () => {
  it("現在の設定値を反映して表示する", async () => {
    updateSettings({ notificationSoundEnabled: false, notificationSoundVolume: 0.25 });
    const { target } = await renderDrawer();
    const checkbox = checkboxByLabel(target, "通知音");
    const range = target.querySelector<HTMLInputElement>('input[type="range"]');
    expect(checkbox.checked).toBe(false);
    expect(range?.value).toBe("0.25");
  });

  it("通知音 ON/OFF を切り替えると即座に永続化する", async () => {
    const { target } = await renderDrawer();
    const checkbox = checkboxByLabel(target, "通知音");
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
    const checkbox = checkboxByLabel(target, "ツール呼び出しなどを非表示");
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

  // issue #276 (admin-only first cut): connection 未指定なら会話一覧
  // セクション自体を出さない — connection のない呼び出し元(未接続時)
  // でも既存のローカル設定は変わらず使える。
  it("connection 未指定なら会話一覧セクションを出さない", async () => {
    const { target } = await renderDrawer();
    expect(target.querySelector(".conversations")).toBeNull();
  });

  it("connection 指定時、取得した会話一覧を participants/turns/status で表示する", async () => {
    const conn = makeConnection(async () => [
      {
        conversationId: "c1",
        participants: ["gp.a", "gp.b"],
        turns: 3,
        tokens: 50,
        status: "open",
        startedAt: "2026-08-29T00:00:00Z",
      },
    ]);
    const { target } = await renderDrawer(vi.fn(), conn);
    await Promise.resolve();
    await tick();

    expect(conn.listConversations).toHaveBeenCalledTimes(1);
    const item = target.querySelector(".conv-list li")!;
    expect(item.textContent).toContain("gp.a ⇔ gp.b");
    expect(item.textContent).toContain("3 turns / open");
  });

  it("会話が 0 件なら空である旨を表示する", async () => {
    const conn = makeConnection(async () => []);
    const { target } = await renderDrawer(vi.fn(), conn);
    await Promise.resolve();
    await tick();

    expect(target.querySelector(".conv-status")?.textContent).toContain(
      "開いている会話はありません",
    );
  });

  it("取得失敗時はエラー文言を表示する", async () => {
    const conn = makeConnection(() => Promise.reject(new Error("forbidden")));
    const { target } = await renderDrawer(vi.fn(), conn);
    await Promise.resolve();
    await tick();

    expect(target.querySelector(".conv-status")?.textContent).toContain(
      "forbidden",
    );
  });
});
