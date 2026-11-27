import "./isolation.setup";
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
import { installDialogShim, testModalCloseContract } from "./modalCloseContract";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsDrawer from "../src/lib/SettingsDrawer.svelte";
import {
  DEFAULT_SETTINGS,
  updateSettings,
} from "../src/lib/settings.svelte";

installDialogShim();

const mounted: object[] = [];

beforeEach(() => {
  localStorage.clear();
  // The UI language stays pinned to ja (locale.setup.ts); "auto" would read en in jsdom.
  updateSettings({ ...DEFAULT_SETTINGS, locale: "ja" });
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

  testModalCloseContract(render);

  it("閉じるボタンのクリックで onClose を呼ぶ", async () => {
    const { target, onClose } = await render();

    target
      .querySelector<HTMLButtonElement>("button.close")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
