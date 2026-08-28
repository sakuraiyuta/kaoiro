// @vitest-environment jsdom
// PersonaDetailDialog (issue #232): manifest.json の全メタデータ +
// personality.md 全文を fetchPersonaPackDetail 経由で表示する。読み込み中
// /失敗時の表示、close ボタン・backdrop クリックでの onClose、homepage の
// http(s) 限定リンク化を固定する。
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PersonaDetailDialog from "../src/lib/PersonaDetailDialog.svelte";
import { fetchPersonaPackDetail } from "../src/lib/protocol";
import type { PersonaPackDetail } from "../src/lib/protocol";

vi.mock("../src/lib/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/protocol")>();
  return { ...actual, fetchPersonaPackDetail: vi.fn() };
});

// jsdom does not implement HTMLDialogElement.showModal/close (measured
// 2026-08-28, jsdom 29.1.1: `dialog.showModal is not a function`) —
// Modal.svelte (issue #232 MF-3) calls showModal() on mount, so every
// test here needs this or mounting throws. Toggling `open` + firing
// `close` is enough for THESE tests (they check onClose wiring, not
// visual state); the browser's own focus-trap / initial-focus / Escape-
// cancel behaviour this polyfill cannot simulate is covered by e2e
// instead (modal.spec.ts).
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

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function detail(overrides: Partial<PersonaPackDetail> = {}): PersonaPackDetail {
  return {
    id: "fuji",
    name: "ふじ",
    sprite_set: "fuji",
    version: "1.0.2",
    license: "CC0-1.0",
    min_kaoiro_version: "0.1.0",
    states: ["idle", "thinking"],
    description: "説明文",
    author: "author-fuji",
    personality: "personality body",
    ...overrides,
  };
}

async function render(onClose = vi.fn()) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(PersonaDetailDialog, {
    target,
    props: { personaId: "fuji", onClose },
  });
  mounted.push(component);
  await tick();
  return { target, onClose };
}

describe("PersonaDetailDialog", () => {
  it("解決前は読み込み中を表示する", async () => {
    vi.mocked(fetchPersonaPackDetail).mockReturnValue(new Promise(() => {}));
    const { target } = await render();

    expect(target.querySelector(".note")?.textContent).toContain("読み込み中");
  });

  it("manifest 全メタデータと personality 全文を表示する", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(detail());
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    expect(fetchPersonaPackDetail).toHaveBeenCalledWith("fuji");
    expect(target.querySelector("h2")?.textContent).toBe("ふじ");
    const text = target.textContent ?? "";
    expect(text).toContain("fuji");
    expect(text).toContain("1.0.2");
    expect(text).toContain("CC0-1.0");
    expect(text).toContain("0.1.0");
    expect(text).toContain("idle, thinking");
    expect(text).toContain("説明文");
    expect(text).toContain("author-fuji");
    expect(target.querySelector(".personality")?.textContent).toBe(
      "personality body",
    );
  });

  it("任意フィールド (author/homepage) 欠落時はその行を出さない", async () => {
    // exactOptionalPropertyTypes: `detail({ author: undefined })` is a type
    // error (the key existing with an undefined value differs from the key
    // being absent) — omit the keys entirely instead of overriding them.
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue({
      id: "fuji",
      name: "ふじ",
      sprite_set: "fuji",
      version: "1.0.2",
      license: "CC0-1.0",
      min_kaoiro_version: "0.1.0",
      states: ["idle", "thinking"],
      personality: "personality body",
    });
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    expect(target.querySelector(".meta")?.textContent).not.toContain("author");
    expect(target.querySelector(".meta")?.textContent).not.toContain(
      "homepage",
    );
  });

  it("homepage が http(s) ならリンク化する", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(
      detail({ homepage: "https://example.test/fuji" }),
    );
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    const link = target.querySelector<HTMLAnchorElement>(".meta a");
    expect(link?.href).toBe("https://example.test/fuji");
    expect(link?.rel).toContain("noopener");
    expect(link?.target).toBe("_blank");
  });

  it("homepage が http(s) 以外ならリンク化せずテキストのまま表示する", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(
      detail({ homepage: "javascript:alert(1)" }),
    );
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    expect(target.querySelector(".meta a")).toBeNull();
    expect(target.querySelector(".meta")?.textContent).toContain(
      "javascript:alert(1)",
    );
  });

  // issue #232 S-2 (ふじ round-1 should-fix): a prefix regex would accept
  // "https://" (no host) as a match; new URL() rejects it outright
  // (Invalid URL — measured), which is the more accurate check since a
  // browser could never navigate there either.
  it("homepage が https:// (host 無し) ならリンク化しない", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(
      detail({ homepage: "https://" }),
    );
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    expect(target.querySelector(".meta a")).toBeNull();
    expect(target.querySelector(".meta")?.textContent).toContain("https://");
  });

  it("homepage がパース不能な文字列ならリンク化しない", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(
      detail({ homepage: "not a url" }),
    );
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    expect(target.querySelector(".meta a")).toBeNull();
    expect(target.querySelector(".meta")?.textContent).toContain("not a url");
  });

  it("取得失敗時はエラーメッセージを表示する", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(null);
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")?.textContent).toContain(
        "取得に失敗",
      );
    });
  });

  it("close ボタンで onClose を呼ぶ", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(detail());
    const { target, onClose } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    target
      .querySelector<HTMLButtonElement>("button.close")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // issue #232 MF-3: a native <dialog> has no separate backdrop element
  // (`::backdrop` is a pseudo-element) — Modal.svelte instead treats a
  // click whose target IS the <dialog> box itself (not bubbled up from
  // `.modal-content` inside it) as an outside click.
  it("dialog 自身のクリック (背景相当) で onClose を呼ぶ", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(detail());
    const { target, onClose } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    target
      .querySelector<HTMLElement>("dialog")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("`.modal-content` 内のクリックは onClose を呼ばない", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(detail());
    const { target, onClose } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    target
      .querySelector<HTMLElement>("h2")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).not.toHaveBeenCalled();
  });

  // issue #232 MF-3 (ふじ round-1 must-fix): Escape did nothing pre-fix.
  // A native <dialog> fires `cancel` on Escape; Modal.svelte's handler
  // must preventDefault (so the dialog does not close itself out of sync
  // with the caller's own open/closed state) AND route through onClose.
  it("cancel イベント (Escape 相当) で onClose を呼び、既定動作を防ぐ", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(detail());
    const { target, onClose } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    const cancelEvent = new Event("cancel", { cancelable: true });
    target.querySelector<HTMLDialogElement>("dialog")!.dispatchEvent(cancelEvent);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancelEvent.defaultPrevented).toBe(true);
  });

  // issue #232 MF-3: showModal()'s spec-defined initial focus goes to the
  // first autofocus descendant — this pins that the close button (a
  // sensible, always-present initial focus target) carries it.
  it("close ボタンに autofocus が設定されている (dialog の初期フォーカス対象)", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(detail());
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    expect(
      target.querySelector<HTMLButtonElement>("button.close")!.hasAttribute("autofocus"),
    ).toBe(true);
  });
});
