import "./isolation.setup";
// @vitest-environment jsdom
// phase-34 A12 (ADR-0057 F4c): LaunchDialog で engine=antigravity のとき
// sandbox × approval × network_access を選択でき、spawn payload に載る
// ことを検証する。codex 側は sandbox/network_access のみ選択可能で
// approval select は出さない (既存挙動の非退行)。
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeReactiveLaunchDialogProps } from "./reactiveProps.svelte";
import { SessionEnumeration } from "../src/lib/sessionEnumeration";
import type { EngineCatalog, ModelOption } from "../src/lib/protocol";
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
  const enumeration = new SessionEnumeration();
  const initial = { hosts, connection: conn, sessions: null, enumeration, onClose: vi.fn() };
  const props = makeReactiveLaunchDialogProps(initial);
  const component = mount(LaunchDialog, { target, props });
  mounted.push(component);
  await tick();
  return { target, conn, props, enumeration };
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
    await selectValue(labelledSelect(target, "承認"), "local");

    await submit(target);

    expect(conn.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "antigravity",
        sandbox: "read-only",
        approval: "local",
      }),
    );
  });

  it.each(["codex", "claude-code"])(
    "does not send Antigravity local approval after switching to %s",
    async (engine) => {
      const { target, conn } = await render();
      await selectValue(labelledSelect(target, "エンジン"), "antigravity");
      await selectValue(labelledSelect(target, "承認"), "local");
      await selectValue(labelledSelect(target, "エンジン"), engine);
      await submit(target);

      expect(conn.spawn).toHaveBeenCalledWith(
        expect.not.objectContaining({ approval: "local" }),
      );
    },
  );

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

  it.each([false, true])("external permission axes never enable launch controls (spawn: %s)", async (spawn) => {
    const host = multiEngineHost();
    host.capabilities = ["claude-code", "future-engine"];
    host.engines = [{ id: "claude-code", models: [] }, {
      id: "future-engine",
      models: [],
      launch_permission_axes: { sandbox: true, approval: true },
      ...(spawn ? { operations: { version: 1, spawn: true } as const } : {}),
    }];
    const { target, conn } = await render([host]);
    const engine = labelledSelect(target, "エンジン");
    await selectValue(engine, "future-engine");
    expect(engine.value).toBe("future-engine");
    for (const label of ["sandbox", "承認", "ネットワークアクセス", "permission mode"]) {
      expect(findLabel(target, label)).toBeUndefined();
    }
    expect(target.textContent?.includes("利用できる操作なし")).toBe(!spawn);
    expect(!!target.querySelector("button[type=submit]")).toBe(spawn);
    await submit(target);
    expect(conn.spawn).toHaveBeenCalledTimes(spawn ? 1 : 0);
    if (spawn) {
      const payload = vi.mocked(conn.spawn).mock.calls[0]![0];
      expect(payload).toMatchObject({
        host_id: "host-a", engine: "future-engine", persona: "ao", cwd: "/workspace",
      });
      for (const key of ["permission_mode", "sandbox", "approval", "network_access"]) {
        expect(Object.hasOwn(payload, key)).toBe(false);
      }
    }
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

function externalHost(flags: EngineCatalog["operations"], models: ModelOption[] = []) {
  const host = multiEngineHost();
  host.capabilities = ["sample"];
  host.engines = [{ id: "sample", models, operations: flags }];
  return host;
}

describe("external launch declarations", () => {
  it.each([false, true])("requires resume for the selected session (resume=%s)", async resume => {
    const { target, conn, enumeration } = await render([
      externalHost({ version: 1, spawn: true, enumerate_sessions: true, resume }),
    ]);
    target.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click();
    await tick();
    expect(conn.enumerateSessions).toHaveBeenCalledWith("host-a", "/workspace", "sample");
    enumeration.receive({ host_id: "host-a", cwd: "/workspace", engine: "sample",
      sessions: [{ session_id: "saved" }] });
    await vi.waitFor(() => expect(labelledSelect(target, "セッション").value).toBe("saved"));
    expect(!!target.querySelector("button[type=submit]")).toBe(resume);
    await submit(target);
    expect(conn.spawn).toHaveBeenCalledTimes(resume ? 1 : 0);
    if (resume) expect(conn.spawn).toHaveBeenCalledWith(expect.objectContaining({
      engine: "sample", resume_session_id: "saved",
    }));
  });

  it.each([false, true])("rejects the legacy launch ID (catalog row=%s)", async row => {
    const host = multiEngineHost();
    host.capabilities = ["claude"];
    host.engines = row ? [{id: "claude", models: [], operations: {version: 1, spawn: true}}] : [];
    const { target, conn } = await render([host]);
    expect(labelledSelect(target, "エンジン").value).toBe("claude");
    expect(target.textContent).toContain("利用できる操作なし");
    await submit(target);
    expect(conn.spawn).not.toHaveBeenCalled();
  });

  it("offers a new launch without history or catalog refresh", async () => {
    const { target, conn } = await render([externalHost({ version: 1, spawn: true })]);
    expect(target.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(target.querySelector(".catalog-refresh button")).toBeNull();
    expect(conn.enumerateSessions).not.toHaveBeenCalled();
    expect(conn.refreshEngineCatalog).not.toHaveBeenCalled();
    await submit(target);
    expect(conn.spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["model", "effort"])("requires an explicit choice after losing %s", async axis => {
    const ops = { version: 1, spawn: true } as const;
    const model = { value: "custom", display_name: "Custom", effort_levels: ["light", "deep"] };
    const { target, conn, props } = await render([externalHost(ops, [model])]);
    await selectValue(labelledSelect(target, "モデル"), "custom");
    await selectValue(labelledSelect(target, "effort"), "deep");
    props.hosts = [externalHost(ops, axis === "model" ? [] : [{ ...model, effort_levels: ["light"] }])];
    await tick();
    const pick = labelledSelect(target, axis === "model" ? "モデル" : "effort");
    expect(pick.querySelector("option[disabled]")).not.toBeNull();
    expect(target.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(true);
    await submit(target);
    expect(conn.spawn).not.toHaveBeenCalled();
    await selectValue(pick, "");
    await submit(target);
    expect(conn.spawn).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(conn.spawn).mock.calls[0]!;
    expect(payload).not.toHaveProperty("effort");
    if (axis === "model") expect(payload).not.toHaveProperty("model");
    else expect(payload.model).toBe("custom");
  });
});
