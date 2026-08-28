// @vitest-environment jsdom
// #184: AgentDetail render-windows the transcript to LOG_WINDOW_SIZE (200)
// entries by default instead of DOM'ing the full history. ふじ round-1 review
// (must-fix M1/M2/M3, S1) required these cases because the original diff
// shipped with zero tests for the new behaviour; round-2 review found the
// round-1 rework still needed a tail/reading-frozen/explicit-expanded
// distinction (M1), a shrink guard (M2), and a real scrollTop assertion
// (S1) — this file covers both rounds.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import { conversationEntryKey } from "../src/lib/conversationTimeline";
import { renderMermaidIn } from "../src/lib/markdown";
import type { Envelope } from "../src/lib/protocol";
import { updateSettings } from "../src/lib/settings.svelte";
import { makeReactiveTimelineDetailProps } from "./reactiveProps.svelte";

// vi.mock calls are hoisted above every import in this file (including
// AgentDetail.svelte's own "./markdown" import), so this replaces the real
// renderMermaidIn everywhere it's used regardless of source order.
vi.mock("../src/lib/markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/markdown")>();
  return { ...actual, renderMermaidIn: vi.fn(async () => undefined) };
});

const LOG_WINDOW_SIZE = 200;
const ROW_PX = 30; // synthetic per-row height for the geometry mocks below

let component: object | null = null;
let originalScrollTo: PropertyDescriptor | undefined;
let originalScrollIntoView: PropertyDescriptor | undefined;
let originalClientHeight: PropertyDescriptor | undefined;
let originalScrollHeight: PropertyDescriptor | undefined;
let originalScrollTopDescriptor: PropertyDescriptor | undefined;
let scrollTopStore: WeakMap<Element, number> | null = null;

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  // jsdom does not implement CSS.escape (no prior test in this suite exercised
  // jumpToTool, which calls it to build the partner-lookup selector); the
  // tuid values in this file need no real escaping, so identity is enough.
  if (typeof globalThis.CSS === "undefined") {
    (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
      escape: (s: string) => s,
    };
  } else if (typeof globalThis.CSS.escape !== "function") {
    globalThis.CSS.escape = (s: string) => s;
  }
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  updateSettings({ hideNonMessageLogEntries: false });
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  // clearAllMocks resets call history but not a custom mockImplementation
  // (round-3 S2's deferred-mermaid test installs one) — restore the
  // vi.mock factory's default so later tests see the normal resolved mock.
  vi.mocked(renderMermaidIn).mockImplementation(async () => undefined);
  for (const [prop, orig] of [
    ["scrollTo", originalScrollTo],
    ["scrollIntoView", originalScrollIntoView],
    ["clientHeight", originalClientHeight],
    ["scrollHeight", originalScrollHeight],
    ["scrollTop", originalScrollTopDescriptor],
  ] as const) {
    if (orig) {
      Object.defineProperty(HTMLElement.prototype, prop, orig);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  }
  originalScrollTo = undefined;
  originalScrollIntoView = undefined;
  originalClientHeight = undefined;
  originalScrollHeight = undefined;
  originalScrollTopDescriptor = undefined;
  scrollTopStore = null;
});

function state(agentId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name: agentId, sprite_set: agentId },
    ts: "2026-07-01T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext: {},
  };
}

// All within the same UTC minute-range so every entry falls on the same
// calendar day regardless of the test runner's local timezone (test 6
// relies on there being NO real day change anywhere in the array). Real
// Date arithmetic (not a hand-rolled "00:MM:SS" template) so this never
// silently overflows into an Invalid Date past minute 59 (ふじ round-2 N1
// caught the same pattern in bench/harness.ts).
const BASE_TS_MS = Date.parse("2026-07-01T00:00:00Z");
function tsFor(seq: number): string {
  return new Date(BASE_TS_MS + seq * 1000).toISOString();
}

function assistantLog(agentId: string, seq: number): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: tsFor(seq),
    seq,
    type: "log",
    state: "thinking",
    payload: { kind: "assistant", text: `msg ${seq}` },
  };
}

function buildLogs(agentId: string, count: number): Envelope[] {
  return Array.from({ length: count }, (_, seq) => assistantLog(agentId, seq));
}

function toolUse(agentId: string, seq: number, tuid: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: tsFor(seq),
    seq,
    type: "log",
    state: "tool_running",
    payload: { kind: "tool_use", tool_name: "Bash", tool_use_id: tuid, input: {} },
  };
}

