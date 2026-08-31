// issue #277: LaunchDialog migrated off its own hand-rolled backdrop onto
// the shared Modal.svelte primitive (issue #232 MF-3). jsdom cannot
// simulate HTMLDialogElement.showModal(), so the actual a11y properties
// (initial focus / Escape-to-close / Tab-trap / focus-restore) need a
// real browser -- mirrors modal.spec.ts's PersonaDetailDialog specs.
import { expect, test } from "@playwright/test";

const DIALOG =
  "/e2e/harness/index.html?view=overlay&overlay=dialog-triggered";

test.describe("LaunchDialog a11y (issue #277)", () => {
  test("host selector shows the runner build identity after host_id", async ({
    page,
  }) => {
    await page.goto(DIALOG);
    await page.locator("#dialog-trigger").click();

    await expect(page.locator("dialog select").first().locator("option")).toHaveText(
      "e2e-host — kaoiro dev runner v2026.9.0 / 0123456",
    );
  });

  test("開くと「新規」タブに初期フォーカスが当たる", async ({ page }) => {
    await page.goto(DIALOG);
    await page.locator("#dialog-trigger").click();

    await expect(
      page.locator('dialog button[role="tab"]', { hasText: "新規" }),
    ).toBeFocused();
  });

  // issue #277 round1 must-fix (ふじ): the ORIGINAL autofocus target
  // (Cancel, at the bottom of this scrollable form) passed its OWN
  // isolated focus assertion while ALSO scrolling the internal scroll
  // owner to the bottom at low viewport heights -- a focus-only or
  // scrollability-only assertion never catches that combination. Pins
  // all three together at the exact viewport ふじ measured against
  // (844x390): the new autofocus target focused, the scroll owner still
  // at its top, and the title actually inside the viewport.
  test("低 viewport (844x390) でも初期フォーカスが content を先頭から動かさない", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto(DIALOG);
    await page.locator("#dialog-trigger").click();

    await expect(
      page.locator('dialog button[role="tab"]', { hasText: "新規" }),
    ).toBeFocused();

    const info = await page.evaluate(() => {
      const content = document.querySelector(".launch-dialog-content")!;
      const h2 = content.querySelector("h2")!;
      return {
        scrollTop: content.scrollTop,
        h2Top: h2.getBoundingClientRect().top,
      };
    });
    expect(info.scrollTop).toBe(0);
    expect(info.h2Top).toBeGreaterThanOrEqual(0);
  });

  test("Escape で閉じる", async ({ page }) => {
    await page.goto(DIALOG);
    await page.locator("#dialog-trigger").click();
    await expect(page.locator("dialog")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.locator("dialog")).toBeHidden();
  });

  test("閉じると trigger ボタンへフォーカスが戻る", async ({ page }) => {
    await page.goto(DIALOG);
    await page.locator("#dialog-trigger").click();

    await page.keyboard.press("Escape");

    await expect(page.locator("#dialog-trigger")).toBeFocused();
  });

  // showModal() makes every element outside the <dialog> inert (HTML
  // spec) -- Tab must never leave it while open. The form has several
  // focusable controls (tabs, host select, cancel/submit) to cycle
  // through.
  test("Tab を繰り返してもフォーカスが dialog の外へ出ない", async ({ page }) => {
    await page.goto(DIALOG);
    await page.locator("#dialog-trigger").click();
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

  test("キャンセルボタンのクリックで閉じ、trigger へフォーカスが戻る", async ({
    page,
  }) => {
    await page.goto(DIALOG);
    await page.locator("#dialog-trigger").click();

    await page
      .locator("dialog button.ghost", { hasText: "キャンセル" })
      .click();

    await expect(page.locator("dialog")).toBeHidden();
    await expect(page.locator("#dialog-trigger")).toBeFocused();
  });

  // dialog is a full-viewport flex box (Modal.svelte) with `.modal-content`
  // centered inside it -- clicking near a corner lands on the dialog
  // element itself (outside `.modal-content`), the outside-click signal.
  test("dialog の余白 (背景相当) クリックで閉じる", async ({ page }) => {
    await page.goto(DIALOG);
    await page.locator("#dialog-trigger").click();
    await expect(page.locator("dialog")).toBeVisible();

    await page.mouse.click(5, 5);

    await expect(page.locator("dialog")).toBeHidden();
  });

  test("フォーム内のクリックでは閉じない", async ({ page }) => {
    await page.goto(DIALOG);
    await page.locator("#dialog-trigger").click();
    await expect(page.locator("dialog")).toBeVisible();

    await page.locator("dialog h2").click();

    await expect(page.locator("dialog")).toBeVisible();
  });
});
