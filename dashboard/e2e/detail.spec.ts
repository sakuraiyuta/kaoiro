// T4-T8 (phase-31 31-10): AgentDetail status sheet, scroll ownership, and
// pending-decision reachability across the ADR-0052 breakpoints.
import { expect, test } from "@playwright/test";

const DETAIL = "/e2e/harness/index.html?view=detail";

test.describe("T4: detail status — sidebar ⇔ sheet at 1199/1198", () => {
  test("1199px: status renders as the left sidebar, no handle", async ({ page }) => {
    await page.setViewportSize({ width: 1199, height: 900 });
    await page.goto(DETAIL);
    await expect(page.locator("aside.status")).toBeVisible();
    await expect(page.locator(".sheet .handle .toggle")).toBeHidden();
  });

  for (const width of [1198, 844]) {
    test(`${width}px: status sheets behind the handle`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(DETAIL);
      await expect(page.locator("aside.status")).toBeHidden();
      const toggle = page.locator(".sheet .handle .toggle");
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(page.locator("aside.status")).toBeVisible();
    });
  }
});

test("T5: open sheet — background frozen, sheet content owns the scroll", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 500 });
  await page.goto(DETAIL);
  const log = page.locator(".log");
  await expect(log).toBeVisible();
  await page.locator(".sheet .handle .toggle").click();
  const status = page.locator("aside.status");
  await expect(status).toBeVisible();
  // 背景 (page main) は overflow:hidden で固定される (body.sheet-open).
  await expect(page.locator("main.harness-main")).toHaveCSS(
    "overflow-y",
    "hidden",
  );
  const logTopBefore = await log.evaluate((el) => el.scrollTop);
  // Wheel over the sheet: at sheet sizes .status itself is the single
  // scroll owner (the identity header scrolls with the content).
  const box = (await status.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  // mouse.wheel does not wait for the scroll to land — poll (クロエ M2).
  await expect
    .poll(() => status.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  expect(await log.evaluate((el) => el.scrollTop)).toBe(logTopBefore);
});

// クロエ M1 regression: the sheet must keep the status controls reachable
// on LANDSCAPE phones, where the 60% panel is at its shallowest. A single
// height band cannot catch this class of defect — pin the two worst real
// devices (844x390 iPhone landscape, 740x360 compact Android landscape).
for (const [width, height] of [
  [844, 390],
  [740, 360],
] as const) {
  test(`M1 regression: status stays reachable at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(DETAIL);
    await page.locator(".sheet .handle .toggle").click();
    const status = page.locator("aside.status");
    await expect(status).toBeVisible();
    // The scroll owner must retain a usable viewport of its own…
    const clientHeight = await status.evaluate((el) => el.clientHeight);
    expect(clientHeight).toBeGreaterThanOrEqual(80);
    // …and scrolling to the end must expose the pane-bottom controls.
    await status.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const action = page.locator(".terminate");
    await expect(action).toBeVisible();
    const box = (await action.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
  });
}

for (const [taskId, pending, dockSelector] of [
  ["T6", "permission", ".permission-dock"],
  ["T7", "question", ".question-dock"],
] as const) {
  test.describe(`${taskId}: ${pending} arrival stays reachable`, () => {
    test("sheet closed: the in-flow dock is directly visible", async ({ page }) => {
      await page.setViewportSize({ width: 844, height: 900 });
      await page.goto(`${DETAIL}&pending=${pending}`);
      await expect(page.locator(dockSelector)).toBeVisible();
    });

    test("sheet open: handle lamp announces it; closing reaches the dock", async ({ page }) => {
      await page.setViewportSize({ width: 844, height: 900 });
      await page.goto(`${DETAIL}&pending=${pending}`);
      const toggle = page.locator(".sheet .handle .toggle");
      await toggle.click();
      await expect(page.locator(".sheet .handle .pending-lamp")).toBeVisible();
      await toggle.click();
      await expect(page.locator(dockSelector)).toBeVisible();
    });
  });
}

// T11 (issue #180 follow-up, 2026-08-10, ふじ round1 S1): 頭上リングが
// 実ブラウザで AgentDetail 側にも描画・アニメーションされることを、
// LobbyHarness が AgentCard 側で既にやっている taskRing パターンの
// 対で固定する。App.svelte の配線 (activeTaskCountForDetail) までは
// 通さない (このハーネスは AgentDetail を直接 mount する) —
// activeTaskCountForDetail() 自体の guard semantics は protocol.test.ts
// の単体テストが担当、App.svelte 側の一行配線は型付き直結のみで分岐・
// 変換を持たないため静的レビューで確認する (ふじ round2, 2026-08-10:
// 追加投資不要と判断)。
test.describe("T11: 頭上リング (AgentDetail, issue #180 follow-up)", () => {
  test("1199px desktop sidebar: taskRing=1 で .task-ring が描画・回転する", async ({ page }) => {
    await page.setViewportSize({ width: 1199, height: 900 });
    await page.goto(`${DETAIL}&taskRing=1`);
    const ring = page.locator("aside.status .portrait .task-ring");
    await expect(ring).toBeVisible();
    await expect(ring).toHaveAttribute("role", "img");
    const animationName = await ring.evaluate(
      (el) => getComputedStyle(el).animationName,
    );
    expect(animationName).not.toBe("none");
  });

  test("1199px desktop sidebar: taskRing 省略時は .task-ring を描画しない", async ({ page }) => {
    await page.setViewportSize({ width: 1199, height: 900 });
    await page.goto(DETAIL);
    await expect(page.locator("aside.status .portrait .task-ring")).toHaveCount(0);
  });

  test("844px sheet open: taskRing=1 で .task-ring が描画される", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 900 });
    await page.goto(`${DETAIL}&taskRing=1`);
    await page.locator(".sheet .handle .toggle").click();
    const ring = page.locator("aside.status .portrait .task-ring");
    await expect(ring).toBeVisible();
  });
});

test("T8: handle attention badge returns to the grid while the sheet is open", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 900 });
  await page.goto(`${DETAIL}&attention=1`);
  // Closed sheet: the ordinary blindspot button carries the affordance.
  await expect(page.locator("button.blindspot")).toBeVisible();
  await page.locator(".sheet .handle .toggle").click();
  const badge = page.locator(".sheet .handle .attention");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("1 体");
  await badge.click();
  // onClose fired — same operation as button.blindspot (ADR-0052 F3).
  await expect(page.getByTestId("closed-marker")).toBeVisible();
});