function toolResult(agentId: string, seq: number, tuid: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: tsFor(seq),
    seq,
    type: "log",
    state: "tool_running",
    payload: { kind: "tool_result", tool_name: "Bash", tool_use_id: tuid, output: "ok" },
  };
}

function stubScrollTo(): void {
  originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
}

function stubScrollIntoView(): void {
  originalScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
}

// Real scroll geometry so scrollTop actually clamps to [0, scrollHeight -
// clientHeight] like a real browser (jsdom does neither by default — a
// plain unclamped property). scrollHeight is derived from the LIVE
// `.transcript-entry` count, so it shrinks/grows exactly as the render
// window does, letting a clamp-vs-no-clamp assertion mean something (ふじ
// round-2 S1: the previous round-trip test asserted entry count only, never
// scrollTop, so it could not have caught the M2 clamping regression).
function installScrollGeometry(): void {
  originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTop",
  );
  scrollTopStore = new WeakMap();
  const store = scrollTopStore;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("log") ? 400 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("log")
        ? this.querySelectorAll(".transcript-entry").length * ROW_PX
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return store.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      store.set(this, Math.max(0, Math.min(value, max)));
    },
  });
}

function scrollLogTo(logEl: HTMLElement, top: number): void {
  logEl.scrollTop = top;
  logEl.dispatchEvent(new Event("scroll"));
}

async function renderReactive(props: Parameters<typeof makeReactiveTimelineDetailProps>[0]) {
  const target = document.createElement("div");
  document.body.append(target);
  const reactiveProps = makeReactiveTimelineDetailProps(props);
  component = mount(AgentDetail, { target, props: reactiveProps });
  await tick();
  return { target, props: reactiveProps };
}

