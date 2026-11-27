import "./isolation.setup";
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
import { installDialogShim, testModalCloseContract } from "./modalCloseContract";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LaunchDialog from "../src/lib/LaunchDialog.svelte";
import type { HostInfo, KaoiroConnection } from "../src/lib/protocol";

installDialogShim();

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

async function render(onClose = vi.fn(), hosts: HostInfo[] = [claudeHost()]) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(LaunchDialog, {
    target,
    props: {
      hosts,
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
  it("host selector は runner の CalVer identity を host_id の後ろに表示する", async () => {
    const { target } = await render(vi.fn(), [
      {
        ...claudeHost(),
        build_version: "2026.9.0",
        build_channel: "dev",
        build_revision: "0123456789abcdef0123456789abcdef01234567",
      },
    ]);

    expect(target.querySelector("select option")?.textContent?.trim()).toBe(
      "host-a — v2026.9.0 / unknown / 0123456",
    );
  });

  it("Modal.svelte 経由で dialog を開く(独自 backdrop ではない)", async () => {
    const { target } = await render();

    const dialog = target.querySelector<HTMLDialogElement>("dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-label")).toBe("エージェント起動");
    expect(target.querySelector(".backdrop")).toBeNull();
  });

  // The first tab ("新規") is the autofocus target, not Cancel (at the
  // form's bottom) -- a bottom target scrolls this scrollable form's
  // internal scroll owner past its own heading at low viewport heights.
  // See launchDialog.spec.ts's e2e pin for the full scroll-position
  // assertion this jsdom test cannot reach.
  it("「新規」タブに autofocus が設定されている(dialog の初期フォーカス対象)", async () => {
    const { target } = await render();

    const newTab = Array.from(
      target.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
    ).find((b) => b.textContent?.includes("新規"));
    expect(newTab?.hasAttribute("autofocus")).toBe(true);
  });

  testModalCloseContract(render);

  it("キャンセルボタンのクリックで onClose を呼ぶ", async () => {
    const { target, onClose } = await render();

    Array.from(target.querySelectorAll<HTMLButtonElement>("button.ghost"))
      .find((b) => b.textContent?.includes("キャンセル"))!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
