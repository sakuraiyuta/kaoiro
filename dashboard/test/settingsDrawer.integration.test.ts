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
import type {
  ConversationSummary,
  KaoiroConnection,
  UserSummary,
} from "../src/lib/protocol";
import { makeReactiveSettingsDrawerProps } from "./reactiveProps.svelte";

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
 *  manual close don't need to supply one. `users`/`rename` (issue #207)
 *  default the same way -- every existing call site that only cares
 *  about conversations still mounts cleanly, since SettingsDrawer's
 *  mount effect now ALSO calls listUsers() unconditionally whenever
 *  connection is truthy. */
function makeConnection(
  list: () => Promise<ConversationSummary[]>,
  close: (cid: string) => Promise<void> = () => Promise.resolve(),
  users: () => Promise<UserSummary[]> = () => Promise.resolve([]),
  rename: (userId: string, name: string) => Promise<void> = () =>
    Promise.resolve(),
) {
  return {
    listConversations: vi.fn(list),
    closeConversation: vi.fn(close),
    listUsers: vi.fn(users),
    renameUser: vi.fn(rename),
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

  // issue #276 review follow-up (ふじ round2 B2): the shared refreshSeq
  // guard only advances on `if (connection) refreshConversations()` —
  // a connection loss (truthy -> undefined) skips that branch and never
  // bumped the sequence, so an in-flight reply from BEFORE the loss could
  // still land while connection was undefined and silently populate
  // `conversations`, then flash as stale data the moment connection
  // becomes truthy again (before the fresh reconnect fetch resolves).
  // Needs a reactive props object (plain mount() props are static) to
  // flip `connection` on an already-mounted instance.
  it("connection 消失中に着地した古い応答は、再接続直後の表示に漏れ出さない (stale-leak race guard)", async () => {
    const resolvers: Array<(v: ConversationSummary[]) => void> = [];
    const conn = makeConnection(
      () => new Promise<ConversationSummary[]>((resolve) => resolvers.push(resolve)),
    );

    const target = document.createElement("div");
    document.body.append(target);
    const props = makeReactiveSettingsDrawerProps({
      onClose: vi.fn(),
      connection: conn,
    });
    const component = mount(SettingsDrawer, { target, props });
    mounted.push(component);
    await tick();
    // Mount effect's own fetch is in flight (call 1, unresolved).
    expect(resolvers).toHaveLength(1);

    // connection lost mid-flight (e.g. operator status revoked).
    props.connection = undefined;
    await tick();
    expect(target.querySelector(".conversations")).toBeNull();

    // The pre-loss request resolves WHILE connection is undefined — with
    // the bug this silently writes into `conversations` (invisible right
    // now since the section is hidden).
    resolvers[0]!([
      {
        conversationId: "leaked-while-disconnected",
        participants: ["a", "b"],
        turns: 1,
        tokens: 10,
        status: "open",
        startedAt: null,
      },
    ]);
    await Promise.resolve();
    await tick();

    // Reconnect, before the fresh fetch resolves.
    props.connection = conn;
    await tick();
    expect(resolvers).toHaveLength(2);

    // Must show the loading state, NOT the leaked row, while the fresh
    // reconnect fetch (call 2) is still pending.
    expect(target.querySelector(".conv-status")?.textContent).toContain(
      "読み込み中",
    );
    expect(target.textContent).not.toContain("leaked-while-disconnected");

    resolvers[1]!([
      {
        conversationId: "fresh-after-reconnect",
        participants: ["a", "b"],
        turns: 1,
        tokens: 10,
        status: "open",
        startedAt: null,
      },
    ]);
    await Promise.resolve();
    await tick();
    // .conv-cid renders only the first 8 chars; the full id lives in
    // `title` (same convention as the round-1 row-display fix).
    expect(
      target.querySelector(".conv-cid")?.getAttribute("title"),
    ).toBe("fresh-after-reconnect");
  });

  // issue #276 review follow-up (こはく advisory, round4): the seq bump
  // in the effect cleanup only invalidates an in-flight REPLY -- it does
  // NOT reset whatever list is already rendered. A connection-IDENTITY
  // change (not just loss -- e.g. a genuine reconnect to a new socket, or
  // App.svelte's isOperator flapping false->true across a rejoin) must
  // not keep showing the PREVIOUS generation's resolved list while the
  // new generation's fetch is still pending.
  it("connection 世代が変わると、直前の世代で取得済みだった一覧を保持せず読み込み中に戻す (stale-display reset)", async () => {
    const conn1 = makeConnection(async () => [
      {
        conversationId: "gen1-row",
        participants: ["a", "b"],
        turns: 1,
        tokens: 10,
        status: "open",
        startedAt: null,
      },
    ]);

    const target = document.createElement("div");
    document.body.append(target);
    const props = makeReactiveSettingsDrawerProps({
      onClose: vi.fn(),
      connection: conn1,
    });
    const component = mount(SettingsDrawer, { target, props });
    mounted.push(component);
    await Promise.resolve();
    await tick();
    expect(target.querySelector(".conv-cid")?.textContent).toContain(
      "gen1-row",
    );

    // A DIFFERENT connection object -- a genuine new generation, not a
    // mere loss/undefined -- whose fetch is deliberately left pending.
    const resolvers: Array<(v: ConversationSummary[]) => void> = [];
    const conn2 = makeConnection(
      () => new Promise<ConversationSummary[]>((resolve) => resolvers.push(resolve)),
    );
    props.connection = conn2;
    await tick();

    // Must show the loading state, NOT the previous generation's row,
    // while conn2's fetch is still in flight.
    expect(target.querySelector(".conv-status")?.textContent).toContain(
      "読み込み中",
    );
    expect(target.textContent).not.toContain("gen1-row");

    resolvers[0]!([
      {
        conversationId: "gen2-row",
        participants: ["a", "b"],
        turns: 1,
        tokens: 10,
        status: "open",
        startedAt: null,
      },
    ]);
    await Promise.resolve();
    await tick();
    expect(target.querySelector(".conv-cid")?.textContent).toContain(
      "gen2-row",
    );
  });

  // issue #276 review follow-up (ふじ round2 B2): the resolve-side guard
  // (test above/earlier) was pinned, but the CATCH side never got its own
  // regression test — an older request's rejection landing after a newer
  // request's success must not roll the display back to an error.
  it("古いリクエストの失敗が新しいリクエストの成功の後に着地しても error 表示へ巻き戻らない (stale-reject race guard)", async () => {
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

    const settlers: Array<{
      resolve: (v: ConversationSummary[]) => void;
      reject: (err: unknown) => void;
    }> = [];
    const conn = makeConnection(
      () =>
        new Promise<ConversationSummary[]>((resolve, reject) => {
          settlers.push({ resolve, reject });
        }),
    );

    const { target } = await renderDrawer(vi.fn(), conn);
    await Promise.resolve();
    await tick();
    // Mount fetch (call 1, unresolved).
    expect(settlers).toHaveLength(1);

    const refreshBtn = target.querySelector<HTMLButtonElement>(".refresh")!;
    refreshBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(settlers).toHaveLength(2);

    // The refresh click (LATER call) succeeds first.
    settlers[1]!.resolve(rowFor("fresh"));
    await Promise.resolve();
    await tick();
    expect(target.querySelector(".conv-cid")?.textContent).toContain(
      "fresh",
    );

    // The mount fetch (EARLIER call) fails last — must NOT roll the
    // display back to the error state.
    settlers[0]!.reject(new Error("stale-failure"));
    await Promise.resolve();
    await tick();
    expect(target.querySelector(".conv-cid")?.textContent).toContain(
      "fresh",
    );
    expect(target.querySelector(".conv-status")).toBeNull();
  });

  // issue #276 manual close.
  //
  // issue #277: SettingsDrawer's OWN chrome is now also a <dialog>
  // (Modal.svelte), rendered as long as the drawer itself is mounted —
  // `document.querySelector("dialog")` alone no longer distinguishes
  // "confirm dialog open" from "just the drawer". Every lookup below is
  // scoped to `dialog[aria-label="会話を閉じる確認"]`, the confirm
  // dialog's own aria-label, so it specifically targets that nested
  // dialog rather than the outer drawer one.
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

      const dialog = document.querySelector('dialog[aria-label="会話を閉じる確認"]');
      expect(dialog).not.toBeNull();

      // issue #276 review follow-up (B1 residual): the confirm dialog
      // must identify WHICH conversation it targets — generic text alone
      // leaves an operator with multiple same-pair conversations unable
      // to tell them apart.
      expect(dialog!.textContent).toContain("cid:c1");
      expect(dialog!.textContent).toContain("a ⇔ b");

      // issue #277: showModal()'s spec-defined initial focus goes to the
      // first autofocus descendant -- pins that the confirm dialog's
      // Cancel button (safe, non-destructive) carries it, not the
      // destructive "閉じる" action. e2e (settingsDrawer.spec.ts) pins
      // that this is actually where focus lands in a real browser.
      expect(
        dialog!.querySelector<HTMLButtonElement>("button.cancel")!.hasAttribute(
          "autofocus",
        ),
      ).toBe(true);

      const cancelButton = Array.from(
        dialog!.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => b.textContent?.includes("キャンセル"))!;
      cancelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();

      expect(document.querySelector('dialog[aria-label="会話を閉じる確認"]')).toBeNull();
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

      const dialog = document.querySelector('dialog[aria-label="会話を閉じる確認"]')!;
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

      const dialog = document.querySelector('dialog[aria-label="会話を閉じる確認"]')!;
      dialog
        .querySelector<HTMLButtonElement>("button.danger")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await tick();

      expect(conn.closeConversation).toHaveBeenCalledWith("c1");
      expect(conn.listConversations).toHaveBeenCalledTimes(2);
      expect(document.querySelector('dialog[aria-label="会話を閉じる確認"]')).toBeNull();
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

      const dialog = document.querySelector('dialog[aria-label="会話を閉じる確認"]')!;
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
      expect(document.querySelector('dialog[aria-label="会話を閉じる確認"]')).not.toBeNull();
      expect(conn.listConversations).toHaveBeenCalledTimes(2);
    });

    // issue #277 (advisory carried over from issue #276 round4, ふじ
    // 判定/こはく同意): the effect cleanup that resets conversations/
    // error on a connection-identity change previously left the confirm
    // modal's own state (confirmCloseTarget/closeError/closing)
    // untouched -- pins that a connection change now closes the confirm
    // dialog outright rather than leaving it pointing at a row from the
    // PREVIOUS generation.
    describe("connection 世代変更時のガード (issue #277)", () => {
      it("確認ダイアログを開いたまま connection が離脱→復帰すると、旧 target のまま再表示されない", async () => {
        // Two DISTINCT rows across the two connections -- if the confirm
        // modal reappears with c1 (the STALE target) once connB comes
        // back, that is exactly the "旧 target で再表示される" defect
        // こはく described. A weaker version of this test that only
        // asserts "hidden while connection is undefined" would pass even
        // WITHOUT the fix, since `{#if connection && confirmCloseTarget}`
        // already hides it whenever connection alone is falsy -- the
        // return-to-truthy half is what actually distinguishes the fix.
        const connA = makeConnection(async () => [
          {
            conversationId: "c1",
            participants: ["a", "b"],
            turns: 1,
            tokens: 10,
            status: "open",
            startedAt: null,
          },
        ]);
        const connB = makeConnection(async () => [
          {
            conversationId: "c2",
            participants: ["c", "d"],
            turns: 1,
            tokens: 10,
            status: "open",
            startedAt: null,
          },
        ]);
        const target = document.createElement("div");
        document.body.append(target);
        const props = makeReactiveSettingsDrawerProps({
          onClose: vi.fn(),
          connection: connA,
        });
        const component = mount(SettingsDrawer, { target, props });
        mounted.push(component);
        await Promise.resolve();
        await tick();

        target
          .querySelector<HTMLButtonElement>(".conv-close")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await tick();
        expect(
          document.querySelector('dialog[aria-label="会話を閉じる確認"]')!
            .textContent,
        ).toContain("cid:c1");

        // Connection lost (e.g. isOperator flap on rejoin) -- the effect
        // cleanup fires.
        props.connection = undefined;
        await tick();
        expect(
          document.querySelector('dialog[aria-label="会話を閉じる確認"]'),
        ).toBeNull();

        // Connection comes back as a DIFFERENT generation (connB) before
        // the operator does anything else. Without the cleanup resetting
        // confirmCloseTarget, it would still hold row c1 and the modal
        // would flash back into view with that stale target.
        props.connection = connB;
        await Promise.resolve();
        await tick();

        expect(
          document.querySelector('dialog[aria-label="会話を閉じる確認"]'),
        ).toBeNull();
      });

      // issue #277: pins the handleConfirmClose half of the same guard --
      // a close still in flight for the OLD generation must not clobber
      // a DIFFERENT close already started in the NEW generation once the
      // stale promise resolves.
      it("旧 generation の close 結果が新 generation の close 中の state を巻き戻さない", async () => {
        const rowA: ConversationSummary = {
          conversationId: "c-a",
          participants: ["a", "b"],
          turns: 1,
          tokens: 10,
          status: "open",
          startedAt: null,
        };
        const rowB: ConversationSummary = {
          conversationId: "c-b",
          participants: ["c", "d"],
          turns: 1,
          tokens: 10,
          status: "open",
          startedAt: null,
        };

        let resolveCloseA: (() => void) | null = null;
        const connA = makeConnection(
          async () => [rowA],
          () => new Promise<void>((resolve) => (resolveCloseA = resolve)),
        );
        let resolveCloseB: (() => void) | null = null;
        const connB = makeConnection(
          async () => [rowB],
          () => new Promise<void>((resolve) => (resolveCloseB = resolve)),
        );

        const target = document.createElement("div");
        document.body.append(target);
        const props = makeReactiveSettingsDrawerProps({
          onClose: vi.fn(),
          connection: connA,
        });
        const component = mount(SettingsDrawer, { target, props });
        mounted.push(component);
        await Promise.resolve();
        await tick();

        // Generation A: open the confirm dialog and start closing --
        // never resolves yet.
        target
          .querySelector<HTMLButtonElement>(".conv-close")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await tick();
        document
          .querySelector<HTMLButtonElement>(
            'dialog[aria-label="会話を閉じる確認"] button.danger',
          )!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await tick();
        expect(resolveCloseA).not.toBeNull();

        // Connection changes to generation B -- the cleanup resets the
        // confirm-modal state; connA's close is still in flight.
        props.connection = connB;
        await Promise.resolve();
        await tick();
        expect(
          document.querySelector('dialog[aria-label="会話を閉じる確認"]'),
        ).toBeNull();

        // Generation B: open ITS OWN confirm dialog and start closing --
        // also never resolves yet.
        await Promise.resolve();
        await tick();
        target
          .querySelector<HTMLButtonElement>(".conv-close")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await tick();
        document
          .querySelector<HTMLButtonElement>(
            'dialog[aria-label="会話を閉じる確認"] button.danger',
          )!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await tick();
        expect(resolveCloseB).not.toBeNull();

        const dialogB = document.querySelector(
          'dialog[aria-label="会話を閉じる確認"]',
        )!;
        expect(
          dialogB.querySelector<HTMLButtonElement>("button.danger")!.disabled,
        ).toBe(true);

        // The STALE generation-A close now resolves. Without the guard,
        // its `finally` block would set closing=false and re-fetch on
        // top of generation B's still-in-flight close.
        resolveCloseA!();
        await Promise.resolve();
        await Promise.resolve();
        await tick();

        // Generation B's close must still be reported as in-flight --
        // unaffected by the stale generation-A resolution.
        expect(
          dialogB.querySelector<HTMLButtonElement>("button.danger")!.disabled,
        ).toBe(true);
        expect(
          document.querySelector('dialog[aria-label="会話を閉じる確認"]'),
        ).not.toBeNull();

        // Generation B's own close now resolves -- THIS is what should
        // close the dialog.
        resolveCloseB!();
        await Promise.resolve();
        await Promise.resolve();
        await tick();

        expect(
          document.querySelector('dialog[aria-label="会話を閉じる確認"]'),
        ).toBeNull();
      });
    });
  });

  // issue #207: operator-facing user list + inline rename. Mirrors the
  // conversations describe block above's depth (render/empty/error/
  // refresh), plus renameAgent.integration.test.ts's submit/error/
  // generation-guard idioms adapted to this component's inline (no
  // popover) editing UI.
  describe("ユーザー一覧 (issue #207)", () => {
    it("connection 指定時、取得したユーザー一覧を id/kind/display_name/role で表示する", async () => {
      const conn = makeConnection(
        async () => [],
        undefined,
        async () => [
          { id: "u1", kind: "user", displayName: "あお", role: "operator" },
        ],
      );
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();

      expect(conn.listUsers).toHaveBeenCalledTimes(1);
      const item = target.querySelector(".user-list li")!;
      expect(item.textContent).toContain("あお");
      expect(item.textContent).toContain("user / operator");

      const id = item.querySelector(".user-id")!;
      expect(id.textContent).toContain("id:u1");
      expect(id.getAttribute("title")).toBe("u1");
    });

    it("ユーザーが 0 件なら空である旨を表示する", async () => {
      const conn = makeConnection(async () => [], undefined, async () => []);
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();

      expect(target.querySelector(".user-status")?.textContent).toContain(
        "登録されているユーザーはいません",
      );
    });

    it("ユーザー一覧の取得失敗時はエラー文言を表示する", async () => {
      const conn = makeConnection(
        async () => [],
        undefined,
        () => Promise.reject(new Error("forbidden")),
      );
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();

      expect(target.querySelector(".user-status")?.textContent).toContain(
        "forbidden",
      );
    });

    it("ユーザー一覧の更新ボタンで再取得する (会話一覧の更新ボタンとは独立)", async () => {
      const conn = makeConnection(async () => [], undefined, async () => []);
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();
      expect(conn.listUsers).toHaveBeenCalledTimes(1);
      expect(conn.listConversations).toHaveBeenCalledTimes(1);

      // aria-label で選ぶ (会話一覧の更新ボタンと同じ class="refresh" を
      // 共有するため、position ではなく label で一意に選ぶ必要がある)。
      target
        .querySelector<HTMLButtonElement>(
          'button[aria-label="ユーザー一覧を更新"]',
        )!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await tick();

      expect(conn.listUsers).toHaveBeenCalledTimes(2);
      // The conversations refresh must not have been triggered by this
      // click — the two sections' refresh buttons are independent.
      expect(conn.listConversations).toHaveBeenCalledTimes(1);
    });

    // code-review-assessment (issue #207 round 2, must-fix 4): mirrors
    // "更新の連打で古いレスポンスが新しいレスポンスを上書きしない
    // (stale-reply race guard)" above, pinning that usersRefreshSeq (a
    // SEPARATE counter from refreshSeq) closes the same class of race
    // for the users section independently.
    it("ユーザー一覧の更新連打で古いレスポンスが新しいレスポンスを上書きしない (usersRefreshSeq stale-reply race guard)", async () => {
      const userFor = (id: string): UserSummary[] => [
        { id, kind: "user", displayName: id, role: "operator" },
      ];

      const resolvers: Array<(v: UserSummary[]) => void> = [];
      let call = 0;
      const conn = makeConnection(
        async () => [],
        undefined,
        () => {
          call += 1;
          if (call === 1) return Promise.resolve(userFor("initial"));
          return new Promise((resolve) => resolvers.push(resolve));
        },
      );

      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();
      expect(target.querySelector(".user-id")?.textContent).toContain(
        "initial",
      );

      // Double-click the users refresh button -- two overlapping
      // listUsers calls in flight.
      const refreshBtn = target.querySelector<HTMLButtonElement>(
        'button[aria-label="ユーザー一覧を更新"]',
      )!;
      refreshBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      refreshBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();
      expect(resolvers).toHaveLength(2);

      // The SECOND (later) call resolves first.
      resolvers[1]!(userFor("second"));
      await Promise.resolve();
      await tick();
      expect(target.querySelector(".user-id")?.textContent).toContain(
        "second",
      );

      // The FIRST (earlier) call resolves last — must NOT overwrite it.
      resolvers[0]!(userFor("first"));
      await Promise.resolve();
      await tick();
      expect(target.querySelector(".user-id")?.textContent).toContain(
        "second",
      );
    });

    it("名前を変更ボタンで編集モードに入り、現在の表示名が入力欄の初期値になる", async () => {
      const conn = makeConnection(
        async () => [],
        undefined,
        async () => [
          { id: "u1", kind: "user", displayName: "あお", role: "operator" },
        ],
      );
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();

      target
        .querySelector<HTMLButtonElement>(".user-action")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();

      const input = target.querySelector<HTMLInputElement>(
        '.user-rename-row input[type="text"]',
      )!;
      expect(input.value).toBe("あお");
    });

    it("キャンセルで編集モードを閉じ、renameUser を呼ばない", async () => {
      const conn = makeConnection(
        async () => [],
        undefined,
        async () => [
          { id: "u1", kind: "user", displayName: "あお", role: "operator" },
        ],
      );
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();

      target
        .querySelector<HTMLButtonElement>(".user-action")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();

      const buttons = target.querySelectorAll<HTMLButtonElement>(
        ".user-rename-row button",
      );
      buttons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();

      expect(target.querySelector(".user-rename-row")).toBeNull();
      expect(conn.renameUser).not.toHaveBeenCalled();
    });

    it("保存で renameUser(userId, name) を 1 回呼び、成功後は編集モードを閉じて一覧を再取得する", async () => {
      let fetchCount = 0;
      const conn = makeConnection(
        async () => [],
        undefined,
        async () => {
          fetchCount += 1;
          return [
            { id: "u1", kind: "user", displayName: "あお", role: "operator" },
          ];
        },
        vi.fn(() => Promise.resolve()),
      );
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();
      expect(fetchCount).toBe(1);

      target
        .querySelector<HTMLButtonElement>(".user-action")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();

      const input = target.querySelector<HTMLInputElement>(
        '.user-rename-row input[type="text"]',
      )!;
      input.value = "あお(改)";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();

      target
        .querySelectorAll<HTMLButtonElement>(".user-rename-row button")[0]!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await tick();

      expect(conn.renameUser).toHaveBeenCalledTimes(1);
      expect(conn.renameUser).toHaveBeenCalledWith("u1", "あお(改)");
      expect(target.querySelector(".user-rename-row")).toBeNull();
      // Re-fetched (issue #207 design decision: same refresh-on-mutation
      // contract as closeConversation, success or failure alike).
      expect(fetchCount).toBe(2);
    });

    it("保存が reject された場合はエラーを表示し、編集モードは維持したまま一覧は再取得する", async () => {
      let fetchCount = 0;
      const conn = makeConnection(
        async () => [],
        undefined,
        async () => {
          fetchCount += 1;
          return [
            { id: "u1", kind: "user", displayName: "あお", role: "operator" },
          ];
        },
        vi.fn(() => Promise.reject(new Error("invalid_name"))),
      );
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();
      expect(fetchCount).toBe(1);

      target
        .querySelector<HTMLButtonElement>(".user-action")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();

      target
        .querySelectorAll<HTMLButtonElement>(".user-rename-row button")[0]!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await tick();

      expect(target.querySelector(".user-status")?.textContent).toContain(
        "invalid_name",
      );
      // Failure leaves the edit form open (mirrors the manual-close
      // confirm dialog's own "no accidental data-loss" behaviour) --
      // the operator sees the error next to the input and can retry
      // without reopening.
      expect(target.querySelector(".user-rename-row")).not.toBeNull();
      expect(fetchCount).toBe(2);
    });

    // code-review-assessment (issue #207, round 1): renamingUserId/
    // renameError/renaming are single, component-wide state -- not
    // scoped per row -- and (unlike closeConversation's native <dialog>
    // confirm modal) the inline rename form has no structural barrier
    // blocking interaction with a different row while a save is in
    // flight. Without the disabled guard, switching to a different
    // row's edit mid-save would misread the still-true `renaming` flag
    // as belonging to the NEW row, then have the original save's
    // continuation silently close/misattribute-error onto that new row.
    it("別行の保存が in-flight の間は他行の名前を変更ボタンを disable する (クロス行競合ガード)", async () => {
      let resolveRename: (() => void) | null = null;
      const conn = makeConnection(
        async () => [],
        undefined,
        async () => [
          { id: "u1", kind: "user", displayName: "A", role: "operator" },
          { id: "u2", kind: "user", displayName: "B", role: "operator" },
        ],
        () => new Promise<void>((resolve) => (resolveRename = resolve)),
      );
      const { target } = await renderDrawer(vi.fn(), conn);
      await Promise.resolve();
      await tick();

      const beforeButtons = target.querySelectorAll<HTMLButtonElement>(
        ".user-action",
      );
      expect(beforeButtons.length).toBe(2);

      // Open A's edit form and start saving -- never resolves yet.
      beforeButtons[0]!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await tick();
      target
        .querySelectorAll<HTMLButtonElement>(".user-rename-row button")[0]!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();

      // A's own row switched to the edit form, so only B's `.user-action`
      // remains in the DOM -- it must be disabled while A's save is
      // still in flight.
      const bButton = target.querySelector<HTMLButtonElement>(
        ".user-action",
      )!;
      expect(bButton.textContent).toContain("名前を変更");
      expect(bButton.disabled).toBe(true);

      resolveRename!();
      await Promise.resolve();
      await Promise.resolve();
      await tick();

      // A's save resolved -- its edit form closes and B's button is
      // re-enabled, with B's row untouched throughout.
      expect(target.querySelector(".user-rename-row")).toBeNull();
      expect(
        target.querySelector<HTMLButtonElement>(".user-action")!.disabled,
      ).toBe(false);
    });

    // issue #207: mirrors "connection 世代変更時のガード (issue #277)"
    // above, adapted to the inline rename form's own state
    // (renamingUserId/renameError) instead of the confirm-close modal's.
    it("編集中に connection が離脱→別世代で復帰すると、旧 target の編集モードは残らない", async () => {
      const connA = makeConnection(
        async () => [],
        undefined,
        async () => [
          { id: "u1", kind: "user", displayName: "A", role: "operator" },
        ],
      );
      // SAME user id as generation A on purpose: this is what actually
      // exercises the reset. If renamingUserId ("u1") survived the
      // generation change unreset, generation B's list ALSO contains a
      // "u1" row, so `renamingUserId === u.id` would incorrectly re-open
      // the edit form for it (bound to generation A's stale renameDraft/
      // renameError) — a weaker fixture using a different id would make
      // {#if renamingUserId === u.id} fail regardless of the reset,
      // proving nothing about it.
      const connB = makeConnection(
        async () => [],
        undefined,
        async () => [
          { id: "u1", kind: "user", displayName: "A(別世代)", role: "operator" },
        ],
      );
      const target = document.createElement("div");
      document.body.append(target);
      const props = makeReactiveSettingsDrawerProps({
        onClose: vi.fn(),
        connection: connA,
      });
      const component = mount(SettingsDrawer, { target, props });
      mounted.push(component);
      await Promise.resolve();
      await tick();

      target
        .querySelector<HTMLButtonElement>(".user-action")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();
      expect(target.querySelector(".user-rename-row")).not.toBeNull();

      // Connection lost (e.g. isOperator flap on rejoin) -- the effect
      // cleanup fires.
      props.connection = undefined;
      await tick();
      expect(target.querySelector(".user-rename-row")).toBeNull();

      // Connection comes back as a DIFFERENT generation (connB), still
      // addressing "u1", before the operator does anything else.
      props.connection = connB;
      await Promise.resolve();
      await tick();

      expect(target.querySelector(".user-rename-row")).toBeNull();
      const item = target.querySelector(".user-list li")!;
      expect(item.textContent).toContain("A(別世代)");
    });

    // code-review-assessment (issue #207 round 2, must-fix 4): the test
    // above swaps connection WHILE no save is in flight. This one pins
    // the case ふじ specified directly — generation A's renameUser()
    // call is still PENDING when the connection swaps to generation B,
    // generation B then starts its OWN save for the SAME user id, and
    // ONLY THEN does generation A's stale call settle. Without the
    // `generation === connectionGeneration` guard in submitRename's
    // continuation, A's late settlement would close/error generation
    // B's still-in-flight save out from under it.
    describe("世代切替中に in-flight だった旧 generation の rename 結果が新 generation の save を巻き戻さない", () => {
      function makeGenerationRace() {
        let resolveA: (() => void) | null = null;
        let rejectA: ((err: Error) => void) | null = null;
        const connA = makeConnection(
          async () => [],
          undefined,
          async () => [
            { id: "u1", kind: "user", displayName: "A-name", role: "operator" },
          ],
          () =>
            new Promise<void>((resolve, reject) => {
              resolveA = resolve;
              rejectA = reject;
            }),
        );

        let resolveB: (() => void) | null = null;
        let rejectB: ((err: Error) => void) | null = null;
        const connB = makeConnection(
          async () => [],
          undefined,
          async () => [
            { id: "u1", kind: "user", displayName: "B-name", role: "operator" },
          ],
          () =>
            new Promise<void>((resolve, reject) => {
              resolveB = resolve;
              rejectB = reject;
            }),
        );

        return {
          connA,
          connB,
          resolveA: () => resolveA!(),
          rejectA: (err: Error) => rejectA!(err),
          resolveB: () => resolveB!(),
          rejectB: (err: Error) => rejectB!(err),
        };
      }

      async function startRaceUpToBSave() {
        const race = makeGenerationRace();
        const target = document.createElement("div");
        document.body.append(target);
        const props = makeReactiveSettingsDrawerProps({
          onClose: vi.fn(),
          connection: race.connA,
        });
        const component = mount(SettingsDrawer, { target, props });
        mounted.push(component);
        await Promise.resolve();
        await tick();

        // Generation A: open u1's edit form and start saving -- never
        // resolves yet.
        target
          .querySelector<HTMLButtonElement>(".user-action")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await tick();
        target
          .querySelectorAll<HTMLButtonElement>(".user-rename-row button")[0]!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await tick();

        // Connection swaps DIRECTLY to generation B (no undefined step
        // in between) while A's save is still pending.
        props.connection = race.connB;
        await Promise.resolve();
        await tick();

        // Generation B: open the SAME user's edit form and start ITS
        // OWN save -- also never resolves yet.
        target
          .querySelector<HTMLButtonElement>(".user-action")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await tick();
        target
          .querySelectorAll<HTMLButtonElement>(".user-rename-row button")[0]!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await tick();

        return { race, target };
      }

      it("A の成功が着弾しても B の save 中は閉じない・B の save は成功で正しく閉じる", async () => {
        const { race, target } = await startRaceUpToBSave();

        // A's stale save resolves NOW, after B's own save already
        // started. Must be a no-op against B's in-flight state.
        race.resolveA();
        await Promise.resolve();
        await Promise.resolve();
        await tick();

        expect(target.querySelector(".user-rename-row")).not.toBeNull();
        expect(
          target.querySelector<HTMLButtonElement>(
            ".user-rename-row button",
          )!.disabled,
        ).toBe(true);

        // B's own save now resolves -- THIS is what should close the
        // form.
        race.resolveB();
        await Promise.resolve();
        await Promise.resolve();
        await tick();

        expect(target.querySelector(".user-rename-row")).toBeNull();
      });

      it("A の失敗が着弾しても B の save 中は影響しない・B の失敗は B の行にだけ表示される", async () => {
        const { race, target } = await startRaceUpToBSave();

        // A's stale save REJECTS now. Must not write A's error onto B's
        // still-in-flight row.
        race.rejectA(new Error("A の失敗"));
        await Promise.resolve();
        await Promise.resolve();
        await tick();

        expect(target.querySelector(".user-rename-row")).not.toBeNull();
        // A's stale reject must not have set renameError at all -- if it
        // had, `.user-status` would render under B's row (see the {#if
        // renameError} block just below the rename form).
        expect(target.querySelector(".user-status")).toBeNull();

        // B's own save now rejects -- its error, and only its error,
        // must surface.
        race.rejectB(new Error("B の失敗"));
        await Promise.resolve();
        await Promise.resolve();
        await tick();

        expect(target.querySelector(".user-rename-row")).not.toBeNull();
        expect(target.querySelector(".user-status")?.textContent).toContain(
          "B の失敗",
        );
      });
    });
  });
});
