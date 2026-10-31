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
  getWorkSettings: vi.fn(),
  setWorkSettings: vi.fn(),
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
        getWorkSettings: captured.getWorkSettings,
        setWorkSettings: captured.setWorkSettings,
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
  captured.getWorkSettings.mockReset();
  captured.setWorkSettings.mockReset();
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
    const input = workSection()!.querySelector<HTMLInputElement>("input")!;
    input.value = "0"; input.dispatchEvent(new Event("input", { bubbles: true })); await tick();
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
  it("keeps edited drafts across another tab's update and uses the latest revision", async () => {
    const h = await mountApp();
    h.onHosts?.([], false); h.onStatus("connected"); h.onWorkSettings?.(ready);
    await tick(); await openSettings();
    const input = workSection()!.querySelector<HTMLInputElement>("input")!;
    input.value = "0"; input.dispatchEvent(new Event("input", { bubbles: true })); await tick();
    h.onWorkSettings?.({ ...ready, revision: 43, effective: { ...ready.effective, work_nominated_per_principal: 1 } });
    await tick();
    expect(input.value).toBe("0");
    expect(workSection()!.textContent).toContain("入力は保持しています");
    captured.setWorkSettings.mockResolvedValue({ ...ready, revision: 44 });
    Array.from(workSection()!.querySelectorAll("button")).find(b => b.textContent === "保存")!.click();
    await vi.waitFor(() => expect(captured.setWorkSettings).toHaveBeenCalledWith(43, {
      work_nominated_per_principal: 0,
    }));
  });
  it("rereads conflict/unknown outcomes without replay; reset removes only the selected override", async () => {
    const h = await mountApp();
    h.onHosts?.([], false); h.onStatus("connected"); h.onWorkSettings?.(ready);
    await tick(); await openSettings();
    const save = () => Array.from(workSection()!.querySelectorAll("button")).find(b => b.textContent === "保存")!;
    const input = workSection()!.querySelector<HTMLInputElement>("input")!;
    input.value = "0"; input.dispatchEvent(new Event("input", { bubbles: true })); await tick();
    captured.setWorkSettings.mockRejectedValueOnce(new Error("revision_conflict"));
    captured.getWorkSettings.mockResolvedValueOnce({ ...ready, revision: 43 });
    save().click();
    await vi.waitFor(() => expect(workSection()!.textContent).toContain("別の変更が保存されました"));
    expect(captured.setWorkSettings).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(save().disabled).toBe(false));
    captured.setWorkSettings.mockRejectedValueOnce(new Error("timeout"));
    captured.getWorkSettings.mockRejectedValueOnce(new Error("disconnected"));
    save().click();
    await vi.waitFor(() => expect(workSection()!.textContent).toContain("結果が不明です"));
    expect(save().disabled).toBe(true);
    expect(captured.setWorkSettings).toHaveBeenCalledTimes(2);
    captured.getWorkSettings.mockResolvedValueOnce({ ...ready, revision: 44 });
    Array.from(workSection()!.querySelectorAll("button")).find(b => b.textContent?.startsWith("設定・変更履歴"))!.click();
    await vi.waitFor(() => expect(save().disabled).toBe(false));
    captured.setWorkSettings.mockResolvedValueOnce({ ...ready, revision: 45 });
    Array.from(workSection()!.querySelectorAll("button")).find(b => b.textContent?.startsWith("サーバー設定に戻す"))!.click();
    await vi.waitFor(() => expect(captured.setWorkSettings).toHaveBeenLastCalledWith(44, { work_nominated_per_principal: null }));
  });
  it("ignores an old connection's successful reply after disconnect", async () => {
    const h = await mountApp();
    h.onHosts?.([], false); h.onStatus("connected"); h.onWorkSettings?.(ready);
    await tick(); await openSettings();
    const input = workSection()!.querySelector<HTMLInputElement>("input")!;
    input.value = "0"; input.dispatchEvent(new Event("input", { bubbles: true })); await tick();
    let complete!: (value: typeof ready) => void;
    captured.setWorkSettings.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    Array.from(workSection()!.querySelectorAll("button")).find(b => b.textContent === "保存")!.click();
    await tick();
    h.onStatus("disconnected"); await tick();
    complete({ ...ready, revision: 43 }); await tick(); await tick();
    expect(workSection()!.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    expect(workSection()!.textContent).not.toContain("適用値:");
  });

  const editKey = async (index: number, text: string) => {
    const input = workSection()!.querySelectorAll<HTMLInputElement>("input")[index]!;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
  };
  const saveButton = () => Array.from(workSection()!.querySelectorAll("button")).find(b => b.textContent === "保存")!;
  const openWorkSettings = async () => {
    const h = await mountApp();
    h.onHosts?.([], false); h.onStatus("connected"); h.onWorkSettings?.(ready);
    await tick(); await openSettings();
  };
  const reload = async () => {
    captured.getWorkSettings.mockResolvedValueOnce({ ...ready });
    Array.from(workSection()!.querySelectorAll("button")).find(b => b.textContent?.startsWith("設定・変更履歴"))!.click();
    await vi.waitFor(() => expect(workSection()!.textContent).toContain("入力は保持しています"));
  };
  it("sends only the edited key in one patch", async () => {
    await openWorkSettings();
    await editKey(0, "0");
    captured.setWorkSettings.mockResolvedValue({ ...ready, revision: 43 });
    saveButton().click();
    await vi.waitFor(() => expect(captured.setWorkSettings).toHaveBeenCalledWith(42, { work_nominated_per_principal: 0 }));
    expect(captured.setWorkSettings).toHaveBeenCalledTimes(1);
  });
  it("sends a key edited and then restored to its effective value", async () => {
    await openWorkSettings();
    await editKey(0, "0");
    await editKey(0, "16");
    captured.setWorkSettings.mockResolvedValue({ ...ready, revision: 43 });
    saveButton().click();
    await vi.waitFor(() => expect(captured.setWorkSettings).toHaveBeenCalledWith(42, { work_nominated_per_principal: 16 }));
  });
  it("keeps the edit mark across a reread so the patch matches the kept draft", async () => {
    await openWorkSettings();
    await editKey(0, "0");
    await reload();
    expect(workSection()!.querySelectorAll<HTMLInputElement>("input")[0]!.value).toBe("0");
    await vi.waitFor(() => expect(saveButton().disabled).toBe(false));
    captured.setWorkSettings.mockResolvedValue({ ...ready, revision: 43 });
    saveButton().click();
    await vi.waitFor(() => expect(captured.setWorkSettings).toHaveBeenCalledWith(42, { work_nominated_per_principal: 0 }));
  });
  it("keeps an earlier edit when another key is edited after a reread", async () => {
    await openWorkSettings();
    await editKey(0, "0");
    await reload();
    await editKey(1, "1");
    captured.setWorkSettings.mockResolvedValue({ ...ready, revision: 43 });
    saveButton().click();
    await vi.waitFor(() => expect(captured.setWorkSettings).toHaveBeenCalledWith(42, { work_nominated_per_principal: 0, work_active_per_assignee: 1 }));
  });
  it("disables save with no edited key and never sends an empty patch", async () => {
    await openWorkSettings();
    expect(saveButton().disabled).toBe(true);
    saveButton().click();
    await tick();
    expect(captured.setWorkSettings).not.toHaveBeenCalled();
  });
  it("clears the edit marks when the snapshot becomes unavailable", async () => {
    await openWorkSettings();
    await editKey(0, "0");
    const h = captured.handlers!;
    h.onWorkSettings?.({ version: "0", state: "unavailable", reason: "work_settings_corrupt", message: "Offline one-key repair is required." });
    await tick();
    h.onWorkSettings?.({ ...ready, revision: 43 });
    await vi.waitFor(() => expect(workSection()!.querySelectorAll<HTMLInputElement>("input")[0]!.value).toBe("16"));
    expect(saveButton().disabled).toBe(true);
  });
  it("clears the edit marks when the connection drops and comes back", async () => {
    await openWorkSettings();
    await editKey(0, "0");
    const h = captured.handlers!;
    h.onStatus("disconnected");
    await tick();
    h.onStatus("connected");
    h.onWorkSettings?.({ ...ready, revision: 43 });
    await vi.waitFor(() => expect(workSection()!.querySelectorAll<HTMLInputElement>("input")[0]!.value).toBe("16"));
    expect(saveButton().disabled).toBe(true);
  });
  it("clears every edit mark after a reset succeeds", async () => {
    await openWorkSettings();
    await editKey(1, "1");
    captured.setWorkSettings.mockResolvedValueOnce({ ...ready, revision: 43 });
    Array.from(workSection()!.querySelectorAll("button")).find(b => b.textContent?.startsWith("サーバー設定に戻す"))!.click();
    await vi.waitFor(() => expect(captured.setWorkSettings).toHaveBeenCalledWith(42, { work_nominated_per_principal: null }));
    await vi.waitFor(() => expect(workSection()!.querySelectorAll<HTMLInputElement>("input")[1]!.value).toBe("16"));
    expect(saveButton().disabled).toBe(true);
    saveButton().click();
    await tick();
    expect(captured.setWorkSettings).toHaveBeenCalledTimes(1);
  });

});
