// Issue #537: the room separators and the room dialog in the real App (behind
// the wire stand-in that joins as an operator with a complete rooms_snapshot).
// Every control must be reachable by a real click at a smartphone width, and a
// dialog's buttons must stay inside the viewport.
import { expect, test, type Page } from "@playwright/test";

const APP = "/e2e/harness/index.html?view=app&live=6&offline=2&rooms=1";
const LONG = "Release coordination for the autumn deployment window";
const SIZES = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

async function expectDialogFits(page: Page, width: number): Promise<void> {
  const boxes = await page.locator("dialog[open] button:visible").evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { left: box.left, right: box.right };
    }),
  );
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
  }
}

/** Opens a dialog with a real click, checks it, and closes it with Escape. */
async function openCheckClose(page: Page, width: number, control: string, text: string | null): Promise<void> {
  await page.locator(control).first().click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  if (text !== null) await expect(dialog).toContainText(text);
  await expectDialogFits(page, width);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

for (const size of SIZES) {
  test(`${size.name}: rooms are separated, and every control is reachable`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(APP);

    const headers = page.locator(".live-dashboard .room-header");
    await expect(headers).toHaveCount(4);
    await expect(headers.locator("h3")).toHaveText(["ロビー", "Review", LONG, "Empty"]);
    await expect(headers.nth(3)).toContainText("この部屋に agent はいません");
    await expect(page.locator(".offline .room-header h3")).toHaveText(["ロビー"]);

    await openCheckClose(page, size.width, 'button:has-text("部屋を作成")', null);
    await openCheckClose(page, size.width, `button[aria-label="部屋 ${LONG} を改名"]`, LONG);
    await openCheckClose(
      page,
      size.width,
      'button[aria-label="部屋 Empty を削除"]',
      "この削除で 2 件の会話が閉じます。",
    );
    await openCheckClose(
      page,
      size.width,
      'button[aria-label$="を別の部屋へ移動"]',
      "この移動で 2 件の会話が閉じます。",
    );

    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(0);
  });
}
