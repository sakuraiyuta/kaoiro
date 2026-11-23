import "./isolation.setup";
// @vitest-environment jsdom
// issue 1076: the settings drawer groups its items into tabs. Every item sits
// in exactly one panel, a tab exists only while one of its items passes its
// own gate (connection), and panels stay mounted so child state survives a
// tab switch.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsDrawer from "../src/lib/SettingsDrawer.svelte";
import { DEFAULT_SETTINGS, updateSettings } from "../src/lib/settings.svelte";
import type { Envelope, KaoiroConnection } from "../src/lib/protocol";
import { en } from "../src/lib/i18n/en";
import { ja } from "../src/lib/i18n/ja";
import { setLocale } from "../src/lib/i18n/index.svelte";
import { reactiveProps } from "./reactiveProps.svelte";

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

const t = ja.settingsDrawer;
const mounted: object[] = [];

beforeEach(() => {
  localStorage.clear();
  updateSettings({ ...DEFAULT_SETTINGS, locale: "ja" });
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  localStorage.clear();
});

function makeConnection(): KaoiroConnection {
  return {
    listConversations: vi.fn(async () =>
      Object.assign(
        [
          {
            conversationId: "cid-open-0001",
            participants: ["host-a.p", "host-b.p"],
            turns: 1,
            tokens: null,
            status: "open",
            startedAt: null,
          },
        ],
        { incomplete: false },
      ),
    ),
    listUsers: vi.fn(async () => []),
  } as unknown as KaoiroConnection;
}

type Props = {
  onClose: () => void;
  connection: KaoiroConnection | undefined;
  onOpenSessionLifecycle: ((agentId: string) => void) | undefined;
  onLogout?: () => void;
  agentSnapshotComplete: boolean;
  agents: Record<string, Envelope>;
  tryBeginBulkReset: () => number | null;
};

async function render(overrides: Partial<Props> = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  const props = reactiveProps<Props>({
    onClose: vi.fn(),
    connection: undefined,
    onOpenSessionLifecycle: undefined,
    agentSnapshotComplete: true,
    agents: {},
    tryBeginBulkReset: () => 1,
    ...overrides,
  });
  mounted.push(mount(SettingsDrawer, { target, props }));
  await tick();
  return { target, props };
}

const operatorProps = (): Partial<Props> => ({
  connection: makeConnection(),
  onOpenSessionLifecycle: vi.fn(),
  onLogout: vi.fn(),
});

const tabButtons = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const tabNames = (root: HTMLElement) =>
  tabButtons(root).map((b) => b.textContent?.trim());
const panels = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
const panel = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`#settings-panel-${id}`);

function tab(root: HTMLElement, label: string): HTMLButtonElement {
  const found = tabButtons(root).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`tab not found: ${label}`);
  return found;
}

async function select(root: HTMLElement, label: string) {
  tab(root, label).click();
  await tick();
}

const labelsWith = (root: HTMLElement, text: string) =>
  Array.from(root.querySelectorAll("label")).filter((l) =>
    l.textContent?.includes(text),
  );

type Item = {
  name: string;
  tab: string;
  find: (root: HTMLElement) => Element[];
};

// The 11 items of the drawer, each located by something an operator reads or
// a stable class. Logout is a global action and is checked separately.
const ITEMS: Item[] = [
  { name: "language", tab: "display", find: (r) => Array.from(r.querySelectorAll(".language")) },
  { name: "stats", tab: "display", find: (r) => labelsWith(r, t.statsToggle) },
  { name: "hideNonMessage", tab: "display", find: (r) => labelsWith(r, t.hideNonMessage) },
  { name: "gridSort", tab: "display", find: (r) => Array.from(r.querySelectorAll("label.grid-sort")) },
  { name: "notificationSound", tab: "notifications", find: (r) => labelsWith(r, t.notificationSound) },
  { name: "volume", tab: "notifications", find: (r) => labelsWith(r, t.volume) },
  { name: "sessionHistory", tab: "operations", find: (r) => Array.from(r.querySelectorAll("section.session-lifecycle")) },
  { name: "retention", tab: "operations", find: (r) => Array.from(r.querySelectorAll("section.status-retention")) },
  { name: "bulkCleanup", tab: "operations", find: (r) => Array.from(r.querySelectorAll("section.bulk-reset")) },
  { name: "conversations", tab: "administration", find: (r) => Array.from(r.querySelectorAll("section.conversations")) },
  { name: "users", tab: "administration", find: (r) => Array.from(r.querySelectorAll("section.users")) },
];
const byName = (name: string) => ITEMS.find((i) => i.name === name)!;
const OPERATOR_ONLY = [
  "sessionHistory", "retention", "bulkCleanup",
  "conversations", "users",
];

