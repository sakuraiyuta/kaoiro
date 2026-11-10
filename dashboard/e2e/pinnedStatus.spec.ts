// Issue 1074: the ctx / rate-limit gauges and the status line stay in view.
// From 1199px they sit under the agent ID (copy "head"); from 940px to 1198px
// above the log, outside the status sheet (copy "main"); at 939px and narrower
// the same bar is collapsed until opened. Tests pick a copy by its
// data-placement for the width they set and assert its visibility separately.
import { expect, test, type Locator, type Page } from "@playwright/test";

const DETAIL = "/e2e/harness/index.html?view=detail";
// Eleven lines of markdown: well over the three-line clamp.
const LONG = `${DETAIL}&statusLine=hostile`;
// One short line: fits in the clamp.
const SHORT = `${DETAIL}&statusLine=cutlink`;

const head = (page: Page) => page.locator('[data-placement="head"]');
const main = (page: Page) => page.locator('[data-placement="main"]');
const ctxRow = (root: Locator) => root.locator(".cc-row", { has: root.page().locator("dt", { hasText: /^ctx$/ }) });
const rateRow = (root: Locator) => root.locator(".cc-row", { has: root.page().locator("dt", { hasText: /^7day$/ }) });

async function top(locator: Locator): Promise<number> {
  return (await locator.boundingBox())!.y;
}

