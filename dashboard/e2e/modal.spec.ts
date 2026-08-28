// issue #232 MF-3 (ふじ round-1 must-fix): the shared Modal.svelte
// primitive's a11y contract — initial focus, Escape-to-close, Tab trap
// (background inert while showModal() is open), and focus restore on
// close — needs a REAL browser. jsdom does not implement
// HTMLDialogElement.showModal (vitest's polyfill only toggles the `open`
// attribute), so none of these properties are observable there; this
// spec is the actual verification.
import { expect, test } from "@playwright/test";

const PERSONA_MODAL =
  "/e2e/harness/index.html?view=overlay&overlay=persona";

test.describe("Modal a11y (issue #232 MF-3)", () => {
  test("開くと close ボタンに初期フォーカスが当たる", async ({ page }) => {
    await page.goto(PERSONA_MODAL);
    await page.locator("#persona-trigger").click();

    await expect(page.locator("dialog button.close")).toBeFocused();
  });

  test("Escape で閉じる", async ({ page }) => {
    await page.goto(PERSONA_MODAL);
    await page.locator("#persona-trigger").click();
    await expect(page.locator("dialog")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.locator("dialog")).toBeHidden();
  });

  test("閉じると trigger ボタンへフォーカスが戻る", async ({ page }) => {
    await page.goto(PERSONA_MODAL);
    await page.locator("#persona-trigger").click();

    await page.keyboard.press("Escape");

    await expect(page.locator("#persona-trigger")).toBeFocused();
  });

  // showModal() makes every element outside the <dialog> inert (HTML
  // spec) — Tab must never leave it while open. The fixture persona
  // has both a close button AND an (http) homepage link, so there is
  // more than one focusable element to cycle through.
  test("Tab を繰り返してもフォーカスが dialog の外へ出ない", async ({ page }) => {
    await page.goto(PERSONA_MODAL);
    await page.locator("#persona-trigger").click();
    await expect(page.locator("dialog")).toBeVisible();

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const focusedInDialog = await page.evaluate(() => {
        const dialog = document.querySelector("dialog");
        return dialog !== null && dialog.contains(document.activeElement);
      });
      expect(focusedInDialog).toBe(true);
    }
  });

  test("close ボタンのクリックで閉じ、trigger へフォーカスが戻る", async ({ page }) => {
    await page.goto(PERSONA_MODAL);
    await page.locator("#persona-trigger").click();

    await page.locator("dialog button.close").click();

    await expect(page.locator("dialog")).toBeHidden();
    await expect(page.locator("#persona-trigger")).toBeFocused();
  });

  // dialog is a full-viewport flex box (Modal.svelte) with `.modal-content`
  // centered inside it — clicking near a corner lands on the dialog
  // element itself (outside `.modal-content`), which Modal.svelte treats
  // as an outside click.
  test("dialog の余白 (背景相当) クリックで閉じる", async ({ page }) => {
    await page.goto(PERSONA_MODAL);
    await page.locator("#persona-trigger").click();
    await expect(page.locator("dialog")).toBeVisible();

    await page.mouse.click(5, 5);

    await expect(page.locator("dialog")).toBeHidden();
  });

  test("`.modal-content` 内のクリックでは閉じない", async ({ page }) => {
    await page.goto(PERSONA_MODAL);
    await page.locator("#persona-trigger").click();
    await expect(page.locator("dialog")).toBeVisible();

    await page.locator("dialog h2").click();

    await expect(page.locator("dialog")).toBeVisible();
  });
});
