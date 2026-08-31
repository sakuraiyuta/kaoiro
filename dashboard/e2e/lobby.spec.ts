// T1-T3 (phase-31 31-10): lobby grid columns follow role + timeline
// placement across the ADR-0052 breakpoints.
import { expect, test, type Page } from "@playwright/test";

const OPERATOR = "/e2e/harness/index.html?view=lobby&role=operator";
const VIEWER = "/e2e/harness/index.html?view=lobby&role=viewer";

async function gridColumnCount(page: Page): Promise<number> {
  return page
    .locator("ul.agents")
    .evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
    );
}

test.describe("T1: operator lobby 939/940 — timeline sheet ⇔ side pane", () => {
  test("940px: timeline side-by-side, 2 columns, no handle", async ({ page }) => {
    await page.setViewportSize({ width: 940, height: 800 });
    await page.goto(OPERATOR);
    await expect(page.locator("aside.timeline")).toBeVisible();
    await expect(page.locator(".sheet .handle .toggle")).toBeHidden();
    expect(await gridColumnCount(page)).toBe(2);
  });

  test("939px: timeline reachable via the sheet, grid follows auto-fill", async ({ page }) => {
    await page.setViewportSize({ width: 939, height: 800 });
    await page.goto(OPERATOR);
    await expect(page.locator("aside.timeline")).toBeHidden();
    const toggle = page.locator(".sheet .handle .toggle");
    await expect(toggle).toBeVisible();
    // 939 - 64 (本体 padding) = 875px → auto-fill fits 3 × 240px tiles.
    expect(await gridColumnCount(page)).toBe(3);
    await toggle.click();
    await expect(page.locator("aside.timeline")).toBeVisible();
  });
});

test.describe("T2: operator lobby 1198/1199 — 2 ⇔ 3 columns, tile ≥ 240px", () => {
  test("1199px: 3 columns, tiles at least 240px wide", async ({ page }) => {
    await page.setViewportSize({ width: 1199, height: 900 });
    await page.goto(OPERATOR);
    expect(await gridColumnCount(page)).toBe(3);
    const tile = page.locator("ul.agents > li").first();
    const box = await tile.boundingBox();
    expect(box).not.toBeNull();
    // 240px floor (`minmax(15rem, 1fr)`); breakpoint derivation allows a
    // sub-pixel remainder, hence the 1px tolerance.
    expect(box!.width).toBeGreaterThanOrEqual(239);
  });

  test("1198px: 2 columns", async ({ page }) => {
    await page.setViewportSize({ width: 1198, height: 900 });
    await page.goto(OPERATOR);
    expect(await gridColumnCount(page)).toBe(2);
  });
});

test("lobby sheet handle shows a pending lamp while an agent waits (S1)", async ({ page }) => {
  await page.setViewportSize({ width: 939, height: 800 });
  await page.goto(`${OPERATOR}&pending=1`);
  await page.locator(".sheet .handle .toggle").click();
  await expect(page.locator(".sheet .handle .pending-lamp")).toBeVisible();
});

test.describe("T3: viewer lobby — always auto-fill, no timeline, no handle", () => {
  for (const width of [1400, 1000, 500]) {
    test(`${width}px: auto-fill grid without timeline/handle`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(VIEWER);
      await expect(page.locator("ul.agents")).toBeVisible();
      await expect(page.locator("ul.agents")).not.toHaveClass(/three-cols/);
      await expect(page.locator("aside.timeline")).toHaveCount(0);
      await expect(page.locator(".sheet .handle")).toHaveCount(0);
    });
  }
});