describe("SettingsDrawer tabs: membership (issue 1076)", () => {
  it("membership: each of the 11 items is in exactly one panel, the expected one", async () => {
    const { target } = await render(operatorProps());
    expect(ITEMS).toHaveLength(11);
    for (const item of ITEMS) {
      const found = item.find(target);
      expect(found, `${item.name} appears once`).toHaveLength(1);
      expect(
        found[0].closest('[role="tabpanel"]')?.id,
        `${item.name} panel`,
      ).toBe(`settings-panel-${item.tab}`);
    }
  });

  it("operator: four tabs in order, one panel per tab, tabs wired to panels", async () => {
    const { target } = await render(operatorProps());
    expect(tabNames(target)).toEqual([
      t.tabDisplay, t.tabNotifications, t.tabOperations, t.tabAdministration,
    ]);
    expect(panels(target).map((p) => p.id)).toEqual([
      "settings-panel-display",
      "settings-panel-notifications",
      "settings-panel-operations",
      "settings-panel-administration",
    ]);
    for (const button of tabButtons(target)) {
      const controlled = target.querySelector(`#${button.getAttribute("aria-controls")}`);
      expect(controlled?.getAttribute("aria-labelledby")).toBe(button.id);
    }
  });
});

describe("SettingsDrawer tabs: operator gates (issue 1076)", () => {
  it("viewer: only Display and Notifications; no operator-only item is in the DOM", async () => {
    const { target } = await render();
    expect(tabNames(target)).toEqual([t.tabDisplay, t.tabNotifications]);
    expect(panels(target)).toHaveLength(2);
    for (const name of OPERATOR_ONLY) {
      expect(byName(name).find(target), `${name} absent`).toHaveLength(0);
    }
  });

  it("connection: Operations has the connection items", async () => {
    const { target } = await render({
      connection: makeConnection(),
      onOpenSessionLifecycle: vi.fn(),
    });
    expect(tabNames(target)).toEqual([
      t.tabDisplay, t.tabNotifications, t.tabOperations, t.tabAdministration,
    ]);
    for (const name of ["sessionHistory", "retention", "bulkCleanup"]) {
      expect(byName(name).find(target), `${name} present`).toHaveLength(1);
    }
  });
});

describe("SettingsDrawer tabs: fallback of the active tab (issue 1076)", () => {
  it("revoked: on Operations, losing the connection lands on Display", async () => {
    const { target, props } = await render(operatorProps());
    await select(target, t.tabOperations);
    props.connection = undefined;
    await tick();
    expect(tabNames(target)).toEqual([t.tabDisplay, t.tabNotifications]);
    expect(tab(target, t.tabDisplay).getAttribute("aria-selected")).toBe("true");
    expect(panel(target, "display")?.hidden).toBe(false);
  });

  it("administration-disappears: on Administration, losing the connection lands on Display", async () => {
    const { target, props } = await render(operatorProps());
    await select(target, t.tabAdministration);
    props.connection = undefined;
    await tick();
    expect(tabNames(target)).toEqual([t.tabDisplay, t.tabNotifications]);
    expect(tab(target, t.tabDisplay).getAttribute("aria-selected")).toBe("true");
  });
});

describe("SettingsDrawer tabs: fallback is not undone (issue 1076)", () => {
  it("fallback-sticks: after Administration disappears and returns, the selection stays on Display", async () => {
    const connection = makeConnection();
    const { target, props } = await render({ ...operatorProps(), connection });
    await select(target, t.tabAdministration);
    props.connection = undefined;
    await tick();
    props.connection = connection;
    await tick();
    expect(tab(target, t.tabAdministration)).toBeDefined();
    expect(tab(target, t.tabDisplay).getAttribute("aria-selected")).toBe("true");
    expect(tab(target, t.tabAdministration).getAttribute("aria-selected")).toBe("false");
  });
});

