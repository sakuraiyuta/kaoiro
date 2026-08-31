// @vitest-environment jsdom
// TaskRing.svelte (issue #233, validated design in issue #233 comment
// 5450038052): count active subagent/workflow roots each get their own
// evenly-ANGLE-spaced dot on the same orbit. Pins the geometry/a11y
// contract directly (AgentCard/AgentDetail's own TaskRing tests only
// cover their own prop wiring, not TaskRing's internal dot generation).
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import TaskRing from "../src/lib/TaskRing.svelte";
import {
  readDevTaskRingOffset,
  taskRingTopWithDevOffset,
} from "../src/lib/taskRingOffset";

const mounted: object[] = [];
const initialUrl = window.location.href;

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  window.history.replaceState(null, "", initialUrl);
});

async function render(count?: number) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(TaskRing, {
    target,
    props: count === undefined ? {} : { count },
  });
  mounted.push(component);
  await tick();
  return target;
}

function cssVarNumber(el: Element, name: string): number {
  return Number((el as HTMLElement).style.getPropertyValue(name));
}

describe("TaskRing (issue #233)", () => {
  it("count 省略時 (既定 1) は 1 個の dot だけを描画する", async () => {
    const target = await render();
    expect(target.querySelectorAll(".task-ring").length).toBe(1);
  });

  it("count=N はちょうど N 個の sibling dot を描画する", async () => {
    const target = await render(5);
    expect(target.querySelectorAll(".task-ring").length).toBe(5);
  });

  it("先頭 dot だけが role=img + count 入り aria-label を持ち、残りは aria-hidden", async () => {
    const target = await render(4);
    const rings = target.querySelectorAll(".task-ring");
    expect(rings[0]!.getAttribute("role")).toBe("img");
    expect(rings[0]!.getAttribute("aria-label")).toBe(
      "サブエージェント/workflow実行中 (4件)",
    );
    expect(rings[0]!.hasAttribute("aria-hidden")).toBe(false);
    for (const ring of Array.from(rings).slice(1)) {
      expect(ring.getAttribute("aria-hidden")).toBe("true");
      expect(ring.hasAttribute("role")).toBe(false);
      expect(ring.hasAttribute("aria-label")).toBe(false);
    }
  });

  // Negative delay: dot i's animation is already i/count of the way
  // through its 2400ms cycle at t=0 (see TaskRing.svelte's own doc
  // comment) — the same i/count fraction that spaces theta by angle.
  it("phase delay は -(i * 2400 / count) ms になる", async () => {
    const target = await render(4);
    const rings = Array.from(target.querySelectorAll(".task-ring"));
    const delays = rings.map((r) =>
      (r as HTMLElement).style.getPropertyValue("--phase-delay"),
    );
    expect(delays).toEqual(["0ms", "-600ms", "-1200ms", "-1800ms"]);
  });

  // theta = -90 + 360*i/n (degrees); static coefficients are cosθ/sinθ
  // themselves, not the animated position at time zero (TaskRing's own
  // doc comment on why those differ).
  it("静的係数 (--dot-x/--dot-y) が theta = -90 + 360*i/n の cosθ/sinθ と一致する", async () => {
    const n = 4;
    const target = await render(n);
    const rings = Array.from(target.querySelectorAll(".task-ring"));
    rings.forEach((ring, i) => {
      const thetaRad = ((-90 + (360 * i) / n) * Math.PI) / 180;
      expect(cssVarNumber(ring, "--dot-x")).toBeCloseTo(Math.cos(thetaRad), 10);
      expect(cssVarNumber(ring, "--dot-y")).toBeCloseTo(Math.sin(thetaRad), 10);
    });
  });

  // count=1 must reproduce the pre-#233 single-dot geometry bit-for-bit:
  // theta=-90deg (12 o'clock) -> dot-x=0, dot-y=-1, zero phase delay.
  it("count=1 は既存 (issue #180) の単一ドット幾何と一致する (dot-x=0, dot-y=-1, delay=0)", async () => {
    const target = await render(1);
    const ring = target.querySelector(".task-ring")!;
    expect(cssVarNumber(ring, "--dot-x")).toBeCloseTo(0, 10);
    expect(cssVarNumber(ring, "--dot-y")).toBeCloseTo(-1, 10);
    expect((ring as HTMLElement).style.getPropertyValue("--phase-delay")).toBe(
      "0ms",
    );
  });

  // "no UI cap" is an explicit acceptance criterion (issue #233 comment
  // 5450038052) — a large count must render every dot, not truncate.
  it("大きい count でも切り詰めずに全 dot を描画する", async () => {
    const target = await render(100);
    expect(target.querySelectorAll(".task-ring").length).toBe(100);
  });

  it("faceOrbit / orbitRx / orbitRy / topOffset は count に関わらず全 dot に適用される", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(TaskRing, {
      target,
      props: {
        count: 3,
        faceOrbit: true,
        orbitRx: "1rem",
        orbitRy: "0.5rem",
        topOffset: "10%",
      },
    });
    mounted.push(component);
    await tick();

    const rings = target.querySelectorAll(".task-ring");
    expect(rings.length).toBe(3);
    for (const ring of Array.from(rings)) {
      expect(ring.classList.contains("face-orbit")).toBe(true);
      expect((ring as HTMLElement).style.getPropertyValue("--orbit-rx")).toBe(
        "1rem",
      );
      expect((ring as HTMLElement).style.getPropertyValue("--orbit-ry")).toBe(
        "0.5rem",
      );
      expect((ring as HTMLElement).style.top).toBe("10%");
    }
  });

  it("dev の taskRingOffset は card の既定アンカーへ pixel 項だけを適用する", async () => {
    window.history.replaceState(null, "", "?taskRingOffset=14");
    const target = await render(2);

    for (const ring of Array.from(target.querySelectorAll(".task-ring"))) {
      expect((ring as HTMLElement).style.top).toBe("calc(-2% + 14px)");
    }
  });

  it("taskRingOffset は production 判定では無視する", () => {
    expect(readDevTaskRingOffset("?taskRingOffset=14", false)).toBeNull();
    expect(readDevTaskRingOffset("?taskRingOffset=bad", true)).toBeNull();
    expect(taskRingTopWithDevOffset("calc(6% + 8px)", null)).toBe(
      "calc(6% + 8px)",
    );
  });
});
