import "./isolation.setup";
// @vitest-environment jsdom
// Issue #269 U2: the dialogs and settings repaint on setLocale. Each case mounts
// one screen in ja (locale.setup.ts), reads named elements, switches to en and
// reads them again; the expected text is the table value, with a few literals.
import { mount, tick, unmount, type Component } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KaoiroConnection } from "../src/lib/protocol";
import DeliveryPolicyControl from "../src/lib/DeliveryPolicyControl.svelte";
import DeviceApproval from "../src/lib/DeviceApproval.svelte";
import LaunchDialog from "../src/lib/LaunchDialog.svelte";
import SessionLifecycleDialog from "../src/lib/SessionLifecycleDialog.svelte";
import SettingsDrawer from "../src/lib/SettingsDrawer.svelte";
import StatusLineHistoryDialog from "../src/lib/StatusLineHistoryDialog.svelte";
import { unknownDeliveryPolicy } from "../src/lib/deliveryPolicy";
import { deliveryPolicyLabel } from "../src/lib/deliveryPolicyLabel";
import { formatRemaining } from "../src/lib/deviceApproval";
import { en } from "../src/lib/i18n/en";
import { ja } from "../src/lib/i18n/ja";
import { setLocale } from "../src/lib/i18n/index.svelte";

// jsdom does not implement HTMLDialogElement.showModal/close.
if (typeof HTMLDialogElement.prototype.showModal !== "function") {
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
  vi.restoreAllMocks();
});

async function render<P extends Record<string, any>>(component: Component<P>, props: P) {
  mounted.push(mount(component, { target: document.body, props }));
  await tick();
  return document.body;
}

const text = (root: ParentNode, selector: string): string | undefined =>
  root.querySelector(selector)?.textContent?.trim();

describe("functions", () => {
  it("deliveryPolicyLabel and formatRemaining follow the locale at call time", () => {
    const view = unknownDeliveryPolicy();
    expect(deliveryPolicyLabel(view, false)).toBe(ja.deliveryPolicy.waitingConnection);
    expect(formatRemaining(65)).toBe("1 分 5 秒");
    setLocale("en");
    expect(deliveryPolicyLabel(view, false)).toBe("Waiting for connection");
    expect(deliveryPolicyLabel(view, true)).toBe(en.deliveryPolicy.unknownNormal);
    expect(formatRemaining(65)).toBe("1 min 5 s");
    expect(formatRemaining(7)).toBe("7 s");
  });
});

