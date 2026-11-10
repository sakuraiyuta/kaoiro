import "./isolation.setup";
// @vitest-environment jsdom
// Issue 1074: the ctx / rate-limit gauges and the status line live in a pinned
// area that AgentDetail mounts at two fixed places (under the agent ID and
// above the log). jsdom applies no media queries, so both copies are in the
// DOM here; which one is displayed is pinned by e2e/pinnedStatus.spec.ts.
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import type { Envelope, KaoiroConnection } from "../src/lib/protocol";
import type { StatusLineView } from "../src/lib/statusLine";
import { makeReactiveAgentDetailProps } from "./reactiveProps.svelte";

const mounted: object[] = [];

// jsdom has no layout: a drawn head "overflows" its three clamped lines when
// its text is longer than this many characters.
const OVERFLOW_AT = 40;

interface FakeObserver {
  observed: Element[];
  disconnected: boolean;
}
const observers: FakeObserver[] = [];

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  observers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly record: FakeObserver = { observed: [], disconnected: false };
      constructor() {
        observers.push(this.record);
      }
      observe(el: Element): void {
        this.record.observed.push(el);
      }
      disconnect(): void {
        this.record.disconnected = true;
      }
      unobserve(): void {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("body") ? 20 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.classList.contains("body")) return 0;
    return (this.textContent ?? "").length > OVERFLOW_AT ? 60 : 20;
  });
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function connection(): KaoiroConnection {
  return {
    spawn: vi.fn(),
    enumerateSessions: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    refreshModels: vi.fn(async () => ({
      agent_id: "host-a.p",
      request_id: "test",
      ok: true,
      models_count: 0,
    })),
    refreshEngineCatalog: vi.fn(),
  } as unknown as KaoiroConnection;
}

const GAUGE_EXT = {
  context: { used_percentage: 42, used_tokens: 84_000, max_tokens: 200_000 },
  rate_limits: { five_hour: { utilization: 0.3, resets_at: 4_102_444_800 } },
  session_capabilities: {
    supports_attachments: true,
    supports_user_input_dialog: true,
    supports_context_usage: true,
  },
};

function envelope(agentId: string, ext: Record<string, unknown>): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: "2026-11-10T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext,
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

function line(head: string): StatusLineView {
  return {
    kind: "set",
    head,
    truncated: false,
    bytes: head.length,
    updatedAt: "2026-11-10T00:00:00.000000Z",
  };
}

const LONG = "working on issue 1074: " + "pinned gauges ".repeat(6);
const SHORT = "idle";

async function render(opts: {
  ext?: Record<string, unknown>;
  statusLine?: StatusLineView;
  withConnection?: boolean;
}) {
  const target = document.createElement("div");
  document.body.append(target);
  const props = makeReactiveAgentDetailProps({
    envelope: envelope("host-a.p", opts.ext ?? GAUGE_EXT),
    connection: (opts.withConnection ?? true) ? connection() : (undefined as never),
    onClose: vi.fn(),
    statusLine: opts.statusLine ?? { kind: "none" },
  });
  const component = mount(AgentDetail, { target, props });
  mounted.push(component);
  await tick();
  flushSync();
  return { target, props, component };
}

function copies(target: Element): HTMLElement[] {
  return [...target.querySelectorAll<HTMLElement>("[data-placement]")];
}

function copy(target: Element, placement: "head" | "main"): HTMLElement {
  const el = target.querySelector<HTMLElement>(`[data-placement="${placement}"]`);
  if (el === null) throw new Error(`no ${placement} copy`);
  return el;
}

function dtTexts(root: Element): string[] {
  return [...root.querySelectorAll("dt")].map((dt) => dt.textContent?.trim() ?? "");
}

async function settle(): Promise<void> {
  await tick();
  flushSync();
}

