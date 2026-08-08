// T9-T10 (phase-31 31-10): the `short` (max-height 500px) vertical
// compression override — switching exactly at the 500/501 boundary, and
// low-viewport dialog/drawer internal scrolling (ADR-0052 F8).
import { expect, test, type Page } from "@playwright/test";

const APP = "/e2e/harness/index.html?view=app";
const DETAIL = "/e2e/harness/index.html?view=detail";
const DIALOG = "/e2e/harness/index.html?view=overlay&overlay=dialog";
const DRAWER = "/e2e/harness/index.html?view=overlay&overlay=drawer";

async function cssOf(
  page: Page,
  selector: string,
  property: string,
): Promise<string> {
  return page
    .locator(selector)
    .first()
    .evaluate(
      (el, prop) => getComputedStyle(el).getPropertyValue(prop),
      property,
    );
}

test.describe("T9: 500/501 boundary flips only the vertical compression", () => {
  test("header vertical padding compresses at 500", async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 501 });
    await page.goto(APP);
    await expect(page.locator("header")).toBeVisible();
    const tall = await cssOf(page, "header", "padding-top");
    await page.setViewportSize({ width: 1300, height: 500 });
    const short = await cssOf(page, "header", "padding-top");
    expect(parseFloat(short)).toBeLessThan(parseFloat(tall));
  });

  test("composer starts one line tall and expands on focus", async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 501 });
    await page.goto(DETAIL);
    const textarea = page.locator(".instruct textarea");
    const tall = (await textarea.boundingBox())!.height;
    await page.setViewportSize({ width: 1300, height: 500 });
    const initial = (await textarea.boundingBox())!.height;
    expect(initial).toBeLessThan(tall);
    await textarea.focus();
    const focused = (await textarea.boundingBox())!.height;
    expect(focused).toBeGreaterThan(initial);
  });

  test("dock height cap applies at 500 only", async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 501 });
    await page.goto(`${DETAIL}&pending=permission`);
    await expect(page.locator(".permission-dock")).toBeVisible();
    expect(await cssOf(page, ".permission-dock", "max-block-size")).toBe("none");
    await page.setViewportSize({ width: 1300, height: 500 });
    expect(
      await cssOf(page, ".permission-dock", "max-block-size"),
    ).not.toBe("none");
  });

  test("dialog / drawer gain max-block-size + own scroll at 500", async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 501 });
    await page.goto(DIALOG);
    expect(await cssOf(page, ".dialog", "max-block-size")).toBe("none");
    await page.setViewportSize({ width: 1300, height: 500 });
    expect(await cssOf(page, ".dialog", "max-block-size")).not.toBe("none");
    expect(await cssOf(page, ".dialog", "overflow-y")).toBe("auto");

    await page.setViewportSize({ width: 1300, height: 501 });
    await page.goto(DRAWER);
    expect(await cssOf(page, ".drawer", "overflow-y")).toBe("visible");
    await page.setViewportSize({ width: 1300, height: 500 });
    expect(await cssOf(page, ".drawer", "overflow-y")).toBe("auto");
  });

  test("sheet max height stays 60% across the boundary", async ({ page }) => {
    for (const height of [501, 500]) {
      await page.setViewportSize({ width: 844, height });
      await page.goto(DETAIL);
      await page.locator(".sheet .handle .toggle").click();
      const panel = page.locator(".sheet .panel");
      await expect(panel).toBeVisible();
      const max = parseFloat(
        await panel.evaluate((el) => getComputedStyle(el).maxBlockSize),
      );
      expect(max).toBeCloseTo(height * 0.6, 0);
    }
  });
});

test.describe("T10: low viewport keeps dialog / drawer uncut", () => {
  test("LaunchDialog fits 390px height and scrolls internally", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto(DIALOG);
    const dialog = page.locator(".dialog");
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(390);
    const overflows = await dialog.evaluate(
      (el) => el.scrollHeight > el.clientHeight,
    );
    expect(overflows).toBe(true);
  });

  test("SettingsDrawer fits 390px height without clipping rows", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto(DRAWER);
    const drawer = page.locator(".drawer");
    await expect(drawer).toBeVisible();
    expect(await cssOf(page, ".drawer", "overflow-y")).toBe("auto");
    const box = (await drawer.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(390);
  });
});
