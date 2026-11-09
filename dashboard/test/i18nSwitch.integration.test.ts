import "./isolation.setup";
// @vitest-environment jsdom
// Issue #269: the language switch repaints without a reload, and "auto" is
// wired to the browser's language list. The tests start in ja (locale.setup.ts)
// and name the elements they read by role or class and the table key.
import { mount, tick, unmount, type Component } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KaoiroHandlers } from "../src/lib/protocol";
import AgentCard from "../src/lib/AgentCard.svelte";
import ResponseTimeline from "../src/lib/ResponseTimeline.svelte";
import StatusLinePanel from "../src/lib/StatusLinePanel.svelte";
import { headOmittedText } from "../src/lib/statusLine";
import { formatRelative } from "../src/lib/relativeTime";
import { en } from "../src/lib/i18n/en";
import { ja } from "../src/lib/i18n/ja";
import { currentLocale, msg, setLocale } from "../src/lib/i18n/index.svelte";
import { SETTINGS_STORAGE_KEY } from "../src/lib/settings.svelte";
import {
  createDeviceFake,
  installDeviceFetch,
} from "./deviceApprovalFake";

vi.mock("../src/lib/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/protocol")>()),
  connectKaoiro: (_url: string, _handlers: KaoiroHandlers) => ({
    disconnect: vi.fn(),
    notifyOnline: vi.fn(),
    reconnect: vi.fn(),
  }),
}));
const App = (await import("../src/App.svelte")).default;

const mounted: object[] = [];

