// @vitest-environment jsdom
// issue #237 review round 1 must-fix 1+2: `suppressBottomRevert`
// (AgentDetail.svelte) masks the ONE spurious "at the bottom" scroll event
// CSS scroll anchoring produces right after ensureIndexVisible expands the
// #184 render window for a pending timeline jump. This file pins the
// suppression CONTROLLER's timing/ownership contract with fake timers and
// a controllable renderMermaidIn — deterministic, real-browser-independent
// coverage for the class of races real CSS scroll anchoring is not needed
// to reproduce (unlike the position-landing regression itself, which is
// dashboard/e2e/timelineScroll.spec.ts, real-Chromium-only).
//
// must-fix 1 (timer ownership): a re-armed jump (rapid consecutive click,
// or an agent switch carrying its own jump) must not have its protection
// cut short by an OLDER, now-superseded jump's failsafe timer firing.
// must-fix 2 (failsafe start point): the failsafe must not start counting
// until the caller's own pre-scroll async work (tick + renderMermaidIn,
// unbounded) has resolved and the scroll is about to be issued — not at
// ensureIndexVisible's (synchronous, much earlier) expansion time.
// must-fix round 2 (stale-call clobbering): armSuppressFailsafe itself —
// not just its eventual setTimeout callback — must no-op for a stale
// generation. renderMermaidIn's duration is content-dependent, so
// completion order is not dispatch order: an OLDER (lower-generation) jump
// can resolve AFTER a NEWER one already armed its own correct timer. Only
// resolving jumps strictly in dispatch order (as the must-fix-1 tests
// above do) cannot exercise this — see the dedicated out-of-order test.
// must-fix round 3 (M1, request/effect ownership — ふじ probes 1+2): the
// round-2 fix protected the SUPPRESSION TIMER from a stale generation, but
// nothing protected the actual scroll/DOM mutation itself. The main scroll
// $effect's `tick().then(async () => {...})` continuation only re-checked
// `logEl` after its `renderMermaidIn` await, never whether a NEWER effect
// run (a second rapid jump, or an agent switch) had since superseded it.
// So an OLDER, now-irrelevant continuation could still call
// `scrollToTimelineEntry`'s own `logEl.scrollTo(...)` (or the rAF-based
// restore path) AFTER a newer, correct one already landed — silently
// overwriting the correct final position with a stale one. Fixed via a
// plain incrementing `scrollEffectGeneration`, captured once per effect
// run, checked at both async resume points (right after the mermaid await,
// and right after the double-rAF restore wait) before any DOM mutation.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import { conversationEntryKey } from "../src/lib/conversationTimeline";
import { renderMermaidIn } from "../src/lib/markdown";
import type { Envelope } from "../src/lib/protocol";
import { makeReactiveTimelineDetailProps } from "./reactiveProps.svelte";

vi.mock("../src/lib/markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/markdown")>();
  return { ...actual, renderMermaidIn: vi.fn(async () => undefined) };
});

const ROW_PX = 30;
const FAILSAFE_MS = 1000; // AgentDetail.svelte armSuppressFailsafe delay

let component: object | null = null;
let originalClientHeight: PropertyDescriptor | undefined;
let originalScrollHeight: PropertyDescriptor | undefined;
let originalScrollTopDescriptor: PropertyDescriptor | undefined;
let originalGetBoundingClientRect: PropertyDescriptor | undefined;
let scrollTopStore: WeakMap<Element, number> | null = null;

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.clearAllMocks();
  vi.mocked(renderMermaidIn).mockImplementation(async () => undefined);
  vi.useRealTimers();
  for (const [prop, orig] of [
    ["clientHeight", originalClientHeight],
    ["scrollHeight", originalScrollHeight],
    ["scrollTop", originalScrollTopDescriptor],
    ["getBoundingClientRect", originalGetBoundingClientRect],
  ] as const) {
    if (orig) {
      Object.defineProperty(HTMLElement.prototype, prop, orig);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  }
  originalClientHeight = undefined;
  originalScrollHeight = undefined;
  originalScrollTopDescriptor = undefined;
  originalGetBoundingClientRect = undefined;
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

const BASE_TS_MS = Date.parse("2026-07-01T00:00:00Z");
function tsFor(agentId: string, seq: number): string {
  // Distinct ts ranges per agent id so two agents' logs never collide on
  // the each-block / data-envelope-key (agent_id + ts + seq).
  const offset = agentId === "agent-a" ? 0 : 86_400_000;
  return new Date(BASE_TS_MS + offset + seq * 1000).toISOString();
}

function assistantLog(agentId: string, seq: number): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: tsFor(agentId, seq),
    seq,
    type: "log",
    state: "thinking",
    payload: { kind: "assistant", text: `msg ${seq}` },
  };
}

