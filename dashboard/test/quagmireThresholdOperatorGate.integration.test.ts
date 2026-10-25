import "./isolation.setup";
// @vitest-environment jsdom
// issue #307: the rally-threshold control is operator-only, and App.svelte
// owns that decision — `connection={isOperator ? (connection ?? undefined) :
// undefined}` is what SettingsDrawer's `{#if connection}` reads. Withholding
// the prop by hand would measure the drawer's reaction, not App's decision,
// so this mounts the real App and lets `onHosts` (the operator signal, #22)
// and `onJoined` (the rejoin downgrade, #276) decide.
//
// Mirrors appPermissionOperatorGate.integration.test.ts (issue #305 D).
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KaoiroHandlers } from "../src/lib/protocol";

const captured = vi.hoisted(() => ({
  handlers: null as KaoiroHandlers | null,
}));

vi.mock("../src/lib/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/protocol")>();
  return {
    ...actual,
    connectKaoiro: (_url: string, handlers: KaoiroHandlers) => {
      captured.handlers = handlers;
      return {
        disconnect: () => {},
        reconnect: () => {},
        notifyOnline: () => {},
        sendInstruction: () => {},
        sendInterrupt: () => {},
        stop: async () => {},
        restore: async () => {},
        deleteAgent: async () => {},
        renameAgent: async () => {},
        setPermission: async () => null,
        setQuagmireSettings: async () => ({ rallyTurns: 16, source: "default" }),
        // SettingsDrawer fetches both lists as soon as it has a
        // connection; `listConversations` also carries `.incomplete`.
        listConversations: async () =>
          Object.assign([], { incomplete: false }),
        listUsers: async () => [],
        closeConversation: async () => {},
        renameUser: async () => {},
      };
    },
    fetchPersonaManifest: async () => ({ kind: "unavailable" }),
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
  };
});

// jsdom does not implement HTMLDialogElement.showModal/close (same
// polyfill as modal.integration.test.ts / settingsDrawer.integration.test.ts).
// SettingsDrawer opens a Modal.svelte instance, so mounting the real App and
// opening the drawer reaches it — without this the run stays green but
// vitest reports unhandled errors and exits non-zero.
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

const App = (await import("../src/App.svelte")).default;
let component: object | null = null;

async function mountApp(): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (captured.handlers === null) throw new Error("not connected yet");
  });
  return captured.handlers!;
}

async function openSettings(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(
    'button[aria-label="設定"]',
  );
  expect(button).not.toBeNull();
  button!.click();
  await tick();
}

const section = () => document.querySelector("section.quagmire");

beforeEach(() => {
  captured.handlers = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/session/ticket")) {
        return { ok: true, status: 200, json: async () => ({ ticket: "t-1" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
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
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App.svelte rally threshold operator gate (issue #307)", () => {
  it("shows the control to an operator (onHosts received)", async () => {
    const h = await mountApp();
    h.onHosts?.([], false);
    h.onStatus("connected");
    h.onQuagmireSettings?.({ rallyTurns: 16, source: "default" });
    await tick();
    await openSettings();
    expect(section()).not.toBeNull();
  });

  it("withholds it from a viewer (no onHosts, so no operator signal)", async () => {
    const h = await mountApp();
    h.onQuagmireSettings?.({ rallyTurns: 16, source: "default" });
    await tick();
    await openSettings();
    expect(section()).toBeNull();
  });

  it("withdraws it when a rejoin downgrades the role (onJoined)", async () => {
    const h = await mountApp();
    h.onHosts?.([], false);
    h.onStatus("connected");
    h.onQuagmireSettings?.({ rallyTurns: 16, source: "default" });
    await tick();
    await openSettings();
    expect(section()).not.toBeNull();
    h.onJoined?.();
    await tick();
    expect(section()).toBeNull();
  });
});

describe("App.svelte work admission settings", () => {
  const workSection = () => document.querySelector('section[aria-label="Work admission settings"]');
  const ready = {
    version: "0" as const, state: "ready" as const, revision: 42,
    overrides: {},
    effective: { work_nominated_per_principal: 16, work_active_per_assignee: 16 },
    fallbacks: { work_nominated_per_principal: 16, work_active_per_assignee: 16 },
    sources: { work_nominated_per_principal: "default" as const, work_active_per_assignee: "default" as const },
    last_change: null,
  };
  it("does not render work settings in the viewer DOM", async () => {
    const h = await mountApp();
    h.onStatus("connected");
    h.onWorkSettings?.(ready);
    await tick();
    await openSettings();
    expect(workSection()).toBeNull();
  });
  it("unavailable notice overrides a higher revision and reconnect clears the diagnosis", async () => {
    const h = await mountApp();
    h.onHosts?.([], false);
    h.onStatus("connected");
    h.onWorkSettings?.(ready);
    await tick();
    await openSettings();
    expect(workSection()).not.toBeNull();
    const save = () => Array.from(workSection()!.querySelectorAll("button")).find(button => button.textContent === "保存")!;
    expect(save().disabled).toBe(false);
    h.onWorkSettings?.({ version: "0", state: "unavailable", reason: "work_settings_corrupt", message: "Offline one-key repair is required." });
    await tick();
    expect(workSection()?.textContent).toContain("Invalid saved work settings");
    expect(save().disabled).toBe(true);
    h.onStatus("disconnected");
    await tick();
    expect(workSection()?.textContent).not.toContain("Offline one-key repair");
    expect(save().disabled).toBe(true);
  });
  it("zero is valid but empty, signed and fractional input cannot be saved", async () => {
    const h = await mountApp();
    h.onHosts?.([], false);
    h.onStatus("connected");
    h.onWorkSettings?.(ready);
    await tick();
    await openSettings();
    const input = workSection()!.querySelector<HTMLInputElement>("input")!;
    const save = () => Array.from(workSection()!.querySelectorAll("button")).find(button => button.textContent === "保存")!;
    for (const [text, valid] of [["0", true], ["1", true], ["2147483647", true], ["", false], ["-1", false], ["1.5", false], ["+1", false], [" 1", false], ["2147483648", false]] as const) {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
      expect(save().disabled, text).toBe(!valid);
    }
  });
});