beforeEach(() => {
  history.replaceState(null, "", "/");
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  installDeviceFetch(createDeviceFake({ loggedIn: false }));
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render<P extends Record<string, any>>(
  component: Component<P>,
  props: P,
) {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(component, { target, props }));
  await tick();
  return target;
}

describe("functions and tables", () => {
  const ts = "2026-07-23T14:00:00Z";
  const now = Date.parse("2026-07-23T15:00:00Z");

  it("formatRelative and headOmittedText follow the locale at call time", () => {
    setLocale("ja");
    expect(formatRelative(ts, now)).toBe(ja.time.hoursAgo({ n: 1 }));
    expect(headOmittedText()).toBe(ja.statusLine.headOmitted);
    setLocale("en");
    expect(formatRelative(ts, now)).toBe(en.time.hoursAgo({ n: 1 }));
    expect(formatRelative(ts, now)).toBe("1 hour ago");
    expect(headOmittedText()).toBe(en.statusLine.headOmitted);
    setLocale("ja");
    expect(formatRelative(ts, now)).toBe("1 時間前");
  });
});

describe("screens repaint on setLocale", () => {
  it("login screen: heading note, placeholder and aria-label, submit", async () => {
    mounted.push(mount(App, { target: document.body }));
    await vi.waitFor(() => expect(document.querySelector(".login-card")).not.toBeNull());
    const note = () => document.querySelector(".login-note")?.textContent?.trim();
    const input = () => document.querySelector<HTMLInputElement>('input[type="password"]')!;
    const submit = () => document.querySelector<HTMLButtonElement>('.login-card button[type="submit"]')!;

    expect(note()).toBe(ja.app.loginEnterToken);
    expect(input().placeholder).toBe(ja.app.tokenPlaceholder);
    expect(input().getAttribute("aria-label")).toBe(ja.app.tokenAria);
    expect(submit().textContent?.trim()).toBe(ja.app.loginSubmit);
    expect(document.documentElement.lang).toBe("ja");

    setLocale("en");
    await tick();
    expect(note()).toBe(en.app.loginEnterToken);
    expect(input().placeholder).toBe(en.app.tokenPlaceholder);
    expect(input().getAttribute("aria-label")).toBe(en.app.tokenAria);
    expect(submit().textContent?.trim()).toBe(en.app.loginSubmit);
    expect(document.documentElement.lang).toBe("en");
  });

  it("login screen: the language select switches and keeps the choice", async () => {
    mounted.push(mount(App, { target: document.body }));
    await vi.waitFor(() => expect(document.querySelector(".login-card .language select")).not.toBeNull());
    const select = document.querySelector<HTMLSelectElement>(".login-card .language select")!;
    expect([...select.options].map((o) => o.value)).toEqual(["auto", "ja", "en"]);
    expect(select.value).toBe("ja");

    select.value = "en";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(currentLocale()).toBe("en");
    expect(document.querySelector(".login-note")?.textContent?.trim()).toBe(en.app.loginEnterToken);
    expect(document.documentElement.lang).toBe("en");
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!).locale).toBe("en");
  });

  it("AgentCard: aria-labels, buttons and the offline label", async () => {
    const envelope = {
      version: "0",
      agent_id: "host-a.p",
      ts: "2026-08-04T10:00:00Z",
      type: "state_change",
      state: "disconnected",
      payload: {},
      persona: { id: "p", name: "P", sprite_set: "p" },
    };
    const target = await render(AgentCard, {
      envelope,
      onRestore: async () => {},
      onDelete: async () => {},
    });
    const name = "host-a.p";
    const restore = () => target.querySelector<HTMLButtonElement>("button.restore")!;
    const remove = () => target.querySelector<HTMLButtonElement>("button.remove")!;
    const open = () => target.querySelector<HTMLButtonElement>("button.open")!;

    expect(restore().getAttribute("aria-label")).toBe(ja.agentCard.restoreAria({ name }));
    expect(restore().querySelector(".restore-label")?.textContent).toBe(ja.agentCard.restore);
    expect(remove().getAttribute("title")).toBe(ja.agentCard.deleteTitle);
    expect(open().getAttribute("aria-label")).toBe(ja.agentCard.openDetail({ name }));

    setLocale("en");
    await tick();
    expect(restore().getAttribute("aria-label")).toBe("Restore host-a.p");
    expect(restore().querySelector(".restore-label")?.textContent).toBe("Restore");
    expect(remove().getAttribute("title")).toBe(en.agentCard.deleteTitle);
    expect(open().getAttribute("aria-label")).toBe("Open details of host-a.p");
  });

  it("AgentCard: the delete confirmation is worded by the locale", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    window.confirm = confirm;
    const target = await render(AgentCard, {
      envelope: {
        version: "0",
        agent_id: "host-a.p",
        ts: "2026-08-04T10:00:00Z",
        type: "state_change",
        state: "disconnected",
        payload: {},
        persona: { id: "p", name: "P", sprite_set: "p" },
      },
      onDelete: async () => {},
    });
    setLocale("en");
    await tick();
    target.querySelector<HTMLButtonElement>("button.remove")!.click();
    expect(confirm).toHaveBeenCalledWith(en.agentCard.deleteConfirm({ name: "host-a.p" }));
  });

  it("ResponseTimeline: title, aria-label and the empty state", async () => {
    const target = await render(ResponseTimeline, {
      agents: {},
      logs: {},
      now: Date.parse("2026-07-23T15:00:00Z"),
      onSelectAgent: () => {},
    });
    const aside = () => target.querySelector("aside.timeline")!;
    expect(aside().getAttribute("aria-label")).toBe(ja.responseTimeline.title);
    expect(target.querySelector("h2.title")?.textContent).toBe(ja.responseTimeline.title);
    expect(target.querySelector(".empty")?.textContent).toBe(ja.responseTimeline.empty);

    setLocale("en");
    await tick();
    expect(aside().getAttribute("aria-label")).toBe("Conversation timeline");
    expect(target.querySelector("h2.title")?.textContent).toBe("Conversation timeline");
    expect(target.querySelector(".empty")?.textContent).toBe("No conversations yet");
  });

  it("StatusLinePanel: heading and unset line", async () => {
    const target = await render(StatusLinePanel, {
      view: { kind: "unset", cleared: false },
    });
    expect(target.querySelector("h3")?.textContent).toBe(ja.statusLinePanel.title);
    expect(target.querySelector(".unset")?.textContent).toBe(ja.statusLine.unset);
    setLocale("en");
    await tick();
    expect(target.querySelector("h3")?.textContent).toBe("Status line");
    expect(target.querySelector(".unset")?.textContent).toBe("Not set");
  });
});

describe("auto", () => {
  it("resolves through the browser's languages (jsdom reports en-US)", () => {
    setLocale("auto");
    expect(navigator.languages[0]).toBe("en-US");
    expect(currentLocale()).toBe("en");
    expect(msg().common.close).toBe(en.common.close);
  });
});
