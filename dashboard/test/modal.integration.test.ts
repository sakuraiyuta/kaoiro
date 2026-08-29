// @vitest-environment jsdom
// Modal.svelte (issue #232 MF-3): shared modal primitive built on native
// <dialog>.showModal() — pins the mechanics every caller relies on
// (showModal on mount, focus restore on unmount, cancel/Escape wiring,
// outside-click detection, contentClass passthrough) directly, once,
// rather than re-testing them per caller (PersonaDetailDialog.svelte
// already covers the same contract indirectly).
import { createRawSnippet, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Modal from "../src/lib/Modal.svelte";

// jsdom does not implement HTMLDialogElement.showModal/close (measured
// 2026-08-28, jsdom 29.1.1). The browser's own focus-trap / initial-focus
// / Escape-cancel behaviour this polyfill cannot simulate is covered by
// e2e instead (modal.spec.ts).
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
});

function childrenSnippet(markup = '<button class="inside">inside</button>') {
  return createRawSnippet(() => ({
    render: () => `<div>${markup}</div>`,
  }));
}

async function render(props: {
  ariaLabel?: string;
  onClose?: () => void;
  contentClass?: string;
  markup?: string;
}) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(Modal, {
    target,
    props: {
      ariaLabel: props.ariaLabel ?? "test modal",
      onClose: props.onClose ?? vi.fn(),
      ...(props.contentClass !== undefined ? { contentClass: props.contentClass } : {}),
      children: childrenSnippet(props.markup),
    },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("Modal", () => {
  it("mount すると showModal() が呼ばれ dialog が open になる", async () => {
    const target = await render({});

    const dialog = target.querySelector<HTMLDialogElement>("dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.getAttribute("aria-label")).toBe("test modal");
  });

  it("children の内容を描画する", async () => {
    const target = await render({ markup: '<p class="probe">hello</p>' });

    expect(target.querySelector(".probe")?.textContent).toBe("hello");
  });

  it("contentClass を .modal-content に反映する", async () => {
    const target = await render({ contentClass: "custom-class" });

    const content = target.querySelector(".modal-content");
    expect(content?.classList.contains("custom-class")).toBe(true);
  });

  it("dialog 自身のクリックで onClose を呼ぶ", async () => {
    const onClose = vi.fn();
    const target = await render({ onClose });

    target
      .querySelector<HTMLElement>("dialog")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("`.modal-content` 内のクリックは onClose を呼ばない", async () => {
    const onClose = vi.fn();
    const target = await render({ onClose });

    target
      .querySelector<HTMLElement>(".inside")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).not.toHaveBeenCalled();
  });

  // issue #232 MF-3: measured directly in Chromium e2e that
  // showModal()'s native inert-outside-the-dialog behaviour does NOT
  // also wrap Tab from the last tabbable element back to the first (or
  // Shift+Tab from first to last) — focus simply vanished onto <body>.
  // Modal.svelte supplies the wraparound explicitly; these pin the
  // wraparound logic directly (jsdom cannot simulate the browser's own
  // Tab-driven focus movement, so the KeyboardEvent is dispatched by
  // hand and the resulting `.focus()` call is what is asserted).
  it("最後の focusable 要素で Tab を押すと最初の要素へ循環する", async () => {
    const target = await render({
      markup:
        '<button class="first">first</button><a href="https://example.test" class="last">last</a>',
    });
    const first = target.querySelector<HTMLElement>(".first")!;
    const last = target.querySelector<HTMLElement>(".last")!;
    last.focus();

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    target.querySelector("dialog")!.dispatchEvent(event);

    expect(document.activeElement).toBe(first);
    expect(event.defaultPrevented).toBe(true);
  });

  it("最初の focusable 要素で Shift+Tab を押すと最後の要素へ循環する", async () => {
    const target = await render({
      markup:
        '<button class="first">first</button><a href="https://example.test" class="last">last</a>',
    });
    const first = target.querySelector<HTMLElement>(".first")!;
    const last = target.querySelector<HTMLElement>(".last")!;
    first.focus();

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    target.querySelector("dialog")!.dispatchEvent(event);

    expect(document.activeElement).toBe(last);
    expect(event.defaultPrevented).toBe(true);
  });

  it("中間の focusable 要素での Tab は既定動作を妨げない", async () => {
    const target = await render({
      markup:
        '<button class="first">first</button>' +
        '<button class="middle">middle</button>' +
        '<a href="https://example.test" class="last">last</a>',
    });
    target.querySelector<HTMLElement>(".middle")!.focus();

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    target.querySelector("dialog")!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  // issue #232 MF-3 round-2 must-fix (MF-R2-2, ふじ Chromium probe): a
  // modal with zero focusable children (e.g. a still-loading detail)
  // broke showModal()'s native initial-focus fallback, letting Tab
  // escape the dialog. Modal.svelte focuses the dialog itself (tabindex
  // ="-1") as a fallback target, and Tab/Shift+Tab must retain focus
  // there rather than being left to the browser default.
  it("focusable 0 個なら mount 後 dialog 要素自体にフォーカスが当たる", async () => {
    const target = await render({ markup: "<p>no focusable content</p>" });

    const dialog = target.querySelector<HTMLDialogElement>("dialog")!;
    expect(document.activeElement).toBe(dialog);
  });

  it("focusable 0 個での Tab は既定動作を防ぎ、dialog 自身にフォーカスを保持する", async () => {
    const target = await render({ markup: "<p>no focusable content</p>" });
    const dialog = target.querySelector<HTMLDialogElement>("dialog")!;

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });

  it("focusable 0 個での Shift+Tab も既定動作を防ぎ、dialog 自身にフォーカスを保持する", async () => {
    const target = await render({ markup: "<p>no focusable content</p>" });
    const dialog = target.querySelector<HTMLDialogElement>("dialog")!;

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });

  it("cancel イベント (Escape 相当) で onClose を呼び、既定動作を防ぐ", async () => {
    const onClose = vi.fn();
    const target = await render({ onClose });

    const cancelEvent = new Event("cancel", { cancelable: true });
    target.querySelector<HTMLDialogElement>("dialog")!.dispatchEvent(cancelEvent);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancelEvent.defaultPrevented).toBe(true);
  });

  // issue #232 MF-3 (ふじ round-1 must-fix): closing previously left focus
  // on <body> (or wherever it fell once the trigger became inert) —
  // Modal.svelte snapshots document.activeElement at mount and restores
  // it on unmount.
  it("unmount 時、mount 前にフォーカスしていた要素へフォーカスを戻す", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "open modal";
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Modal, {
      target,
      props: { ariaLabel: "test modal", onClose: vi.fn(), children: childrenSnippet() },
    });
    await tick();

    await unmount(component);

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("trigger 要素が既に DOM から外れていれば無理にフォーカスしない", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Modal, {
      target,
      props: { ariaLabel: "test modal", onClose: vi.fn(), children: childrenSnippet() },
    });
    await tick();

    trigger.remove();
    // Should not throw even though the remembered trigger is gone.
    await expect(unmount(component)).resolves.toBeUndefined();
  });
});
