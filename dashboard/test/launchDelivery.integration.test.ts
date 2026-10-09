// @vitest-environment jsdom
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

async function render(canOperate = () => true) {
  const target = document.createElement("div");
  document.body.append(target);
  const conn = makeConnection();
  const component = mount(LaunchDialog, {
    target,
    props: {
      hosts: [{ ...multiEngineHost(), in_flight_defaults: { "claude-code": false },
        engines: [{ id: "claude-code", models: [], launch_delivery_policy: { version: "v1", ceiling: true, mechanisms: { operator_early: "fold", inter_agent_early: "fold", inter_agent_yield: "tool_boundary" } } }] }],
      deliveryPolicyAvailable: true, canOperate,
      connection: conn,
      sessions: { host_id: "host-a", cwd: "/workspace", sessions: [{ session_id: "past" }] },
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


it("launch action rechecks authorization after the dialog was opened", async () => {
  let allowed = true; const { target, conn } = await render(() => allowed);
  allowed = false; await submit(target); expect(conn.spawn).not.toHaveBeenCalled();
});
it("resume-mode fresh spawn includes the displayed launch policy", async () => {
  const { target, conn } = await render();
  const button = [...target.querySelectorAll("button")].find(b => b.textContent?.trim() === "再開")!;
  button.click(); await tick(); await submit(target);
  expect(conn.spawn).toHaveBeenCalledWith(expect.objectContaining({ resume_session_id: "past", delivery_policy: "off" }));
});
it("mounting and unmounting never writes or spawns", async () => {
  const { conn } = await render(); await unmount(mounted.pop()!); expect(conn.spawn).not.toHaveBeenCalled();
});
