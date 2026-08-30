// @vitest-environment jsdom
// issue #277: LaunchDialog migrated off its own hand-rolled
// backdrop+positioned-div onto the shared Modal.svelte primitive (issue
// #232 MF-3). Modal.svelte's own mechanics (showModal on mount, Escape
// wiring, Tab-trap wraparound, focus-restore-on-unmount, outside-click)
// are already pinned once, generically, in modal.integration.test.ts and
// modal.spec.ts (e2e) -- this file pins only the CALLER-level contract,
// mirroring personaDetailDialog.integration.test.ts's pattern: which
// element gets initial focus (jsdom-observable via the `autofocus`
// attribute) and that the wiring (dialog click / cancel event) reaches
// `onClose`. Escape-to-close, Tab-trap, and focus-restore themselves need
// a real browser (jsdom cannot simulate showModal()) -- covered in
// launchDialog.spec.ts (e2e).
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LaunchDialog from "../src/lib/LaunchDialog.svelte";
import type { HostInfo, KaoiroConnection } from "../src/lib/protocol";

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
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function claudeHost(): HostInfo {
  return {
    host_id: "host-a",
    personas: [{ id: "fuji", name: "藤", sprite_set: "fuji" }],
    cwd_allowlist: ["/workspace"],
    capabilities: ["claude-code"],
    engines: [{ id: "claude-code", models: [] }],
  };
}

function makeConnection(): KaoiroConnection {
  return {
    spawn: vi.fn(async () => ({ agentId: "host-a.new" })),
    enumerateSessions: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setEffort: vi.fn(async () => undefined),
    refreshModels: vi.fn(async () => undefined),
    refreshEngineCatalog: vi.fn(async () => ({
      host_id: "host-a",
      engine: "claude-code",
      request_id: "r",
      ok: true,
    })),
    getLaunchDefaults: vi.fn(async () => ({})),
  } as unknown as KaoiroConnection;
}

async function render(onClose = vi.fn()) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(LaunchDialog, {
    target,
    props: {
      hosts: [claudeHost()],
      connection: makeConnection(),
      sessions: null,
      onClose,
    },
  });
  mounted.push(component);
  await tick();
  return { target, onClose };
}

describe("LaunchDialog on Modal.svelte (issue #277)", () => {
  it("Modal.svelte 経由で dialog を開く(独自 backdrop ではない)", async () => {
    const { target } = await render();

    const dialog = target.querySelector<HTMLDialogElement>("dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-label")).toBe("エージェント起動");
    expect(target.querySelector(".backdrop")).toBeNull();
  });

  // issue #277: showModal()'s spec-defined initial focus goes to the
  // first autofocus descendant -- pins that the Cancel button (always
  // rendered regardless of mode/host state, non-destructive) carries it,
  // the same reasoning PersonaDetailDialog's close button uses.
  it("キャンセルボタンに autofocus が設定されている(dialog の初期フォーカス対象)", async () => {
    const { target } = await render();

    const cancelButton = Array.from(
      target.querySelectorAll<HTMLButtonElement>("button.ghost"),
    ).find((b) => b.textContent?.includes("キャンセル"));
    expect(cancelButton?.hasAttribute("autofocus")).toBe(true);
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

  it("キャンセルボタンのクリックで onClose を呼ぶ", async () => {
    const { target, onClose } = await render();

    Array.from(target.querySelectorAll<HTMLButtonElement>("button.ghost"))
      .find((b) => b.textContent?.includes("キャンセル"))!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
