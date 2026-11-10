import "./isolation.setup";
// @vitest-environment jsdom
// Issue 1075: the AgentDetail detail area is split into an engine tab and a
// kaoiro tab. Both panels stay mounted; the inactive one is `hidden`. jsdom
// has no layout, so visibility is read from the `hidden` property here and
// pinned in the browser by e2e/detailTabs.spec.ts.
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import {
  SETTINGS_STORAGE_KEY,
  loadSettings,
  updateSettings,
} from "../src/lib/settings.svelte";
import {
  ITEM_SELECTORS,
  connection,
  envelope,
  renderInput,
  unmountAll,
  type InputName,
  type Rendered,
} from "./fixtures/agentDetailTabInputs";
import { makeReactiveAgentDetailProps } from "./reactiveProps.svelte";

const rendered: Rendered[] = [];
const mounted: object[] = [];

beforeEach(() => {
  localStorage.clear();
  updateSettings({ detailTab: "engine" });
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
});

afterEach(async () => {
  await unmountAll(rendered);
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function show(name: InputName): Promise<HTMLElement> {
  const r = await renderInput(name);
  rendered.push(r);
  return r.target;
}

function panel(target: HTMLElement, tab: "engine" | "kaoiro"): HTMLElement {
  const el = target.querySelector<HTMLElement>(`#agent-detail-panel-${tab}`);
  if (el === null) throw new Error(`no ${tab} panel`);
  return el;
}

/** The dt labels and marker items inside `root`, sorted. */
function items(root: Element): string[] {
  const dts = [...root.querySelectorAll("dt")].map((dt) => dt.textContent?.trim() ?? "");
  const markers = ITEM_SELECTORS.flatMap((sel) =>
    [...root.querySelectorAll(sel)].map(() => sel),
  );
  return [...dts, ...markers].sort();
}

// Expected placement per input. The union of the inputs holds all 19 row
// kinds of the status panel (measured at the base before the split).
const ENGINE_CLAUDE = ["model", "effort", "switch", "cwd", "engine", "resume", "作業意図", "fast"];
const KAOIRO_FULL = ["wrapper", "IA 配送", ".session-lifecycle-open", ".delivery-policy"];
const EXPECTED: Record<
  Exclude<InputName, "I1r">,
  { engine: string[]; kaoiro: string[] }
> = {
  I0: { engine: ["model", "effort", ".resume-swap", ".terminate"], kaoiro: [".clear-history"] },
  I1c: {
    engine: [...ENGINE_CLAUDE, ".resume-swap", ".terminate"],
    kaoiro: [...KAOIRO_FULL, ".clear-history"],
  },
  I1x: {
    engine: [
      "model", "effort", "engine", "実効書込範囲", "network_access", "sandbox 変更",
      "network 変更", "承認 変更", "権限要求", "権限要求エラー", ".resume-swap", ".terminate",
    ],
    kaoiro: [".clear-history"],
  },
  I1u: {
    engine: [
      "model", "effort", "engine", "実効書込範囲", "過去の観測", "network_access",
      "sandbox 変更", "network 変更", "承認 変更", "権限要求", ".resume-swap", ".terminate",
    ],
    kaoiro: [".clear-history"],
  },
  I1g: {
    engine: ["model", "effort", "engine", "grok policy", ".resume-swap", ".terminate"],
    kaoiro: [".clear-history"],
  },
  I2: {
    engine: [...ENGINE_CLAUDE, ".resume-swap", ".restore", ".remove"],
    kaoiro: [...KAOIRO_FULL, ".clear-history"],
  },
  I3: {
    engine: ENGINE_CLAUDE.filter((label) => label !== "effort"),
    kaoiro: KAOIRO_FULL,
  },
};

describe("AgentDetail detail tabs (issue 1075)", () => {
  it.each(["I0", "I1c", "I1x", "I1u", "I1g", "I2", "I3"] as const)(
    "%s: every item sits in its panel",
    async (name) => {
      const target = await show(name);
      const scroll = target.querySelector(".status-scroll")!;

      expect(items(panel(target, "engine"))).toEqual([...EXPECTED[name].engine].sort());
      expect(items(panel(target, "kaoiro"))).toEqual([...EXPECTED[name].kaoiro].sort());
      // Nothing else in the scroll area outside the two panels.
      expect(items(scroll)).toEqual(
        [...EXPECTED[name].engine, ...EXPECTED[name].kaoiro].sort(),
      );
    },
  );

  it("puts delete in the engine panel and nowhere above the composer", async () => {
    const target = await show("I2");

    expect(panel(target, "engine").querySelectorAll(".remove")).toHaveLength(1);
    expect(target.querySelectorAll(".remove")).toHaveLength(1);
    expect(target.querySelector(".main .remove")).toBeNull();
  });

  it("keeps interrupt above the composer", async () => {
    const target = await show("I1r");

    expect(target.querySelectorAll(".interrupt")).toHaveLength(1);
    expect(target.querySelector(".main .interrupt")).not.toBeNull();
    expect(target.querySelector(".status-scroll .interrupt")).toBeNull();
  });

  it.each(["I0", "I1c", "I2", "I3"] as const)(
    "%s: the tab bar is shown exactly with a connection, and then no panel is empty",
    async (name) => {
      const target = await show(name);
      const hasConnection = name !== "I3";

      expect(target.querySelectorAll('[role="tablist"]')).toHaveLength(hasConnection ? 1 : 0);
      if (hasConnection) {
        expect(items(panel(target, "engine")).length).toBeGreaterThan(0);
        expect(items(panel(target, "kaoiro")).length).toBeGreaterThan(0);
      }
    },
  );

  it("without a connection shows both panels and no tabs", async () => {
    const target = await show("I3");

    expect(target.querySelector('[role="tab"]')).toBeNull();
    expect(panel(target, "engine").hidden).toBe(false);
    expect(panel(target, "kaoiro").hidden).toBe(false);
    expect(panel(target, "engine").getAttribute("role")).toBeNull();
  });

  it("shows the engine tab first and hides the other panel", async () => {
    const target = await show("I1c");
    const tabs = [...target.querySelectorAll<HTMLElement>('[role="tab"]')];

    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(tabs.map((t) => t.getAttribute("aria-controls"))).toEqual([
      "agent-detail-panel-engine",
      "agent-detail-panel-kaoiro",
    ]);
    expect(panel(target, "engine").hidden).toBe(false);
    expect(panel(target, "kaoiro").hidden).toBe(true);
    expect(panel(target, "kaoiro").getAttribute("aria-labelledby")).toBe(
      "agent-detail-tab-kaoiro",
    );
  });

  it("stores a clicked tab so a reload reads it", async () => {
    const target = await show("I1c");
    target.querySelector<HTMLElement>("#agent-detail-tab-kaoiro")!.click();
    await tick();

    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!).detailTab).toBe("kaoiro");
    expect(loadSettings().detailTab).toBe("kaoiro");
    expect(panel(target, "engine").hidden).toBe(true);
    expect(panel(target, "kaoiro").hidden).toBe(false);
  });

  it("keeps the shown tab when the detail switches agent", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const props = makeReactiveAgentDetailProps({
      envelope: envelope(undefined, "idle", "host-a.p"),
      connection: connection(),
      onClose: vi.fn(),
    });
    mounted.push(mount(AgentDetail, { target, props }));
    await tick();
    target.querySelector<HTMLElement>("#agent-detail-tab-kaoiro")!.click();
    await tick();

    props.envelope = envelope(undefined, "idle", "host-b.q");
    await tick();
    flushSync();

    expect(target.querySelector("#agent-detail-tab-kaoiro")?.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(panel(target, "kaoiro").hidden).toBe(false);
  });

  it("moves selection and focus with the arrow keys, Home and End", async () => {
    const target = await show("I1c");
    const tab = (name: string) => target.querySelector<HTMLElement>(`#agent-detail-tab-${name}`)!;
    const press = async (key: string) => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
      await tick();
    };
    tab("engine").focus();

    const seen: string[] = [];
    for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft", "End", "Home"]) {
      await press(key);
      seen.push(`${key}:${document.activeElement?.id}:${tab("kaoiro").getAttribute("aria-selected")}`);
    }
    expect(seen).toEqual([
      "ArrowRight:agent-detail-tab-kaoiro:true",
      "ArrowRight:agent-detail-tab-engine:false",
      "ArrowLeft:agent-detail-tab-kaoiro:true",
      "End:agent-detail-tab-kaoiro:true",
      "Home:agent-detail-tab-engine:false",
    ]);
    expect(tab("engine").tabIndex).toBe(0);
    expect(tab("kaoiro").tabIndex).toBe(-1);
  });

  it("keeps an open resume picker open across a tab switch", async () => {
    const target = await show("I1c");
    target.querySelector<HTMLElement>(".resume-swap")!.click();
    await tick();
    expect(target.querySelector(".resume-menu")).not.toBeNull();

    target.querySelector<HTMLElement>("#agent-detail-tab-kaoiro")!.click();
    await tick();
    target.querySelector<HTMLElement>("#agent-detail-tab-engine")!.click();
    await tick();

    expect(target.querySelector(".resume-menu")).not.toBeNull();
  });
});