describe("AgentDetail log render window (#184)", () => {
  it(`既定では直近 ${LOG_WINDOW_SIZE} 件のみ描画する (1000+ 件相当)`, async () => {
    const logs = buildLogs("agent-a", 1000);
    const { target } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    expect(target.querySelectorAll(".transcript-entry").length).toBe(LOG_WINDOW_SIZE);
    expect(target.querySelector(".load-earlier")?.textContent).toContain("800");
  });

  it("「以前のログを表示」で全件展開する", async () => {
    const logs = buildLogs("agent-a", 1000);
    const { target } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    (target.querySelector(".load-earlier") as HTMLButtonElement).click();
    await tick();
    await Promise.resolve();
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(1000);
    expect(target.querySelector(".load-earlier")).toBeNull();
  });

  it("全件展開後、ログ追記があっても展開状態を維持する (explicit-expanded, M1)", async () => {
    const logs = buildLogs("agent-a", 1000);
    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    (target.querySelector(".load-earlier") as HTMLButtonElement).click();
    await tick();
    await Promise.resolve();
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(1000);

    // A "keep last N" count would silently re-derive a non-zero start once
    // logs.length grows again — that regression is exactly what M1 fixed.
    // An explicit "show all" must NEVER collapse back, unlike a reading
    // freeze (see the next test).
    props.logs = [...props.logs, ...buildLogs("agent-a", 5).map((e, i) => ({
      ...e,
      seq: 1000 + i,
      ts: tsFor(1000 + i),
    }))];
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(1005);
    expect(target.querySelector(".load-earlier")).toBeNull();
  });

  it("reading-frozen は append 中でも既読行を保持し、bottom 復帰で tail(200) へ戻る (round-2 M1)", async () => {
    installScrollGeometry();
    const logs = buildLogs("agent-a", 1000);
    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    const logEl = target.querySelector(".log") as HTMLElement;
    expect(target.querySelectorAll(".transcript-entry").length).toBe(200);

    // Scroll away from the bottom (distance from bottom = scrollHeight(200*30)
    // - 0 - clientHeight(400) = 5600, well past the 8px threshold) to freeze
    // the window at its current boundary (absolute index 800 of 1000).
    scrollLogTo(logEl, 0);
    await tick();

    // Append 50 more entries while mid-read: the frozen start (800) must not
    // move, so the rows being read stay in the DOM (no silent eviction) and
    // the visible count simply grows by the appended entries (200 -> 250).
    props.logs = [...props.logs, ...buildLogs("agent-a", 50).map((e, i) => ({
      ...e,
      seq: 1000 + i,
      ts: tsFor(1000 + i),
    }))];
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(250);

    // Scroll back to the bottom of the NOW 250-row window (scrollHeight =
    // 250*30 = 7500, clientHeight 400 -> bottom = 7100). Unlike the explicit
    // "show all" case above, a reading-freeze must revert to tail once the
    // operator returns to the bottom — otherwise a long mid-read session
    // slowly regrows the exact unbounded render #184 was meant to remove.
    scrollLogTo(logEl, 7100);
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(200);
  });

  // issue #228 round-2 must-fix (ふじ probe): freezing at a displayableLogs
  // POSITION (round-1's shape) broke the moment the hide setting toggled
  // and displayableLogs itself changed size — 800 tool_use + 200 assistant,
  // freeze at position 800, toggle hide on -> displayableLogs shrinks to
  // the 200 assistant entries alone, and the stale "800" (now past the end
  // of a 200-entry array) sliced to an empty render. frozenWindow.start now
  // holds the raw logs[] index instead, re-mapped against whichever
  // displayableLogs currently is.
  it("reading-frozen 中に hide 設定を live toggle しても assistant 行が消えない (round-2 must-fix)", async () => {
    installScrollGeometry();
    const logs = [
      ...Array.from({ length: 800 }, (_, i) => toolUse("agent-a", i, `tuid-${i}`)),
      ...Array.from({ length: 200 }, (_, i) => assistantLog("agent-a", 800 + i)),
    ];
    const { target } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    const logEl = target.querySelector(".log") as HTMLElement;
    // Default window (hide off): tail 200 rows = all 200 assistant entries.
    expect(target.querySelectorAll(".msg.assistant").length).toBe(200);

    // Freeze at the current boundary (absolute index 800 — the raw logs[]
    // boundary between the tool_use run and the assistant run).
    scrollLogTo(logEl, 0);
    await tick();

    updateSettings({ hideNonMessageLogEntries: true });
    await tick();

    // The 800 tool_use rows vanish, but the 200 assistant rows — the ones
    // this setting must never hide — must still all be there.
    expect(target.querySelectorAll(".msg.assistant").length).toBe(200);
    expect(target.querySelector(".empty")).toBeNull();
  });

  // Same defect, reached via scrollMemory instead of a live toggle while
  // agent-a is the active view: agent-a freezes, the operator switches away
  // (persisting frozenWindow into scrollMemory), the setting toggles while
  // agent-a is in the BACKGROUND, then the operator switches back. The
  // remembered raw boundary must still re-map against the now-filtered
  // displayableLogs on restore.
  it("背景 agent の scrollMemory 経由でも hide toggle 後に frozen boundary が正しく再写像される (round-2 must-fix)", async () => {
    installScrollGeometry();
    const logsA = [
      ...Array.from({ length: 800 }, (_, i) => toolUse("agent-a", i, `tuid-${i}`)),
      ...Array.from({ length: 200 }, (_, i) => assistantLog("agent-a", 800 + i)),
    ];
    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs: logsA,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    const logEl = target.querySelector(".log") as HTMLElement;
    scrollLogTo(logEl, 0);
    await tick();

    props.envelope = state("agent-b");
    props.logs = buildLogs("agent-b", 3);
    await tick();

    // Toggle while agent-a is NOT the active view — its scrollMemory entry
    // (raw boundary 800) is untouched by this; only the live render (now
    // agent-b's) reacts.
    updateSettings({ hideNonMessageLogEntries: true });
    await tick();

    props.envelope = state("agent-a");
    props.logs = logsA;
    await tick();

    expect(target.querySelectorAll(".msg.assistant").length).toBe(200);
    expect(target.querySelector(".empty")).toBeNull();
  });

  it("履歴 clear/reset で logs が縮んでも残存ログが表示される (round-2 M2)", async () => {
    installScrollGeometry();
    const logs = buildLogs("agent-a", 1000);
    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    const logEl = target.querySelector(".log") as HTMLElement;

    // Freeze at absolute index 800 (same as the previous test).
    scrollLogTo(logEl, 0);
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(200);

    // App.svelte's onHistoryCleared / onHistoryReset can replace `logs` with
    // a much shorter transcript (operator purge, or resume replay). Without
    // the round-2 M2 guard, effectiveWindowStart clamps to logs.length (5)
    // and `logs.slice(5)` on a 5-entry array is `[]` — a blank transcript
    // even though 5 entries genuinely exist.
    props.logs = buildLogs("agent-a", 5);
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(5);
    expect(target.querySelector(".empty")).toBeNull();
  });

  it("shrink 後に agent 往復しても stale な stick=false を持ち越さず新着に追従する (round-3 M1)", async () => {
    installScrollGeometry();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const logsA = buildLogs("agent-a", 1000);
    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs: logsA,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    const logEl = target.querySelector(".log") as HTMLElement;

    // Scroll away from the bottom: freezes reading-frozen AND persists
    // `stick: false` to agent-a's scrollMemory entry.
    scrollLogTo(logEl, 0);
    await tick();

    // Switch away, then back to A but with a drastically shrunk transcript
    // (history clear/reset while A was not the active view — the restored
    // `mem` here is exactly the stale {stick:false, frozenWindow:{start:800,
    // ...}} entry from before the shrink).
    props.envelope = state("agent-b");
    props.logs = buildLogs("agent-b", 3);
    await tick();

    const shrunkA = buildLogs("agent-a", 50);
    props.envelope = state("agent-a");
    props.logs = shrunkA;
    await tick();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    expect(target.querySelectorAll(".transcript-entry").length).toBe(50);

    // The pre-fix bug: shrink invalidation reset frozenWindow but left the
    // stale mem.stick=false in place, restoring stickToBottom=false forever
    // for this agent — so a fresh arrival would never auto-follow. Append
    // 30 more entries and confirm the view scrolls to the new bottom.
    props.logs = [
      ...shrunkA,
      ...buildLogs("agent-a", 30).map((e, i) => ({
        ...e,
        seq: 1000 + i,
        ts: tsFor(1000 + i),
      })),
    ];
    // Several rounds of tick+rAF (same pattern and rationale as the
    // sibling "同一 agent を表示したままの shrink" test below, and as issue
    // #237 round 3's ownership-generation check added to the scroll
    // $effect's continuation): this test has ALSO triggered four effect
    // runs in quick succession (mount, switch to B, switch back to
    // shrunk A, append) by this point, and their tick()->mermaid->
    // double-rAF tails settle out of order relative to a single round of
    // awaits here — drain generously so every pending tail (not just this
    // last one) has resolved before asserting the final settled state.
    for (let i = 0; i < 5; i++) {
      await tick();
      await new Promise((r) => requestAnimationFrame(r));
    }

    expect(target.querySelectorAll(".transcript-entry").length).toBe(80);
    expect(logEl.scrollTop).toBe(80 * ROW_PX - 400);
  });

  it("同一 agent を表示したままの shrink でも新着に追従する (agent 切替なし, round-4 M1)", async () => {
    installScrollGeometry();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const logsA = buildLogs("agent-a", 1000);
    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs: logsA,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    const logEl = target.querySelector(".log") as HTMLElement;

    // Scroll away from the bottom WITHOUT ever switching agents — the
    // previous (round-3) test only covers the switching-restore path;
    // ふじ round-4 found the same-agent (no-switch) shrink path left
    // `stickToBottom` stuck at `false` even though the window itself reset
    // to a fresh tail.
    scrollLogTo(logEl, 0);
    await tick();

    const shrunkA = buildLogs("agent-a", 50);
    props.logs = shrunkA;
    await tick();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    expect(target.querySelectorAll(".transcript-entry").length).toBe(50);

    props.logs = [
      ...shrunkA,
      ...buildLogs("agent-a", 30).map((e, i) => ({
        ...e,
        seq: 1000 + i,
        ts: tsFor(1000 + i),
      })),
    ];
    // Several rounds of tick+rAF: this test triggers three effect runs in
    // quick succession (mount, shrink, append), each with its own
    // tick()->mermaid->double-rAF tail chain, and those chains can settle
    // out of order relative to a single round of awaits here — drain
    // generously so every pending tail (not just this last one) has
    // resolved before asserting the final settled state.
    for (let i = 0; i < 5; i++) {
      await tick();
      await new Promise((r) => requestAnimationFrame(r));
    }

    expect(target.querySelectorAll(".transcript-entry").length).toBe(80);
    expect(logEl.scrollTop).toBe(80 * ROW_PX - 400);
  });

  it("window 外の timeline target (#122) は window を拡張して描画し、mermaid を 1 回だけ実行する (round-4 S2)", async () => {
    stubScrollTo();
    const logs = buildLogs("agent-a", 1000);
    const targetKey = conversationEntryKey(logs[10]);
    const { target } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: targetKey,
      onClose: vi.fn(),
    });
    await tick();
    await Promise.resolve();
    await tick();
    const found = target.querySelector(`[data-envelope-key="${targetKey}"]`);
    expect(found).not.toBeNull();
    // ふじ round-4 should-fix S2: ensureIndexVisible used to read
    // effectiveWindowStart (-> frozenWindow) tracked from inside this same
    // $effect, so expanding the window for the target registered
    // frozenWindow as a dependency and risked a second, redundant
    // renderMermaidIn pass for the same mount. Exactly one call is fixed
    // behaviour, mirroring the round-1 M3 / round-3 M2 test's
    // toHaveBeenCalledTimes tightening.
    expect(renderMermaidIn).toHaveBeenCalledTimes(1);
  });

  it("window 外の tool_use/tool_result 相互 jump (#40) も window を拡張して描画する (round-2 S1)", async () => {
    stubScrollTo();
    stubScrollIntoView();
    const logs = buildLogs("agent-a", 1000);
    // tool_use hidden deep in history (index 5, well outside the default
    // 800-999 window); its tool_result partner sits inside the default
    // window (index 900) so the operator can click it without any prior
    // expansion.
    logs[5] = toolUse("agent-a", 5, "tuid-1");
    logs[900] = toolResult("agent-a", 900, "tuid-1");
    const { target } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    expect(target.querySelector('[data-tuid="tuid-1"][data-kind="tool_use"]')).toBeNull();

    const jumpButton = target.querySelector(
      '[data-tuid="tuid-1"][data-kind="tool_result"] button.tlink',
    ) as HTMLButtonElement;
    expect(jumpButton).not.toBeNull();
    jumpButton.click();
    await tick();
    await Promise.resolve();
    await tick();

    expect(
      target.querySelector('[data-tuid="tuid-1"][data-kind="tool_use"]'),
    ).not.toBeNull();
  });

  it("agent 往復で window 展開状態と scrollTop を実クランプ込みで復元する (round-2 M2/S1)", async () => {
    installScrollGeometry();
    const logsA = buildLogs("agent-a", 1000);
    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs: logsA,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    const logEl = target.querySelector(".log") as HTMLElement;
    (target.querySelector(".load-earlier") as HTMLButtonElement).click();
    await tick();
    await Promise.resolve();
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(1000);

    // Park mid-scroll (scrollHeight = 1000*30 = 30000, well within the
    // [0, 29600] range) and let it persist to scrollMemory.
    scrollLogTo(logEl, 15000);
    await tick();
    expect(logEl.scrollTop).toBe(15000);

    // Switch away to a different agent, then back to A.
    props.envelope = state("agent-b");
    props.logs = buildLogs("agent-b", 3);
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(3);

    props.envelope = state("agent-a");
    props.logs = logsA;
    await tick();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));

    // A "keep last N" reset on switch (the pre-#184-fix behaviour) would
    // show 200 rows here — scrollHeight 6000, max scrollTop 5600 — and
    // clamp the restored 15000 down to 5600. Restoring the full 1000-row
    // window BEFORE scrollTop is applied is what keeps this exact.
    expect(target.querySelectorAll(".transcript-entry").length).toBe(1000);
    expect(logEl.scrollTop).toBe(15000);
  });

  it("「以前のログを表示」は新たに見える範囲の mermaid を 1 回だけ再描画する (round-1 M3, round-3 M2)", async () => {
    const logs = buildLogs("agent-a", 1000);
    const { target } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    vi.mocked(renderMermaidIn).mockClear();
    (target.querySelector(".load-earlier") as HTMLButtonElement).click();
    await tick();
    await Promise.resolve();
    await tick();
    // round-3 M2: the shrink guard used to read `frozenWindow` as a tracked
    // dependency of the main scroll $effect, so showEarlierLogs's own state
    // write re-triggered that effect too — a second, redundant
    // renderMermaidIn pass for the same click (interleaving DOM replacement
    // with showEarlierLogs's own scrollHeight-based correction). Exactly
    // one call is the fixed behaviour; toHaveBeenCalled() alone would have
    // let a second call through unnoticed.
    expect(renderMermaidIn).toHaveBeenCalledTimes(1);
  });

  it("showEarlierLogs 中に agent 切替しても新 agent の scrollTop を壊さない (round-2 M3, round-3 S2)", async () => {
    installScrollGeometry();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const logsA = buildLogs("agent-a", 1000);
    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs: logsA,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    const logEl = target.querySelector(".log") as HTMLElement;

    // Every renderMermaidIn call gets its OWN independently-resolvable
    // deferred promise (mount's, showEarlierLogs's, and the switch-to-B
    // settle effect's calls all land here) — a single shared resolver would
    // resolve them all at once and make it impossible to let B settle
    // BEFORE resolving A's stale continuation. Exactly when each call gets
    // registered relative to a plain `await tick()` is not reliable to
    // reason about (Svelte's internal `tick()` scheduling vs. this test's
    // own), so `waitForCalls` polls via repeated `tick()`s instead of
    // assuming a fixed number of awaits gets there.
    const resolvers: Array<() => void> = [];
    vi.mocked(renderMermaidIn).mockImplementation(
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    const resolveFrom = (fromIndex: number) => resolvers.slice(fromIndex).forEach((r) => r());
    async function waitForCalls(atLeast: number, maxTicks = 20): Promise<void> {
      for (let i = 0; i < maxTicks && resolvers.length < atLeast; i++) {
        await tick();
      }
      if (resolvers.length < atLeast) {
        throw new Error(`expected >=${atLeast} renderMermaidIn calls, got ${resolvers.length}`);
      }
    }

    // (The mount's own renderMermaidIn call already ran — via the vi.mock
    // factory's default auto-resolving implementation, installed before
    // `renderReactive` awaited its first tick — and is not tracked in
    // `resolvers` at all, since the queue-based implementation above was
    // only just installed.)

    // Starts showEarlierLogs for A; it awaits tick() then blocks on its OWN
    // deferred renderMermaidIn call. A's scrollHeight/scrollTop at THIS
    // moment (still the default 200-row window, never scrolled) are
    // 200*30=6000 / 0 — showEarlierLogs captures both before this await.
    const aCallIndex = resolvers.length;
    (target.querySelector(".load-earlier") as HTMLButtonElement).click();
    await waitForCalls(aCallIndex + 1);

    // Switch to B (round-4 must-fix: B needs enough rows that its natural
    // scrollHeight exceeds clientHeight by a distinctive amount — 3 rows
    // clamps EVERY scrollTop write, buggy or correct, to 0, making the
    // assertion below pass either way regardless of the fix). Wait for B's
    // own settle-effect call to register, then resolve ONLY it (not A's,
    // still pending at aCallIndex) so B can reach its natural
    // pinned-to-bottom position: scrollHeight 80*30=2400, clientHeight 400
    // -> natural bottom 2000.
    const bCallIndex = resolvers.length;
    const logsB = buildLogs("agent-b", 80);
    props.envelope = state("agent-b");
    props.logs = logsB;
    await waitForCalls(bCallIndex + 1);
    resolveFrom(bCallIndex);
    await Promise.resolve();
    await Promise.resolve();
    await tick();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    const bEntryCountBeforeResolve = target.querySelectorAll(".transcript-entry").length;
    const bScrollTopBeforeResolve = logEl.scrollTop;
    expect(bScrollTopBeforeResolve).toBe(80 * ROW_PX - 400); // 2000, sanity check

    // Now let A's stale continuation resolve, AFTER B has already settled.
    // Without the captured el/agentId re-check (round-2 M3), this would
    // compute `el.scrollTop = prevScrollTop(0) + (el.scrollHeight(2400) -
    // prevScrollHeight(6000))` = -3600, clamped to 0 — observably different
    // from B's natural 2000, unlike the round-3 version of this test (which
    // gave B only 3 rows, so every scrollTop write clamped to 0 regardless
    // of the guard and the assertion could not have failed).
    resolveFrom(aCallIndex);
    await Promise.resolve();
    await Promise.resolve();
    await tick();

    expect(target.querySelectorAll(".transcript-entry").length).toBe(bEntryCountBeforeResolve);
    expect(logEl.scrollTop).toBe(bScrollTopBeforeResolve);
  });

  it("window 先頭行は日付変化が無くても日付ラベルを表示する", async () => {
    // Every timestamp lands in the same UTC minute range (see assistantLog),
    // so there is no real day change anywhere — dayDividers only labels
    // index 0. With the default window (start=800 of 1000), the head row
    // must still carry a label so date context is not lost.
    const logs = buildLogs("agent-a", 1000);
    const { target } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    const firstEntry = target.querySelector(".transcript-entry");
    expect(firstEntry?.querySelector(".day-divider")).not.toBeNull();
  });
});