async function expectInViewport(page: Page, locator: Locator): Promise<void> {
  const box = (await locator.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

for (const [width, height] of [
  [1920, 1080],
  [1199, 900],
] as const) {
  test(`${width}x${height}: under the agent ID, visible without scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(LONG);

    await expect(page.locator("[data-placement]")).toHaveCount(2);
    await expect(main(page)).toBeHidden();
    for (const target of [ctxRow(head(page)), rateRow(head(page)), head(page).locator(".status-line-panel")]) {
      await expect(target).toBeVisible();
      await expectInViewport(page, target);
    }
    const before = await top(ctxRow(head(page)));
    await page.locator(".status-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await top(ctxRow(head(page)))).toBe(before);
    await expect(page.locator(".status-scroll dt", { hasText: /^ctx$/ })).toHaveCount(0);
  });
}

for (const [width, height] of [
  [1198, 900],
  [940, 700],
] as const) {
  test(`${width}x${height}: above the log, outside the sheet, always open`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(LONG);

    await expect(head(page)).toBeHidden();
    await expect(main(page)).toBeVisible();
    // The narrow-layout flag is untouched (closed) and has no effect here.
    await expect(main(page)).toHaveAttribute("data-open", "false");
    await expect(main(page).locator(".disclosure")).toBeHidden();
    await expect(ctxRow(main(page))).toBeVisible();
    await expect(rateRow(main(page))).toBeVisible();
    await expect(main(page).locator(".status-line-panel")).toBeVisible();
    expect(await top(main(page))).toBeLessThan(await top(page.locator(".log")));

    // The log scrolls; the bar does not move with it.
    const before = await top(ctxRow(main(page)));
    await page.locator(".log").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await top(ctxRow(main(page)))).toBe(before);

    // Nothing pinned is displayed inside the opened sheet.
    await page.locator(".sheet .handle .toggle").click();
    await expect(page.locator("aside.status")).toBeVisible();
    await expect(page.locator("aside.status dt", { hasText: /^ctx$/ })).toBeHidden();
    await expect(page.locator("aside.status .status-line-panel")).toBeHidden();
  });
}

for (const [width, height] of [
  [939, 800],
  [844, 390],
] as const) {
  test(`${width}x${height}: collapsed above the log until opened`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(LONG);

    await expect(head(page)).toBeHidden();
    const disclosure = main(page).locator("button.disclosure");
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(main(page).locator(".pinned-body")).toBeHidden();

    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(ctxRow(main(page))).toBeVisible();
    await expect(main(page).locator(".status-line-panel")).toBeVisible();

    await disclosure.click();
    await expect(main(page).locator(".pinned-body")).toBeHidden();

    // The sheet still opens and holds the status controls.
    await page.locator(".sheet .handle .toggle").click();
    await expect(page.locator("aside.status")).toBeVisible();
    await expect(page.locator("aside.status .status-scroll")).toBeVisible();
  });
}

// Q42: a desktop window 699px high or less gets the bar above the log, so the
// sidebar keeps the height it had before the pinned area (base c0a2fdef:
// 162-288px at these sizes).
for (const [width, height] of [
  [1366, 650],
  [1280, 600],
  [1199, 560],
  [1440, 500],
  [1920, 500],
] as const) {
  test(`${width}x${height}: short desktop, above the log, sidebar keeps its room`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(LONG);

    await expect(page.locator("aside.status")).toBeVisible();
    await expect(head(page)).toBeHidden();
    await expect(main(page)).toBeVisible();
    for (const target of [ctxRow(main(page)), rateRow(main(page)), main(page).locator(".status-line-panel")]) {
      await expect(target).toBeVisible();
      await expectInViewport(page, target);
    }
    const room = await page.locator(".status-scroll").evaluate((el) => el.clientHeight);
    expect(room).toBeGreaterThanOrEqual(150);
  });
}

for (const [width, height] of [
  [1199, 700],
  [1366, 700],
] as const) {
  test(`${width}x${height}: 700px high keeps the bar under the agent ID`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(LONG);

    await expect(head(page)).toBeVisible();
    await expect(main(page)).toBeHidden();
    await expectInViewport(page, ctxRow(head(page)));
  });
}

test.describe("status line clamp (expand in place)", () => {
  test("a long line shows three lines and expands in place", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(LONG);
    const body = head(page).locator(".status-line-panel .body");
    const toggle = head(page).locator("button.expand");

    const clamped = await body.evaluate((el) => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      return { height: el.clientHeight, scroll: el.scrollHeight, lineHeight };
    });
    expect(clamped.height).toBeLessThanOrEqual(clamped.lineHeight * 3 + 1);
    expect(clamped.scroll).toBeGreaterThan(clamped.height);
    await expect(toggle).toHaveText("全文を表示");
    await expect(toggle).toHaveAttribute("aria-controls", (await body.getAttribute("id"))!);

    await toggle.click();
    await expect(toggle).toHaveText("折りたたむ");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const expanded = await body.evaluate((el) => ({ height: el.clientHeight }));
    expect(expanded.height).toBeGreaterThan(clamped.height);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("three lines hold three lines of text when the head opens with a heading", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${DETAIL}&statusLine=heading`);
    const body = head(page).locator(".status-line-panel .body");
    await expect(body.locator("h2")).toHaveText("Target");

    const fits = await body.evaluate((el) => {
      const bottom = el.getBoundingClientRect().top + el.clientHeight;
      const lines = [el.querySelector("h2")!, ...el.querySelectorAll("li")];
      return lines.map((line) => line.getBoundingClientRect().bottom <= bottom + 1);
    });
    // The heading and the first two items are whole; the rest is clamped.
    expect(fits).toEqual([true, true, true, false, false]);
    await expect(head(page).locator("button.expand")).toBeVisible();
  });

  test("a one-line status line has no toggle", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(SHORT);
    await expect(head(page).locator(".status-line-panel .body")).toBeVisible();
    await expect(page.locator("button.expand")).toHaveCount(0);
  });

  test("the expanded state and the toggle survive crossing 1198/1199", async ({ page }) => {
    await page.setViewportSize({ width: 1198, height: 900 });
    await page.goto(LONG);
    await main(page).locator("button.expand").click();
    await expect(main(page).locator("button.expand")).toHaveAttribute("aria-expanded", "true");

    await page.setViewportSize({ width: 1199, height: 900 });
    await expect(head(page).locator("button.expand")).toBeVisible();
    await expect(head(page).locator("button.expand")).toHaveAttribute("aria-expanded", "true");

    await head(page).locator("button.expand").click();
    await page.setViewportSize({ width: 1198, height: 900 });
    await expect(main(page).locator("button.expand")).toBeVisible();
    await expect(main(page).locator("button.expand")).toHaveAttribute("aria-expanded", "false");
  });
});

// The pinned area takes height from the sidebar scroll (desktop) or the log
// (below 1199px). With the status line expanded to its cap, both keep room.
for (const [width, height, scroller] of [
  [1199, 700, ".status-scroll"],
  [1198, 700, ".log"],
  [940, 600, ".log"],
  [1198, 480, ".log"],
  [844, 390, ".log"],
] as const) {
  test(`${width}x${height}: ${scroller} keeps room with the line expanded`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(LONG);
    const copy = width >= 1199 ? head(page) : main(page);
    if (width <= 939) await copy.locator("button.disclosure").click();
    await copy.locator("button.expand").click();
    await expect(copy.locator("button.expand")).toHaveAttribute("aria-expanded", "true");

    const room = await page.locator(scroller).evaluate((el) => el.clientHeight);
    expect(room).toBeGreaterThan(0);
  });
}
