// @vitest-environment jsdom
// issue #277: SettingsDrawer migrated off its own hand-rolled
// backdrop+positioned-div onto the shared Modal.svelte primitive (issue
// #232 MF-3), keeping its own right-edge slide-in shape via a CSS escape
// hatch (`.settings-drawer-content { position: fixed; ... }`, director
// decision -- see SettingsDrawer.svelte's own style block for the full
// rationale) rather than a Modal.svelte extension. Modal.svelte's OWN
// mechanics are already pinned once, generically, in
// modal.integration.test.ts and modal.spec.ts (e2e) -- this file pins
// only the CALLER-level contract (autofocus target, dialog-click/cancel
// wiring), mirroring launchDialogModal.integration.test.ts's pattern.
// Escape-to-close, Tab-trap, and focus-restore themselves need a real
// browser (jsdom cannot simulate showModal()) -- covered in
// settingsDrawer.spec.ts (e2e), including the nested confirm-dialog case
// this migration newly introduces (a real <dialog> now sits INSIDE
// another real <dialog>, where it did not before).
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsDrawer from "../src/lib/SettingsDrawer.svelte";
import {
  DEFAULT_SETTINGS,
  updateSettings,
} from "../src/lib/settings.svelte";

// jsdom does not implement HTMLDialogElement.showModal/close (measured
// 2026-08-28, jsdom 29.1.1; same polyfill as modal.integration.test.ts).
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
  updateSettings(DEFAULT_SETTINGS);
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  localStorage.clear();
});

async function render(onClose = vi.fn()) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(SettingsDrawer, { target, props: { onClose } });
  mounted.push(component);
  await tick();
  return { target, onClose };
}

describe("SettingsDrawer on Modal.svelte (issue #277)", () => {
  it("Modal.svelte 経由で dialog を開く(独自 backdrop ではない)", async () => {
    const { target } = await render();

    const dialog = target.querySelector<HTMLDialogElement>("dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-label")).toBe("設定");
    expect(target.querySelector(".backdrop")).toBeNull();
  });

  // issue #277: showModal()'s spec-defined initial focus goes to the
  // first autofocus descendant -- pins that the "×" close button (always
  // rendered, same PersonaDetailDialog/LaunchDialog reasoning) carries
  // it.
  it("閉じるボタンに autofocus が設定されている(dialog の初期フォーカス対象)", async () => {
    const { target } = await render();

    expect(
      target.querySelector<HTMLButtonElement>("button.close")!.hasAttribute(
        "autofocus",
      ),
    ).toBe(true);
  });

  it("dialog 自身のクリック(背景相当)で onClose を呼ぶ", async () => {
    const { target, onClose } = await render();

    target
      .querySelector<HTMLElement>("dialog")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("`.modal-content` 内のクリックは onClose を呼ばない", async () => {
    const { target, onClose } = await render();

    target
      .querySelector<HTMLElement>("h2")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).not.toHaveBeenCalled();
  });

  // issue #277: the OLD backdrop's own onkeydown handler never actually
  // fired (a backdrop div is not normally focused) -- Modal.svelte's
  // native `cancel` handling is what now makes Escape work at all.
  it("cancel イベント(Escape 相当)で onClose を呼び、既定動作を防ぐ", async () => {
    const { target, onClose } = await render();

    const cancelEvent = new Event("cancel", { cancelable: true });
    target.querySelector<HTMLDialogElement>("dialog")!.dispatchEvent(cancelEvent);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancelEvent.defaultPrevented).toBe(true);
  });

  it("閉じるボタンのクリックで onClose を呼ぶ", async () => {
    const { target, onClose } = await render();

    target
      .querySelector<HTMLButtonElement>("button.close")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