describe("dialogs and settings repaint on setLocale", () => {
  it("SettingsDrawer: title, close, toggles and logout", async () => {
    const body = await render(SettingsDrawer, { onClose: () => {}, onLogout: () => {} });
    const close = () => body.querySelector("button.close")!.getAttribute("aria-label");
    expect(text(body, "h2")).toBe(ja.settingsDrawer.title);
    expect(close()).toBe(ja.common.close);
    expect(text(body, "button.logout")).toBe(ja.settingsDrawer.logout);
    expect(body.textContent).toContain(ja.settingsDrawer.notificationSound);
    setLocale("en");
    await tick();
    expect(text(body, "h2")).toBe("Settings");
    expect(close()).toBe("Close");
    expect(text(body, "button.logout")).toBe("Log out");
    expect(body.textContent).toContain("Notification sound");
    expect(body.textContent).toContain(en.settingsDrawer.gridSort);
  });

  it("LaunchDialog: heading, tabs, no-host note and buttons", async () => {
    const body = await render(LaunchDialog, {
      hosts: [],
      connection: { getLaunchDefaults: async () => ({}) } as unknown as KaoiroConnection,
      sessions: null,
      onClose: () => {},
    });
    const tabs = () => [...body.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim());
    expect(text(body, "h2")).toBe(ja.launchDialog.heading);
    expect(tabs()).toEqual([ja.launchDialog.tabNew, ja.launchDialog.tabResume]);
    expect(text(body, "p.note")).toBe(ja.launchDialog.noHosts);
    expect(text(body, ".actions button.ghost")).toBe(ja.launchDialog.cancel);
    setLocale("en");
    await tick();
    expect(text(body, "h2")).toBe("Launch an agent");
    expect(tabs()).toEqual(["New", "Resume"]);
    expect(text(body, "p.note")).toBe(en.launchDialog.noHosts);
    expect(text(body, ".actions button.ghost")).toBe("Cancel");
    expect(text(body, '.actions button[type="submit"]')).toBe("Launch");
  });

  it("LaunchDialog: only Muse is marked experimental in both locales", async () => {
    const body = await render(LaunchDialog, {
      hosts: [{
        host_id: "host-a",
        personas: [{ id: "fuji", name: "Fuji", sprite_set: "fuji" }],
        cwd_allowlist: ["/workspace"],
        capabilities: ["muse", "grok", "codex"],
      }],
      connection: { getLaunchDefaults: async () => ({}) } as unknown as KaoiroConnection,
      sessions: null,
      onClose: () => {},
    });
    const labels = () => Object.fromEntries(
      ["muse", "grok", "codex"].map((id) => {
        const option = body.querySelector<HTMLOptionElement>(`option[value="${id}"]`)!;
        return [option.value, option.textContent?.trim()];
      }),
    );
    expect(labels()).toEqual({ muse: "Muse (実験的)", grok: "Grok Build", codex: "codex" });
    setLocale("en");
    await tick();
    expect(labels()).toEqual({ muse: "Muse (experimental)", grok: "Grok Build", codex: "codex" });
  });

  it("DeviceApproval: entry view and the unavailable error", async () => {
    const body = await render(DeviceApproval, {
      initialCode: null,
      available: true,
      providers: [],
      onClose: () => {},
    });
    expect(text(body, "h2")).toBe(ja.deviceApproval.title);
    expect(text(body, "label[for=device-user-code]")).toBe(ja.deviceApproval.enterCode);
    expect(text(body, 'form button[type="submit"]')).toBe(ja.deviceApproval.check);
    setLocale("en");
    await tick();
    expect(text(body, "h2")).toBe("Approve a device login");
    expect(text(body, "label[for=device-user-code]")).toBe(en.deviceApproval.enterCode);
    expect(text(body, 'form button[type="submit"]')).toBe("Check");
  });

  it("DeviceApproval: the error text of a closed feature", async () => {
    const body = await render(DeviceApproval, {
      initialCode: null,
      available: false,
      providers: [],
      onClose: () => {},
    });
    expect(text(body, '[role="alert"]')).toBe(ja.deviceApproval.unavailable);
    setLocale("en");
    await tick();
    expect(text(body, '[role="alert"]')).toBe("This server does not provide device approval.");
  });

  it("SettingsDrawer: the source of the history size", async () => {
    const connection = {
      listConversations: async () => Object.assign([], { incomplete: false }),
      listUsers: async () => [],
    } as unknown as KaoiroConnection;
    const body = await render(SettingsDrawer, {
      onClose: () => {},
      connection,
      statusLineSettings: { retention: 20, source: "stored", min: 1, max: 100 },
    });
    const hints = () => [...body.querySelectorAll("p.hint")].map((p) => p.textContent?.trim() ?? "");
    expect(hints()).toContain(ja.settingsDrawer.retentionHint({ source: ja.settingsDrawer.sourceStored }));
    setLocale("en");
    await tick();
    expect(hints().join("|")).toContain("(current source: stored)");
  });

  it("DeliveryPolicyControl: title, saved setting and the state line", async () => {
    const body = await render(DeliveryPolicyControl, { agentId: "a", connected: false });
    expect(text(body, "strong")).toBe(ja.deliveryPolicy.title);
    expect(body.textContent).toContain(ja.deliveryPolicy.waitingConnection);
    setLocale("en");
    await tick();
    expect(text(body, "strong")).toBe("Interrupt delivery while running");
    expect(body.querySelector("section")?.getAttribute("aria-label")).toBe(en.deliveryPolicy.title);
    expect(body.textContent).toContain("Saved setting: unknown");
    expect(body.textContent).toContain("Waiting for connection");
  });

  it("StatusLineHistoryDialog: title, aria-label and the loading note", async () => {
    const body = await render(StatusLineHistoryDialog, {
      agentId: "a",
      label: "Agent A",
      fetchHistory: () => new Promise(() => {}),
      refreshKey: null,
      onClose: () => {},
    });
    expect(text(body, "h2")).toBe(ja.statusLineHistoryDialog.title({ label: "Agent A" }));
    expect(text(body, ".loading")).toBe(ja.common.loading);
    setLocale("en");
    await tick();
    expect(text(body, "h2")).toBe("Status line of Agent A");
    expect(body.querySelector("dialog")?.getAttribute("aria-label")).toBe(
      "Status line history of Agent A",
    );
    expect(text(body, ".loading")).toBe("Loading…");
  });

  it("SessionLifecycleDialog: title, refresh button and the loading note", async () => {
    const body = await render(SessionLifecycleDialog, {
      agentId: "a",
      label: "Agent A",
      fetchEvents: () => new Promise(() => {}),
      refreshKey: 0,
      agents: {},
      directory: {},
      onClose: () => {},
    });
    expect(text(body, "h2")).toBe(ja.sessionLifecycleDialog.title({ label: "Agent A" }));
    expect(text(body, ".loading")).toBe(ja.sessionLifecycleDialog.loading);
    setLocale("en");
    await tick();
    expect(text(body, "h2")).toBe("Session history of Agent A");
    expect(text(body, ".refresh-note")).toBe(en.sessionLifecycleDialog.refreshNote);
    expect(text(body, ".loading")).toBe("Loading");
  });
});
