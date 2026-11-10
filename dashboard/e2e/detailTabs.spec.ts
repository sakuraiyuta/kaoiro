// Issue 1075: the AgentDetail detail area has an engine tab and a kaoiro tab
// at every width; below 1199px they live in the bottom sheet.
import { expect, test, type Page } from "@playwright/test";

const DETAIL = "/e2e/harness/index.html?view=detail&deliveryPolicy=1&wrapperBuild=1";

const tab = (page: Page, name: "engine" | "kaoiro") => page.locator(`#agent-detail-tab-${name}`);

async function openDetail(page: Page, width: number, height: number, query = ""): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`${DETAIL}${query}`);
  if (width < 1199) {
    await page.locator(".sheet .handle .toggle").click();
    await expect(page.locator("aside.status")).toBeVisible();
  }
}

/** Class names of the elements Tab stops on, starting from `start`. */
async function tabStops(page: Page, start: "engine" | "kaoiro"): Promise<string[]> {
  await tab(page, start).focus();
  const stops: string[] = [];
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => (document.activeElement as HTMLElement).className));
  }
  return stops;
}

const has = (stops: string[], cls: string) => stops.some((c) => c.split(/\s+/).includes(cls));

for (const [width, height] of [
  [1920, 1080],
  [1199, 900],
  [1198, 900],
  [844, 390],
] as const) {
  test(`${width}x${height}: the tabs switch panels and Tab skips the hidden one`, async ({ page }) => {
    await openDetail(page, width, height);

    await expect(page.getByRole("tablist")).toBeVisible();
    await expect(tab(page, "engine")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".terminate")).toBeVisible();
    await expect(page.locator(".clear-history")).toBeHidden();
    await expect(page.locator(".session-lifecycle-open")).toBeHidden();
    // Clear history is disabled in the harness (no session id), so the
    // session history button stands for the kaoiro panel's Tab stops.
    const engineStops = await tabStops(page, "engine");
    expect(has(engineStops, "terminate")).toBe(true);
    expect(has(engineStops, "session-lifecycle-open")).toBe(false);

    await tab(page, "kaoiro").click();
    await expect(tab(page, "kaoiro")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".session-lifecycle-open")).toBeVisible();
    await expect(page.locator(".terminate")).toBeHidden();
    const kaoiroStops = await tabStops(page, "kaoiro");
    expect(has(kaoiroStops, "session-lifecycle-open")).toBe(true);
    expect(has(kaoiroStops, "terminate")).toBe(false);
  });
}

for (const [width, height, owner] of [
  [1366, 700, ".status-scroll"],
  [844, 390, "aside.status"],
] as const) {
  test(`${width}x${height}: delete is reachable in the engine tab of a disconnected agent`, async ({
    page,
  }) => {
    await openDetail(page, width, height, "&disconnected=1");
    await expect(tab(page, "engine")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".main .remove")).toHaveCount(0);

    const scroll = page.locator(owner);
    // Without overflow the scroll below would prove nothing.
    expect(await scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
    await scroll.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const remove = page.locator(".remove");
    await expect(remove).toBeVisible();
    const box = (await remove.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
  });
}

test("the opened tab survives a reload", async ({ page }) => {
  await openDetail(page, 1920, 1080);
  await tab(page, "kaoiro").click();
  await page.reload();

  await expect(tab(page, "kaoiro")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".session-lifecycle-open")).toBeVisible();
  await expect(page.locator(".clear-history")).toBeAttached();
});
