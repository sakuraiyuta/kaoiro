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

// jsdom does not implement HTMLDialogElement.showModal/close (measured
// 2026-08-28, jsdom 29.1.1; same polyfill as modal.integration.test.ts).
// The manual-close confirm dialog (issue #276) is a Modal.svelte instance,
// so this file needs it too.
if (
  typeof HTMLDialogElement !== "undefined" &&
  typeof HTMLDialogElement.prototype.showModal !== "function"
) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

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
 *  control (mirrors launchDefaults.integration.test.ts's makeConnection).
 *  `close` defaults to a resolving no-op so tests that don't exercise
 *  manual close don't need to supply one. */
function makeConnection(
  list: () => Promise<ConversationSummary[]>,
  close: (cid: string) => Promise<void> = () => Promise.resolve(),
) {
  return {
    listConversations: vi.fn(list),
    closeConversation: vi.fn(close),
  } as unknown as KaoiroConnection;
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

    // issue #276 review follow-up (ふじ B1): the row must show the
    // conversation's own identity and start time, not just
    // participants/turns/status.
    const cid = item.querySelector(".conv-cid")!;
    expect(cid.textContent).toContain("cid:c1");
    expect(cid.getAttribute("title")).toBe("c1");
    // Locale-independent: only assert a non-empty formatted date/time
    // rendered (avoids pinning an exact locale string in CI).
    expect(item.textContent).toMatch(/\d{2}\/\d{2}.*\d{2}:\d{2}/);
  });

  it("started_at が null の行(サーバ未対応・欠測)は時刻を追加表示しない", async () => {
    const conn = makeConnection(async () => [
      {
        conversationId: "c2",
        participants: ["a", "b"],
        turns: 1,
        tokens: 10,
        status: "closed",
        startedAt: null,
      },
    ]);
    const { target } = await renderDrawer(vi.fn(), conn);
    await Promise.resolve();
    await tick();

    const meta = target.querySelector(".conv-meta")!;
    expect(meta.textContent).toContain("1 turns / closed");
    expect(meta.textContent).not.toMatch(/\d{2}\/\d{2}/);
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

  // issue #276 review follow-up (ふじ NB2): refreshConversations() is
  // re-entrant (refresh-button double-click, or a refresh racing a
  // close's own re-fetch) — a slower earlier reply must not clobber a
  // faster later one.
  it("更新の連打で古いレスポンスが新しいレスポンスを上書きしない (stale-reply race guard)", async () => {
    const rowFor = (cid: string): ConversationSummary[] => [
      {
        conversationId: cid,
        participants: ["a", "b"],
        turns: 1,
        tokens: 10,
        status: "open",
        startedAt: null,
      },
    ];

    const resolvers: Array<(v: ConversationSummary[]) => void> = [];
    let call = 0;
    const conn = makeConnection(() => {
      call += 1;
      if (call === 1) return Promise.resolve(rowFor("initial"));
      return new Promise((resolve) => resolvers.push(resolve));
    });

    const { target } = await renderDrawer(vi.fn(), conn);
    await Promise.resolve();
    await tick();
    expect(target.querySelector(".conv-cid")?.textContent).toContain(
      "initial",
    );

    // Double-click the refresh button — two overlapping listConversations
    // calls in flight.
    const refreshBtn = target.querySelector<HTMLButtonElement>(".refresh")!;
    refreshBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    refreshBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(resolvers).toHaveLength(2);

    // The SECOND (later) call resolves first.
    resolvers[1]!(rowFor("second"));
    await Promise.resolve();
    await tick();
    expect(target.querySelector(".conv-cid")?.textContent).toContain(
      "second",
    );

    // The FIRST (earlier) call resolves last — must NOT overwrite it.
    resolvers[0]!(rowFor("first"));
    await Promise.resolve();
    await tick();
    expect(target.querySelector(".conv-cid")?.textContent).toContain(
      "second",
    );
  });

  // issue #276 review round 2 (code-review-assessment BUG finding): the
  // mount effect's own initial fetch previously bypassed refreshSeq
  // entirely, so a slow mount-time reply landing after a faster refresh
  // click could still clobber fresher data — the exact race class the
  // test above claims to have closed, just via a second, un-integrated
  // call site. Pins that the mount fetch now shares the same guard.
  it("mount 時の初期取得と更新ボタンの race でも新しい結果が勝つ", async () => {
    const rowFor = (cid: string): ConversationSummary[] => [
      {
        conversationId: cid,
        participants: ["a", "b"],
        turns: 1,
        tokens: 10,
        status: "open",
        startedAt: null,
      },
    ];

    const resolvers: Array<(v: ConversationSummary[]) => void> = [];
    const conn = makeConnection(
      () => new Promise<ConversationSummary[]>((resolve) => resolvers.push(resolve)),
    );

    const { target } = await renderDrawer(vi.fn(), conn);
    await Promise.resolve();
    await tick();
    // The mount effect's own fetch is in flight (call 1, unresolved).
    expect(resolvers).toHaveLength(1);

    const refreshBtn = target.querySelector<HTMLButtonElement>(".refresh")!;
    refreshBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(resolvers).toHaveLength(2);

    // The refresh click (LATER call) resolves first.
    resolvers[1]!(rowFor("fresh"));
    await Promise.resolve();
    await tick();
    expect(target.querySelector(".conv-cid")?.textContent).toContain(
      "fresh",
    );

    // The mount fetch (EARLIER call) resolves last — must NOT overwrite it.
    resolvers[0]!(rowFor("stale-mount"));
    await Promise.resolve();
    await tick();
    expect(target.querySelector(".conv-cid")?.textContent).toContain(
      "fresh",
    );
  });

  // issue #276 manual close.
  describe("manual close", () => {
    it("open の会話にのみ閉じるボタンを表示する", async () => {
      const conn = makeConnection(async () => [
        {
          conversationId: "c1",
          participants: ["a", "b"],
          turns: 1,
          tokens: 10,
          status: "open",
          startedAt: null,
        },
        {
          conversationId: "c2",
          participants: ["c", "d"],
          turns: 2,
          tokens: 20,
          status: "closed",
          startedAt: null,
        },
      ]);
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();

      const items = target.querySelectorAll(".conv-list li");
      expect(items[0]!.querySelector(".conv-close")).not.toBeNull();
      expect(items[1]!.querySelector(".conv-close")).toBeNull();
    });

    it("閉じるボタン → 確認ダイアログ表示、キャンセルでは closeConversation を呼ばない", async () => {
      const conn = makeConnection(async () => [
        {
          conversationId: "c1",
          participants: ["a", "b"],
          turns: 1,
          tokens: 10,
          status: "open",
          startedAt: null,
        },
      ]);
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();

      target
        .querySelector<HTMLButtonElement>(".conv-close")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();

      const dialog = document.querySelector("dialog");
      expect(dialog).not.toBeNull();

      // issue #276 review follow-up (B1 residual): the confirm dialog
      // must identify WHICH conversation it targets — generic text alone
      // leaves an operator with multiple same-pair conversations unable
      // to tell them apart.
      expect(dialog!.textContent).toContain("cid:c1");
      expect(dialog!.textContent).toContain("a ⇔ b");

      const cancelButton = Array.from(
        dialog!.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => b.textContent?.includes("キャンセル"))!;
      cancelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();

      expect(document.querySelector("dialog")).toBeNull();
      expect(conn.closeConversation).not.toHaveBeenCalled();
    });

    // issue #276 review follow-up (B1 residual): pins that the confirm
    // dialog — and the closeConversation call it triggers — target the
    // CID of the clicked ROW, not just "whichever conversation matches
    // this pair". Two rows share participants but differ in cid; only
    // the second row's close button is clicked.
    it("同一 participants・異なる CID の 2 行がある場合、確認ダイアログとclose 呼び出しは対象行の CID を指す", async () => {
      const conn = makeConnection(async () => [
        {
          conversationId: "aaaaaaaa-1111",
          participants: ["gp.a", "gp.b"],
          turns: 1,
          tokens: 10,
          status: "open",
          startedAt: null,
        },
        {
          conversationId: "bbbbbbbb-2222",
          participants: ["gp.a", "gp.b"],
          turns: 4,
          tokens: 40,
          status: "open",
          startedAt: null,
        },
      ]);
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();

      const items = target.querySelectorAll(".conv-list li");
      expect(items).toHaveLength(2);

      items[1]!
        .querySelector<HTMLButtonElement>(".conv-close")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();

      const dialog = document.querySelector("dialog")!;
      expect(dialog.textContent).toContain("cid:bbbbbbbb");
      expect(dialog.textContent).not.toContain("aaaaaaaa");
      expect(dialog.textContent).toContain("gp.a ⇔ gp.b");

      dialog
        .querySelector<HTMLButtonElement>("button.danger")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await tick();

      expect(conn.closeConversation).toHaveBeenCalledWith("bbbbbbbb-2222");
      expect(conn.closeConversation).not.toHaveBeenCalledWith(
        "aaaaaaaa-1111",
      );
    });

    it("確認ダイアログの実行で closeConversation を呼び、一覧を再取得する", async () => {
      let call = 0;
      const conn = makeConnection(async () => {
        call += 1;
        const status = call === 1 ? "open" : "closed";
        return [
          {
            conversationId: "c1",
            participants: ["a", "b"],
            turns: 1,
            tokens: 10,
            status,
            startedAt: null,
          },
        ];
      });
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();

      target
        .querySelector<HTMLButtonElement>(".conv-close")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();

      const dialog = document.querySelector("dialog")!;
      dialog
        .querySelector<HTMLButtonElement>("button.danger")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await tick();

      expect(conn.closeConversation).toHaveBeenCalledWith("c1");
      expect(conn.listConversations).toHaveBeenCalledTimes(2);
      expect(document.querySelector("dialog")).toBeNull();
      expect(target.querySelector(".conv-meta")?.textContent).toContain(
        "closed",
      );
    });

    // issue #276 review follow-up (ふじ NB1): closeConversation's own doc
    // contract says the caller must re-fetch either way — a rejection can
    // mean someone else already closed it (conversation_closed) or TTL
    // beat us to it, and the row would otherwise sit stale at status=open
    // forever. Error stays visible; the list behind it still refreshes.
    it("close 失敗時はダイアログにエラーを表示しつつ、一覧を再取得する", async () => {
      const conn = makeConnection(
        async () => [
          {
            conversationId: "c1",
            participants: ["a", "b"],
            turns: 1,
            tokens: 10,
            status: "open",
            startedAt: null,
          },
        ],
        () => Promise.reject(new Error("conversation_closed")),
      );
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();

      target
        .querySelector<HTMLButtonElement>(".conv-close")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();

      const dialog = document.querySelector("dialog")!;
      dialog
        .querySelector<HTMLButtonElement>("button.danger")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await tick();

      expect(dialog.textContent).toContain("失敗しました");
      expect(dialog.textContent).toContain("conversation_closed");
      // Dialog stays open (director instruction: no accidental data-loss
      // pattern — a failed close must not silently vanish the modal).
      expect(document.querySelector("dialog")).not.toBeNull();
      expect(conn.listConversations).toHaveBeenCalledTimes(2);
    });
  });
});