function buildLogs(agentId: string, count: number): Envelope[] {
  return Array.from({ length: count }, (_, seq) => assistantLog(agentId, seq));
}

function stubScrollTo() {
  const spy = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: spy,
  });
  return spy;
}

// Real scroll geometry (same convention as logWindow.integration.test.ts):
// scrollHeight tracks the LIVE `.transcript-entry` count, scrollTop clamps
// to [0, scrollHeight - clientHeight] like a real browser.
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

// jsdom's default getBoundingClientRect() returns all-zero rects, which
// makes scrollToTimelineEntry's own position formula (rect diff + scrollTop)
// collapse to "just the current scrollTop" regardless of WHICH row is being
// measured — fine for tests that only assert window/entry-count, but unable
// to distinguish "landed on the wrong (stale) target" from "landed on the
// right one" (must-fix round 3 M1's own point). This mocks each
// `.transcript-entry`'s rect.top from its live DOM order (matching the
// installScrollGeometry ROW_PX convention), so the real formula produces a
// different, meaningful `top` per row.
function installRowGeometry(): void {
  originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
  );
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      const empty = {
        top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
        toJSON() { return {}; },
      };
      if (this.classList.contains("log")) return { ...empty, bottom: 400, height: 400 };
      if (this.classList.contains("transcript-entry")) {
        const logEl = this.closest(".log") as HTMLElement | null;
        if (!logEl) return empty;
        const rows = [...logEl.querySelectorAll(".transcript-entry")];
        const idx = rows.indexOf(this);
        const top = idx * ROW_PX - logEl.scrollTop;
        return { ...empty, top, bottom: top + ROW_PX, y: top, height: ROW_PX };
      }
      return empty;
    },
  });
}

function scrollLogTo(logEl: HTMLElement, top: number): void {
  logEl.scrollTop = top;
  logEl.dispatchEvent(new Event("scroll"));
}

/** Natural bottom scrollTop for the CURRENTLY rendered entry count. */
function naturalBottom(logEl: HTMLElement): number {
  return Math.max(0, logEl.scrollHeight - logEl.clientHeight);
}

async function renderReactive(props: Parameters<typeof makeReactiveTimelineDetailProps>[0]) {
  const target = document.createElement("div");
  document.body.append(target);
  const reactiveProps = makeReactiveTimelineDetailProps(props);
  component = mount(AgentDetail, { target, props: reactiveProps });
  await tick();
  return { target, props: reactiveProps };
}

/** Queue-based renderMermaidIn control (same pattern as logWindow's round-2
 *  M3/round-3 S2 test): each call gets its own independently-resolvable
 *  deferred promise, so a specific jump's render can be held pending while
 *  fake time advances, or resolved on demand. */
function installControllableMermaid(): {
  resolvers: Array<() => void>;
  resolveNext(): void;
} {
  const resolvers: Array<() => void> = [];
  vi.mocked(renderMermaidIn).mockImplementation(
    () => new Promise<void>((resolve) => resolvers.push(resolve)),
  );
  return {
    resolvers,
    resolveNext() {
      const next = resolvers.shift();
      if (!next) throw new Error("no pending renderMermaidIn call to resolve");
      next();
    },
  };
}

/** Queue-based requestAnimationFrame control (same resolver-queue idea as
 *  installControllableMermaid): each rAF call gets its own held-back
 *  callback, resolvable individually and in either order. Needed only where
 *  a test must interleave TWO overlapping continuations' rAF waits — plain
 *  fake timers do not drive rAF (see the M1 probe 2 comment above), and the
 *  "resolve immediately" stub used there collapses both rAF awaits into one
 *  microtask flush, leaving no room to inject a newer run in between. */