describe("AgentDetail pinned area (issue 1074)", () => {
  it("is mounted exactly twice, under the agent ID and above the log", async () => {
    const { target } = await render({ statusLine: line(SHORT) });

    expect(copies(target).map((el) => el.dataset.placement)).toEqual(["head", "main"]);
    expect(copy(target, "head").closest("header.head")).not.toBeNull();
    expect(copy(target, "main").closest(".main")).not.toBeNull();
  });

  it("moves the ctx and rate rows and the status line out of the scrolling column", async () => {
    const { target } = await render({ statusLine: line(SHORT) });
    const scroll = target.querySelector(".status-scroll")!;

    expect(dtTexts(scroll)).not.toContain("ctx");
    expect(dtTexts(scroll)).not.toContain("5h");
    expect(dtTexts(scroll)).not.toContain("7day");
    expect(scroll.querySelector(".status-line-panel")).toBeNull();
    for (const placement of ["head", "main"] as const) {
      const texts = dtTexts(copy(target, placement));
      expect(texts.filter((t) => t === "ctx")).toHaveLength(1);
      expect(texts.filter((t) => t === "5h")).toHaveLength(1);
      expect(texts.filter((t) => t === "7day")).toHaveLength(1);
      expect(copy(target, placement).querySelectorAll(".status-line-panel")).toHaveLength(1);
    }
  });

  it("draws nothing when the cc panel is closed and there is no status line", async () => {
    const { target } = await render({ ext: {}, withConnection: false });

    expect(copies(target)).toHaveLength(0);
    expect(target.querySelector("dl.cc")).toBeNull();
  });

  it("offers no expand toggle while the head fits in three lines", async () => {
    const { target } = await render({ statusLine: line(SHORT) });

    expect(target.querySelector(".expand")).toBeNull();
  });

  it("offers the toggle on overflow, pointing at its own copy's head", async () => {
    const { target } = await render({ statusLine: line(LONG) });

    const ids = new Set<string>();
    for (const placement of ["head", "main"] as const) {
      const root = copy(target, placement);
      const toggle = root.querySelector<HTMLButtonElement>("button.expand");
      expect(toggle?.textContent).toBe("全文を表示");
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      const body = root.querySelector<HTMLElement>(".status-line-panel .body")!;
      expect(toggle?.getAttribute("aria-controls")).toBe(body.id);
      expect(body.classList.contains("clamped")).toBe(true);
      ids.add(body.id);
    }
    expect(ids.size).toBe(2);
    expect([...ids].every((id) => document.querySelectorAll(`#${id}`).length === 1)).toBe(true);
  });

  it("shares the expanded state between the copies and resets it for another agent", async () => {
    const { target, props } = await render({ statusLine: line(LONG) });

    copy(target, "main").querySelector<HTMLButtonElement>("button.expand")!.click();
    await settle();
    for (const placement of ["head", "main"] as const) {
      const toggle = copy(target, placement).querySelector("button.expand");
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      expect(toggle?.textContent).toBe("折りたたむ");
      expect(copy(target, placement).querySelector(".body")?.classList.contains("expanded")).toBe(true);
    }

    props.envelope = envelope("host-b.q", GAUGE_EXT);
    await settle();
    for (const placement of ["head", "main"] as const) {
      expect(copy(target, placement).querySelector("button.expand")?.getAttribute("aria-expanded")).toBe(
        "false",
      );
    }
  });

  it("shows the toggle when a line is first set after the view opened", async () => {
    const { target, props } = await render({ statusLine: { kind: "none" } });
    expect(target.querySelector(".expand")).toBeNull();

    props.statusLine = line(LONG);
    await settle();
    expect(copy(target, "head").querySelector("button.expand")).not.toBeNull();
  });

  it("re-measures when a drawn head is replaced by a longer one", async () => {
    const { target, props } = await render({ statusLine: line(SHORT) });
    expect(target.querySelector(".expand")).toBeNull();

    props.statusLine = line(LONG);
    await settle();
    expect(copy(target, "head").querySelector("button.expand")).not.toBeNull();
    expect(copy(target, "main").querySelector("button.expand")).not.toBeNull();
  });

  it("offers no toggle when the head has nothing left to draw", async () => {
    const { target } = await render({
      statusLine: {
        kind: "set",
        head: "",
        truncated: true,
        bytes: 4096,
        updatedAt: "2026-11-10T00:00:00.000000Z",
      },
    });

    expect(target.querySelector(".status-line-panel .body")).toBeNull();
    expect(target.querySelector(".expand")).toBeNull();
  });

  it("disconnects every overflow observer it created", async () => {
    const { component } = await render({ statusLine: line(LONG) });
    expect(observers.length).toBeGreaterThanOrEqual(2);

    await unmount(component);
    mounted.splice(mounted.indexOf(component), 1);
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });

  it("toggles the narrow-layout disclosure on click only", async () => {
    const { target } = await render({ statusLine: line(SHORT) });
    const main = copy(target, "main");
    const disclosure = main.querySelector<HTMLButtonElement>("button.disclosure")!;

    expect(main.dataset.open).toBe("false");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.getAttribute("aria-controls")).toBe(main.querySelector(".pinned-body")?.id);
    disclosure.click();
    await settle();
    expect(main.dataset.open).toBe("true");
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    disclosure.click();
    await settle();
    expect(main.dataset.open).toBe("false");
  });
});