describe("SettingsDrawer tabs: state and structure (issue 1076)", () => {
  it("child-state-survives-tab-switch: an unsent session-history agent id survives leaving and returning", async () => {
    const { target } = await render(operatorProps());
    await select(target, t.tabOperations);
    const input = () => target.querySelector<HTMLInputElement>("#lifecycle-agent-id")!;
    const show = () =>
      target.querySelector<HTMLButtonElement>('#settings-panel-operations form button[type="submit"]')!;
    input().value = "host-a.agent-7";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(show().disabled).toBe(false);
    await select(target, t.tabDisplay);
    await select(target, t.tabOperations);
    expect(input().value).toBe("host-a.agent-7");
    expect(show().disabled).toBe(false);
  });

  it("inactive-panels-hidden: only the active panel is visible", async () => {
    const { target } = await render(operatorProps());
    expect(panels(target).map((p) => p.hidden)).toEqual([false, true, true, true]);
    await select(target, t.tabNotifications);
    expect(panels(target).map((p) => p.hidden)).toEqual([true, false, true, true]);
    expect(tabButtons(target).map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it("keyboard: arrows wrap, Home and End jump, and focus follows the selection", async () => {
    const { target } = await render(operatorProps());
    const list = target.querySelector<HTMLElement>('[role="tablist"]')!;
    const press = async (key: string) => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await tick();
    };
    const selected = () => tabButtons(target).findIndex((b) => b.getAttribute("aria-selected") === "true");
    await press("ArrowRight");
    expect(selected()).toBe(1);
    expect(document.activeElement).toBe(tabButtons(target)[1]);
    await press("End");
    expect(selected()).toBe(3);
    await press("ArrowRight");
    expect(selected()).toBe(0);
    await press("ArrowLeft");
    expect(selected()).toBe(3);
    await press("Home");
    expect(selected()).toBe(0);
    expect(document.activeElement).toBe(tabButtons(target)[0]);
  });

  it("modals-outside-panels: both confirmations and logout live outside every panel and stay open across a tab switch", async () => {
    const { target } = await render({
      ...operatorProps(),
      agents: {
        "host-a.p": { state: "idle" } as unknown as Envelope,
      },
    });
    await vi.waitFor(() => {
      expect(target.querySelector(".conv-close")).not.toBeNull();
    });
    await select(target, t.tabAdministration);
    target.querySelector<HTMLButtonElement>(".conv-close")!.click();
    await tick();
    const closeDialog = document.querySelector<HTMLDialogElement>(
      `dialog[aria-label="${t.confirmCloseAria}"]`,
    )!;
    expect(closeDialog).not.toBeNull();
    expect(closeDialog.closest('[role="tabpanel"]')).toBeNull();
    await select(target, t.tabDisplay);
    expect(closeDialog.hasAttribute("open")).toBe(true);
    expect(closeDialog.closest("[hidden]")).toBeNull();
    closeDialog.querySelector<HTMLButtonElement>("button.cancel")!.click();
    await tick();

    await select(target, t.tabOperations);
    target.querySelector<HTMLButtonElement>("section.bulk-reset button.danger")!.click();
    await vi.waitFor(() => {
      expect(
        document.querySelector(`dialog[aria-label="${t.bulkConfirmAria}"]`),
      ).not.toBeNull();
    });
    const bulkDialog = document.querySelector<HTMLDialogElement>(
      `dialog[aria-label="${t.bulkConfirmAria}"]`,
    )!;
    expect(bulkDialog.closest('[role="tabpanel"]')).toBeNull();
    await select(target, t.tabNotifications);
    expect(bulkDialog.hasAttribute("open")).toBe(true);
    expect(bulkDialog.closest("[hidden]")).toBeNull();

    const logout = Array.from(target.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === t.logout,
    )!;
    expect(logout.closest('[role="tabpanel"]')).toBeNull();
    expect(logout.closest("[hidden]")).toBeNull();
  });

  it("i18n: the tab names and the tablist label follow the language", async () => {
    const { target } = await render(operatorProps());
    expect(tabNames(target)).toEqual([ja.settingsDrawer.tabDisplay, ja.settingsDrawer.tabNotifications, ja.settingsDrawer.tabOperations, ja.settingsDrawer.tabAdministration]);
    setLocale("en");
    await tick();
    expect(tabNames(target)).toEqual(["Display", "Notifications", "Operations", "Administration"]);
    expect(tabNames(target)).toEqual([
      en.settingsDrawer.tabDisplay, en.settingsDrawer.tabNotifications,
      en.settingsDrawer.tabOperations, en.settingsDrawer.tabAdministration,
    ]);
    expect(
      target.querySelector('[role="tablist"]')?.getAttribute("aria-label"),
    ).toBe("Settings sections");
  });
});