function installControllableRaf(): {
  pending: Array<() => void>;
  resolveOldest(): void;
  resolveNewest(): void;
} {
  const pending: Array<() => void> = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending.push(() => callback(0));
    return pending.length;
  });
  return {
    pending,
    resolveOldest() {
      const fn = pending.shift();
      if (!fn) throw new Error("no pending rAF callback to resolve (oldest)");
      fn();
    },
    resolveNewest() {
      const fn = pending.pop();
      if (!fn) throw new Error("no pending rAF callback to resolve (newest)");
      fn();
    },
  };
}

describe("issue #237 review: suppressBottomRevert ownership (must-fix 1+2)", () => {
  it("must-fix 1: 先行 jump の failsafe が後続 jump(同一 agent 内)の保護を解除しない", async () => {
    stubScrollTo();
    installScrollGeometry();
    const mermaid = installControllableMermaid();
    const logs = buildLogs("agent-a", 1000);
    const targetA = conversationEntryKey(logs[10]);
    const targetB = conversationEntryKey(logs[5]);

    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    mermaid.resolveNext(); // mount's own renderMermaidIn call
    await vi.advanceTimersByTimeAsync(0);
    const logEl = target.querySelector(".log") as HTMLElement;

    // Jump A: index 10, outside the default [800,1000) window -> expands.
    props.scrollToEntryKey = targetA;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(990);
    mermaid.resolveNext(); // A's renderMermaidIn -> scrollToTimelineEntry -> arms failsafe A at t=0
    await vi.advanceTimersByTimeAsync(0);

    // Half a second later, before A's failsafe (1000ms) fires, re-arm with
    // jump B (index 5, still outside the now-[5,1000) window boundary at
    // the time of the click -- window currently starts at 10).
    await vi.advanceTimersByTimeAsync(500);
    props.scrollToEntryKey = targetB;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(995);
    mermaid.resolveNext(); // B's renderMermaidIn -> scrollToTimelineEntry -> arms failsafe B at t=500
    await vi.advanceTimersByTimeAsync(0);

    // Advance to t=1000 -- exactly when A's ORIGINAL failsafe would have
    // fired had it not been cancelled by B's re-arm. B's own failsafe is
    // not due until t=1500.
    await vi.advanceTimersByTimeAsync(500);

    // The same "still at the bottom" event scroll anchoring produces right
    // after a window expansion.
    scrollLogTo(logEl, naturalBottom(logEl));
    await tick();

    // Must-fix 1: B's window must still be intact. A pre-fix stale timer
    // would have cleared suppression at t=1000, letting THIS event collapse
    // the window straight back to the default tail before B's target ever
    // settles.
    expect(target.querySelectorAll(".transcript-entry").length).toBe(995);
  });

  it("must-fix 1: agent 切替後の新 jump が、切替前 agent の failsafe に解除されない", async () => {
    stubScrollTo();
    installScrollGeometry();
    const mermaid = installControllableMermaid();
    const logsA = buildLogs("agent-a", 1000);
    const targetA = conversationEntryKey(logsA[10]);

    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs: logsA,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    const logEl = target.querySelector(".log") as HTMLElement;

    // Jump on agent A: arms failsafe A at t=0 (due t=1000).
    props.scrollToEntryKey = targetA;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(990);

    // At t=200, switch to agent B (300 logs) with its OWN deep jump
    // (index 5, outside B's default [100,300) window) -- the realistic
    // App.svelte onSelectAgent path: envelope and scrollToEntryKey change
    // together.
    await vi.advanceTimersByTimeAsync(200);
    const logsB = buildLogs("agent-b", 300);
    const targetB = conversationEntryKey(logsB[5]);
    props.envelope = state("agent-b");
    props.logs = logsB;
    props.scrollToEntryKey = targetB;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(295);
    mermaid.resolveNext(); // B's own renderMermaidIn -> arms failsafe B at t=200 (due t=1200)
    await vi.advanceTimersByTimeAsync(0);

    // Advance to t=1100: past t=1000, when A's failsafe (armed at t=0)
    // would have fired had the switch not cancelled it, but still short of
    // B's own failsafe (due t=1200).
    await vi.advanceTimersByTimeAsync(900);
    scrollLogTo(logEl, naturalBottom(logEl));
    await tick();

    expect(target.querySelectorAll(".transcript-entry").length).toBe(295);
  });

  it("must-fix 2: renderMermaidIn が 1 秒を超えて解決しなくても、着地前に window が巻き戻らない", async () => {
    stubScrollTo();
    installScrollGeometry();
    const mermaid = installControllableMermaid();
    const logs = buildLogs("agent-a", 1000);
    const target10 = conversationEntryKey(logs[10]);

    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    const logEl = target.querySelector(".log") as HTMLElement;

    // Request the jump: ensureIndexVisible expands the window and arms
    // suppression SYNCHRONOUSLY, but per must-fix 2 the failsafe timer
    // must not start yet -- renderMermaidIn (awaited before
    // scrollToTimelineEntry runs) is still pending.
    props.scrollToEntryKey = target10;
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(990);

    // Let 1500ms of fake time pass WITHOUT resolving renderMermaidIn --
    // longer than the 1000ms failsafe. A pre-fix (arm-time-started) timer
    // would already have fired by now.
    await vi.advanceTimersByTimeAsync(1500);

    // The same spurious "still at the bottom" event that can occur any
    // time during this unbounded wait.
    scrollLogTo(logEl, naturalBottom(logEl));
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(990);

    // Now let the slow render finally resolve -- scrollToTimelineEntry
    // must still find the target (window never collapsed) and succeed.
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    const found = logEl.querySelector(`[data-envelope-key="${target10}"]`);
    expect(found).not.toBeNull();
  });

  it("genuine departure (末尾から離れた) を検知すると即座に suppression を解除する", async () => {
    stubScrollTo();
    installScrollGeometry();
    const mermaid = installControllableMermaid();
    const logs = buildLogs("agent-a", 1000);
    const target10 = conversationEntryKey(logs[10]);

    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    const logEl = target.querySelector(".log") as HTMLElement;

    props.scrollToEntryKey = target10;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0); // failsafe armed at t=0, due t=1000

    // A genuine departure well before the failsafe (t=50): scrolled far
    // from the bottom, as the jump's own smooth-scroll would produce.
    await vi.advanceTimersByTimeAsync(50);
    scrollLogTo(logEl, 0);
    await tick();

    // Suppression should already be lifted -- a SUBSEQUENT return to the
    // bottom must revert the reading-freeze normally, well before t=1000.
    await vi.advanceTimersByTimeAsync(50); // t=100, still far from the 1000ms failsafe
    scrollLogTo(logEl, naturalBottom(logEl));
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(200);
  });

  it("departure が一度も無ければ、1000ms failsafe 経過後の bottom event で解除される", async () => {
    stubScrollTo();
    installScrollGeometry();
    const mermaid = installControllableMermaid();
    const logs = buildLogs("agent-a", 1000);
    const target10 = conversationEntryKey(logs[10]);

    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    const logEl = target.querySelector(".log") as HTMLElement;

    props.scrollToEntryKey = target10;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0); // failsafe armed at t=0, due t=1000

    // No departure event at all -- advance straight past the failsafe.
    await vi.advanceTimersByTimeAsync(FAILSAFE_MS + 10);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(990); // still intact until an actual event

    scrollLogTo(logEl, naturalBottom(logEl));
    await tick();
    // The failsafe having fired, this "at the bottom" event now reverts
    // the freeze like any ordinary one — the deliberate escape hatch for a
    // jump target that never produces a clean departure signal.
    expect(target.querySelectorAll(".transcript-entry").length).toBe(200);
  });

  it("must-fix round 2: 完了順が逆転しても、古い jump が新しい jump の有効な failsafe を潰さない", async () => {
    stubScrollTo();
    installScrollGeometry();
    const mermaid = installControllableMermaid();
    const logs = buildLogs("agent-a", 1000);
    const targetOld = conversationEntryKey(logs[10]); // requested first
    const targetNew = conversationEntryKey(logs[5]); // requested second

    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    mermaid.resolveNext(); // mount
    await vi.advanceTimersByTimeAsync(0);
    const logEl = target.querySelector(".log") as HTMLElement;

    // Dispatch OLD first: expands to [10,1000), arms generation 1, but its
    // renderMermaidIn call is held pending (not resolved yet) — simulating
    // a diagram-heavy message taking longer to render.
    props.scrollToEntryKey = targetOld;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(990);

    // Dispatch NEW before OLD's render resolves: expands further to
    // [5,1000), arms generation 2. Its OWN renderMermaidIn call is also
    // held pending.
    props.scrollToEntryKey = targetNew;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(995);
    expect(mermaid.resolvers.length).toBe(2); // OLD's and NEW's, both pending

    // Resolve OUT OF ORDER: NEW's render finishes first (it started
    // second but happens to be faster) -> scrollToTimelineEntry(gen=2)
    // succeeds -> arms the CURRENT, correct failsafe timer.
    const [resolveOld, resolveNew] = mermaid.resolvers;
    resolveNew();
    await vi.advanceTimersByTimeAsync(0);

    // THEN OLD's render finally resolves, 300ms later -> its own
    // scrollToTimelineEntry(gen=1) still succeeds (index 10 is within the
    // current [5,1000) window) and calls armSuppressFailsafe(1) — a STALE
    // generation. Must-fix round 2: this call must be a no-op and must NOT
    // cancel/replace NEW's already-armed, current timer.
    await vi.advanceTimersByTimeAsync(300);
    resolveOld();
    await vi.advanceTimersByTimeAsync(0);

    // No genuine departure ever occurs. Advance to 1000ms past NEW's own
    // arm point (t=0) — its failsafe should fire right on schedule and
    // finally revert suppression, regardless of OLD's later, stale call.
    await vi.advanceTimersByTimeAsync(700); // total elapsed since NEW armed: 1000ms
    scrollLogTo(logEl, naturalBottom(logEl));
    await tick();
    expect(target.querySelectorAll(".transcript-entry").length).toBe(200);
  });

  it("N1: cancel-on-rearm と callback 内 generation guard は defense-in-depth (delayed schedule)", async () => {
    // ふじ review round 3 N1: 二層防御(armSuppressBottomRevert の
    // cancel-on-rearm、armSuppressFailsafe のコールバック内 generation
    // guard)は個別に無効化しても他方が単独で守り切れるため、
    // must-fix-1 系テストのタイミング(NEW が自分の失敗も即座に
    // renderMermaidIn を解決する)では red にならない。両方を同時に
    // 無効化し、かつ NEW の render を OLD の ORIGINAL deadline を
    // 越えるまで pending にした場合(NEW 自身がまだ自分の failsafe を
    // 一度も arm していない時点で OLD の stale timer が発火する)だけが
    // red になる、という判定を pin する。
    stubScrollTo();
    installScrollGeometry();
    const mermaid = installControllableMermaid();
    const logs = buildLogs("agent-a", 1000);
    const targetOld = conversationEntryKey(logs[10]);
    const targetNew = conversationEntryKey(logs[5]);

    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    mermaid.resolveNext(); // mount
    await vi.advanceTimersByTimeAsync(0);
    const logEl = target.querySelector(".log") as HTMLElement;

    // OLD resolves immediately: arms failsafe at t=0, due t=1000.
    props.scrollToEntryKey = targetOld;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);

    // At t=50, NEW is dispatched: ensureIndexVisible expands the window
    // further and re-arms SYNCHRONOUSLY (this is what cancel-on-rearm
    // protects against OLD's still-pending timer) — but its OWN
    // renderMermaidIn is held pending well past t=1000, so NEW never gets
    // a chance to arm its OWN failsafe before OLD's original deadline.
    await vi.advanceTimersByTimeAsync(50);
    props.scrollToEntryKey = targetNew;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(995);

    // Advance to t=1050 (past OLD's t=1000 deadline) WITHOUT resolving
    // NEW's render, then apply the same spurious "still at the bottom"
    // event a window expansion produces.
    await vi.advanceTimersByTimeAsync(950);
    scrollLogTo(logEl, naturalBottom(logEl));
    await tick();

    // With both guards intact, OLD's timer cannot have fired (cancelled at
    // t=50) so this event must not revert the freeze.
    expect(target.querySelectorAll(".transcript-entry").length).toBe(995);

    // NEW's render finally resolves and must still find its target.
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(995);
  });

  it("must-fix round 3 (M1) probe 1: 完了順が逆転しても、最終着地は NEW のまま (OLD に上書きされない)", async () => {
    const scrollToSpy = stubScrollTo();
    installScrollGeometry();
    installRowGeometry();
    const mermaid = installControllableMermaid();
    const logs = buildLogs("agent-a", 1000);
    const targetOld = conversationEntryKey(logs[10]);
    const targetNew = conversationEntryKey(logs[5]);

    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    mermaid.resolveNext(); // mount
    await vi.advanceTimersByTimeAsync(0);

    // Dispatch OLD (expands to [10,1000)); its renderMermaidIn is held
    // pending (e.g. a diagram-heavy message taking longer to render).
    props.scrollToEntryKey = targetOld;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(990);

    // Dispatch NEW before OLD resolves (expands further to [5,1000)); its
    // own renderMermaidIn is also held pending.
    props.scrollToEntryKey = targetNew;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(995);
    expect(mermaid.resolvers.length).toBe(2);
    const [resolveOld, resolveNew] = mermaid.resolvers;

    // NEW resolves first -> lands correctly: NEW is now the first rendered
    // row (window starts at its own index), so entryTop=0 -> top=0.
    resolveNew();
    await vi.advanceTimersByTimeAsync(0);
    expect(scrollToSpy.mock.calls.length).toBeGreaterThan(0);
    expect(scrollToSpy.mock.calls.at(-1)?.[0]).toMatchObject({ top: 0 });

    // OLD resolves 300ms later. At the CURRENT (unchanged since NEW's
    // expansion) window, OLD sits 5 rows below NEW (150px) -> its own
    // (stale) computed top would be 126. A pre-fix continuation would call
    // scrollTo(126) here, silently overwriting NEW's correct landing.
    await vi.advanceTimersByTimeAsync(300);
    resolveOld();
    await vi.advanceTimersByTimeAsync(0);

    expect(scrollToSpy.mock.calls.at(-1)?.[0]).toMatchObject({ top: 0 });
  });

  it("must-fix round 3 (M1) probe 2: agent 切替後、切替前 agent の遅延 continuation が incoming agent の scrollTop を上書きしない", async () => {
    stubScrollTo(); // no-op: isolates the DIRECT logEl.scrollTop write the stale fallback path makes, from any legitimate scrollTo() call
    // The stale-fallback path this probes waits two requestAnimationFrame
    // ticks before writing scrollTop; make them resolve immediately
    // (same pattern as logWindow.integration.test.ts) rather than relying
    // on fake-timer time advancement, which does not drive rAF.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    installScrollGeometry();
    installRowGeometry();
    const mermaid = installControllableMermaid();
    const logsA = buildLogs("agent-a", 1000);
    const targetA = conversationEntryKey(logsA[10]);

    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs: logsA,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    const logEl = target.querySelector(".log") as HTMLElement;

    // Jump on agent A (stickToBottom defaults true — the operator was
    // pinned to the tail, the common starting state per issue #237's own
    // root-cause analysis). renderMermaidIn held pending.
    props.scrollToEntryKey = targetA;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(990);

    // Switch to agent B (300 logs) with its OWN deep jump (index 5,
    // outside B's default [100,300) window) before A's render resolves —
    // the realistic App.svelte onSelectAgent path (envelope + target
    // change together).
    const logsB = buildLogs("agent-b", 300);
    const targetB = conversationEntryKey(logsB[5]);
    props.envelope = state("agent-b");
    props.logs = logsB;
    props.scrollToEntryKey = targetB;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(".transcript-entry").length).toBe(295);
    expect(mermaid.resolvers.length).toBe(2);
    const [resolveA, resolveB] = mermaid.resolvers;

    // B's render resolves and lands correctly (B's target is the first
    // rendered row of its own window -> top=0). scrollTo is stubbed, so
    // this does not itself move logEl.scrollTop — only the buggy fallback
    // (a DIRECT `logEl.scrollTop = ...` assignment) would.
    resolveB();
    await vi.advanceTimersByTimeAsync(0);
    const scrollTopAfterB = logEl.scrollTop;

    // A's render FINALLY resolves, 300ms later. Its target is no longer in
    // the DOM (agent B's logs are showing), so scrollToTimelineEntry fails
    // to find it — but a pre-fix continuation falls through to the
    // stick-to-bottom restore path (A's OWN captured shouldStick=true,
    // restoreTop=null) and directly assigns
    // `logEl.scrollTop = logEl.scrollHeight` against B's CURRENT (now
    // reused) DOM — silently discarding B's landing.
    await vi.advanceTimersByTimeAsync(300);
    resolveA();
    await vi.advanceTimersByTimeAsync(0);
    // Two rAF frames the stale fallback path awaits before writing.
    await vi.advanceTimersByTimeAsync(0);

    expect(logEl.scrollTop).toBe(scrollTopAfterB);
  });

  it("N-a: 2連 rAF 後の 3 番目の ownership guard がないと、OLD の遅延 continuation が NEW の着地を上書きする (pin)", async () => {
    // クロエ review N-a: the M1 probes above pin the FIRST two async resume
    // points -- but in BOTH probes, OLD's own generation already mismatches
    // by the time its renderMermaidIn resolves, so it returns at that
    // EARLIER check and never even reaches the double-rAF wait. This test
    // instead lets OLD pass that earlier check (it is still the latest
    // generation when its renderMermaidIn resolves), then supersedes it
    // with NEW only WHILE OLD is mid-rAF-wait -- the one case only the
    // third guard (right before the final `logEl.scrollTop = ...` write)
    // can catch. Per クロエ's own measurement, removing just this guard
    // leaves all 564 pre-existing tests green; this is its dedicated
    // negative control. Uses the switch-restore path (a fixed, synchronously
    // captured `restoreTop` per run) rather than stick-to-bottom, so OLD's
    // and NEW's would-be write targets are two distinct, known values
    // instead of both collapsing to the same live `scrollHeight`.
    stubScrollTo(); // isolate the direct `logEl.scrollTop = ...` write
    installScrollGeometry();
    const mermaid = installControllableMermaid();
    const raf = installControllableRaf();
    const logsA = buildLogs("agent-a", 300);
    const logsB = buildLogs("agent-b", 300);

    const { target, props } = await renderReactive({
      envelope: state("agent-a"),
      logs: logsA,
      agents: {},
      scrollToEntryKey: null,
      onClose: vi.fn(),
    });
    // Drain the mount's own continuation (unseen agent -> stick defaults
    // true -> also runs the renderMermaidIn + double-rAF + write path).
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    raf.resolveOldest();
    await vi.advanceTimersByTimeAsync(0);
    raf.resolveOldest();
    await vi.advanceTimersByTimeAsync(0);
    const logEl = target.querySelector(".log") as HTMLElement;

    // Depart from the bottom on agent-a and memorize a non-stick position
    // (top=100) via the ordinary scroll-event path.
    scrollLogTo(logEl, 100);
    await tick();

    // Switch to agent-b (unseen -> defaults to bottom); drain fully.
    props.envelope = state("agent-b");
    props.logs = logsB;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    raf.resolveOldest();
    await vi.advanceTimersByTimeAsync(0);
    raf.resolveOldest();
    await vi.advanceTimersByTimeAsync(0);

    // Depart from the bottom on agent-b and memorize a DIFFERENT non-stick
    // position (top=200).
    scrollLogTo(logEl, 200);
    await tick();

    // OLD: switch back to agent-a -> restores its memorized top=100,
    // captured synchronously into THIS run's `restoreTop`. Its
    // renderMermaidIn resolves PROMPTLY, while OLD is still the latest run
    // -> passes the post-render generation check -> enters the double-rAF
    // wait (held).
    props.envelope = state("agent-a");
    props.logs = logsA;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    expect(raf.pending.length).toBe(1); // OLD awaiting its first rAF

    // NEW: switch to agent-b again BEFORE OLD's rAFs resolve -> restores
    // its OWN memorized top=200, superseding OLD (bumps
    // scrollEffectGeneration) while OLD is parked mid-wait.
    props.envelope = state("agent-b");
    props.logs = logsB;
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    mermaid.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    expect(raf.pending.length).toBe(2); // OLD's still-pending rAF + NEW's first

    // Let NEW run to completion first (its own two rAFs), landing at its
    // memorized 200.
    raf.resolveNewest();
    await vi.advanceTimersByTimeAsync(0);
    raf.resolveNewest();
    await vi.advanceTimersByTimeAsync(0);
    expect(logEl.scrollTop).toBe(200);

    // Only now release OLD's own two rAFs -- its continuation resumes with
    // a generation that no longer matches.
    raf.resolveOldest();
    await vi.advanceTimersByTimeAsync(0);
    raf.resolveOldest();
    await vi.advanceTimersByTimeAsync(0);

    // The pin: OLD's stale restore (100) must not have overwritten NEW's
    // landing (200).
    expect(logEl.scrollTop).toBe(200);
  });
});
