// @vitest-environment jsdom
// phase-34 A12 (ADR-0057 F4c): LaunchDialog で engine=antigravity のとき
// sandbox × approval × network_access を選択でき、spawn payload に載る
// ことを検証する。codex 側は sandbox/network_access のみ選択可能で
// approval select は出さない (既存挙動の非退行)。
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LaunchDialog from "../src/lib/LaunchDialog.svelte";
import type { HostInfo, KaoiroConnection } from "../src/lib/protocol";

// jsdom does not implement HTMLDialogElement.showModal/close (measured
// 2026-08-28, jsdom 29.1.1; same polyfill as launchDialogModal.integration.test.ts).
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

function multiEngineHost(): HostInfo {
  return {
    host_id: "host-a",
    personas: [{ id: "ao", name: "あお", sprite_set: "ao" }],
    cwd_allowlist: ["/workspace"],
    capabilities: ["claude-code", "codex", "antigravity"],
    engines: [
      { id: "claude-code", models: [] },
      { id: "codex", models: [] },
      { id: "antigravity", models: [] },
    ],
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

async function render(hosts: HostInfo[] = [multiEngineHost()]) {
  const target = document.createElement("div");
  document.body.append(target);
  const conn = makeConnection();
  const component = mount(LaunchDialog, {
    target,
    props: {
      hosts,
      connection: conn,
      sessions: null,
      onClose: vi.fn(),
    },
  });
  mounted.push(component);
  await tick();
  return { target, conn };
}

function labelledSelect(target: Element, label: string): HTMLSelectElement {
  const labels = [...target.querySelectorAll("label")];
  const node = labels.find((n) => n.textContent?.includes(label));
  const sel = node?.querySelector("select");
  if (!(sel instanceof HTMLSelectElement)) {
    throw new Error(`select not found for label ${label}`);
  }
  return sel;
}

function findLabel(target: Element, label: string): HTMLElement | undefined {
  return [...target.querySelectorAll("label")].find((n) =>
    n.textContent?.includes(label),
  );
}

async function selectValue(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
}

async function submit(target: Element) {
  target
    .querySelector("form")!
    .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await tick();
  await Promise.resolve();
}

describe("LaunchDialog antigravity sandbox/approval/network_access (phase-34 A12, ADR-0057 F4c)", () => {
  it("antigravity 選択で sandbox と approval の両方の select を出す", async () => {
    const { target } = await render();
    await selectValue(labelledSelect(target, "エンジン"), "antigravity");

    expect(findLabel(target, "sandbox")).toBeDefined();
    expect(findLabel(target, "承認")).toBeDefined();
  });

  it("codex 選択では approval select を出さない (never 固定の既存挙動)", async () => {
    const { target } = await render();
    await selectValue(labelledSelect(target, "エンジン"), "codex");

    expect(findLabel(target, "sandbox")).toBeDefined();
    expect(findLabel(target, "承認")).toBeUndefined();
  });

  it("antigravity + sandbox/approval を選び spawn payload に両方載る", async () => {
    const { target, conn } = await render();
    await selectValue(labelledSelect(target, "エンジン"), "antigravity");
    await selectValue(labelledSelect(target, "sandbox"), "read-only");
    await selectValue(labelledSelect(target, "承認"), "never");

    await submit(target);

    expect(conn.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "antigravity",
        sandbox: "read-only",
        approval: "never",
      }),
    );
  });

  it("antigravity + workspace-write sandbox で network_access チェックが payload に載る", async () => {
    const { target, conn } = await render();
    await selectValue(labelledSelect(target, "エンジン"), "antigravity");
    // Default sandbox is already "workspace-write".
    const checkbox = findLabel(target, "ネットワークアクセス")?.querySelector(
      "input[type=checkbox]",
    );
    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error("network_access checkbox not found");
    }
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();

    await submit(target);

    expect(conn.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "antigravity",
        sandbox: "workspace-write",
        network_access: true,
      }),
    );
  });

  it("未知 engine + launch_permission_axes 宣言あり → 値駆動で sandbox/承認 select を出す (round 2 SF-R2-4)", async () => {
    // SANDBOX_AXIS_ENGINES には無い engine 名でも、register の
    // launch_permission_axes 宣言があれば表示できることを確認する —
    // 逆に言えば engine 名 (antigravity/codex) 固定のロジックではない。
    const host: HostInfo = {
      host_id: "host-a",
      personas: [{ id: "ao", name: "あお", sprite_set: "ao" }],
      cwd_allowlist: ["/workspace"],
      capabilities: ["claude-code", "future-engine"],
      engines: [
        { id: "claude-code", models: [] },
        {
          id: "future-engine",
          models: [],
          launch_permission_axes: { sandbox: true, approval: true },
        },
      ],
    };
    const { target } = await render([host]);
    await selectValue(labelledSelect(target, "エンジン"), "future-engine");

    expect(findLabel(target, "sandbox")).toBeDefined();
    expect(findLabel(target, "承認")).toBeDefined();
  });

  it("宣言された engine で approval=false → 承認 select を出さない (値が false を上書きする)", async () => {
    // engine 名だけを見れば "antigravity" は SANDBOX_AXIS_ENGINES に入って
    // approval も選べてしまうところ、宣言が approval:false ならそちらが勝つ
    // ことを確認する。
    const host: HostInfo = {
      host_id: "host-a",
      personas: [{ id: "ao", name: "あお", sprite_set: "ao" }],
      cwd_allowlist: ["/workspace"],
      capabilities: ["claude-code", "antigravity"],
      engines: [
        { id: "claude-code", models: [] },
        {
          id: "antigravity",
          models: [],
          launch_permission_axes: { sandbox: true, approval: false },
        },
      ],
    };
    const { target } = await render([host]);
    await selectValue(labelledSelect(target, "エンジン"), "antigravity");

    expect(findLabel(target, "sandbox")).toBeDefined();
    expect(findLabel(target, "承認")).toBeUndefined();
  });
});