// T12 (issue #231, ふじ round-1 should-fix S1): the AgentCard side of the
// 8px orbit-drop was only verified by geometry review, not measured in a
// real browser — svelte-check/vitest cannot resolve `calc(-2% + 8px)`
// against `.sprite-slot`'s actual rendered height (jsdom has no layout
// engine). AgentDetail's own topOffset="calc(6% + 8px)" is a plain inline
// style value that agentDetailTaskRing.integration.test.ts already pins
// directly; AgentCard has no such inline style (TaskRing's base CSS rule
// supplies it), so only a real layout engine can resolve the containing
// block's height this asserts against.
test.describe("T12: 頭上リング (AgentCard, issue #231)", () => {
  test("1920x1080: TaskRing の top が .sprite-slot 高さ * -0.02 + 8px に解決される", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`${OPERATOR}&taskRing=1`);
    const slot = page.locator(".sprite-slot").first();
    const ring = page.locator(".task-ring").first();
    await expect(ring).toBeVisible();

    const slotBox = (await slot.boundingBox())!;
    const topPx = await ring.evaluate((el) =>
      parseFloat(getComputedStyle(el).top),
    );

    // Sub-pixel rounding (ふじ実測: 差 7.98px/8px) — 1px tolerance.
    const expectedTop = slotBox.height * -0.02 + 8;
    expect(Math.abs(topPx - expectedTop)).toBeLessThan(1);
  });

  test("dev の taskRingOffset が 1920x1080 の実測 apex に反映される", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`${OPERATOR}&taskRing=1&taskRingOffset=14`);
    const slot = page.locator(".sprite-slot").first();
    const ring = page.locator(".task-ring").first();
    await expect(ring).toBeVisible();

    const slotBox = (await slot.boundingBox())!;
    const topPx = await ring.evaluate((el) =>
      parseFloat(getComputedStyle(el).top),
    );
    const expectedTop = slotBox.height * -0.02 + 14;
    expect(Math.abs(topPx - expectedTop)).toBeLessThan(1);
  });
});

// T13 (issue #233, validated design in issue #233 comment 5450038052):
// count active subagent/workflow roots each get their own evenly-spaced
// dot. taskRing.integration.test.ts (jsdom) already pins the CSS-variable
// geometry (theta/phase-delay) directly; these confirm the browser
// actually renders/animates the resulting DOM at real scale.
test.describe("T13: TaskRing count (issue #233)", () => {
  // LobbyHarness renders 4 fixture agents (lobbyAgents()), and `taskRing`
  // applies the SAME count to every one of them — a bare `.task-ring`
  // locator would therefore see count*4 elements. Scope to one tile.
  function firstCardRings(page: Page) {
    return page.locator("ul.agents > li").first().locator(".task-ring");
  }

  test("count>1 は count 個の .task-ring を描画する", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`${OPERATOR}&taskRing=5`);
    await expect(firstCardRings(page)).toHaveCount(5);
  });

  // reduced motion: the global stylesheet shortens animation-duration to
  // 0.01ms and iteration-count to 1, with no fill-mode — each dot falls
  // back to its OWN base-rule rest state (--dot-x/--dot-y), which must
  // differ per dot for the phases to stay visually separated (issue #233
  // design note). If they collapsed to one shared position, this would
  // observe far fewer than `count` distinct on-screen positions.
  test("reduced motion 完了後、各 dot が別々の静的位置に留まる", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`${OPERATOR}&taskRing=4`);
    const rings = firstCardRings(page);
    await expect(rings).toHaveCount(4);
    // Let the (near-instant) reduced-motion animation finish.
    await page.waitForTimeout(100);

    const positions = await rings.evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect();
        return `${Math.round(rect.x)},${Math.round(rect.y)}`;
      }),
    );
    expect(new Set(positions).size).toBe(4);
  });

  // "no UI cap" is an explicit acceptance criterion (issue #233 comment
  // 5450038052) — measuring rather than assuming it holds at scale.
  for (const count of [50, 500]) {
    test(`count=${count} でも全 dot を描画する (no UI cap)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(`${OPERATOR}&taskRing=${count}`);
      await expect(firstCardRings(page)).toHaveCount(count);
    });
  }
});
