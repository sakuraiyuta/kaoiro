// issue #277: SettingsDrawer migrated off its own hand-rolled backdrop
// onto the shared Modal.svelte primitive (issue #232 MF-3), keeping its
// own right-edge slide-in shape via a CSS escape hatch
// (`.settings-drawer-content { position: fixed; ... }` -- see
// SettingsDrawer.svelte's style block for the full rationale) instead of
// a Modal.svelte extension. jsdom cannot simulate
// HTMLDialogElement.showModal(), so the actual a11y properties need a
// real browser -- mirrors modal.spec.ts / launchDialog.spec.ts.
import { expect, test } from "@playwright/test";

const DRAWER =
  "/e2e/harness/index.html?view=overlay&overlay=drawer-triggered";

test.describe("SettingsDrawer a11y (issue #277)", () => {
  test("開くと閉じるボタンに初期フォーカスが当たる", async ({ page }) => {
    await page.goto(DRAWER);
    await page.locator("#drawer-trigger").click();

    await expect(page.locator("dialog button.close")).toBeFocused();
  });

  test("Escape で閉じる", async ({ page }) => {
    await page.goto(DRAWER);
    await page.locator("#drawer-trigger").click();
    await expect(page.locator("dialog")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.locator("dialog")).toBeHidden();
  });

  test("閉じると trigger ボタンへフォーカスが戻る", async ({ page }) => {
    await page.goto(DRAWER);
    await page.locator("#drawer-trigger").click();

    await page.keyboard.press("Escape");

    await expect(page.locator("#drawer-trigger")).toBeFocused();
  });

  test("Tab を繰り返してもフォーカスが dialog の外へ出ない", async ({
    page,
  }) => {
    await page.goto(DRAWER);
    await page.locator("#drawer-trigger").click();
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

  test("閉じるボタンのクリックで閉じ、trigger へフォーカスが戻る", async ({
    page,
  }) => {
    await page.goto(DRAWER);
    await page.locator("#drawer-trigger").click();

    await page.locator("dialog button.close").click();

    await expect(page.locator("dialog")).toBeHidden();
    await expect(page.locator("#drawer-trigger")).toBeFocused();
  });

  // director decision (issue #277): `.settings-drawer-content` escapes
  // Modal.svelte's flex-centering via `position: fixed`, so it no longer
  // occupies flex space inside the (otherwise empty, full-viewport)
  // <dialog>. A click OUTSIDE the visible drawer strip -- which now
  // only occupies the right edge, not the whole viewport -- must still
  // land on the <dialog> element itself and close it, exactly like every
  // other Modal.svelte caller's backdrop click. Pins the director's
  // condition 1: this trick must not silently break the outside-click
  // seam.
  test("drawer の表示領域外(左上の余白)クリックで閉じる", async ({
    page,
  }) => {
    await page.goto(DRAWER);
    await page.locator("#drawer-trigger").click();
    await expect(page.locator("dialog")).toBeVisible();

    // The drawer is right-edge-flush and at most 20rem (320px) wide --
    // (5, 5) is well outside it regardless of viewport size.
    await page.mouse.click(5, 5);

    await expect(page.locator("dialog")).toBeHidden();
  });

  test("drawer 内のクリックでは閉じない", async ({ page }) => {
    await page.goto(DRAWER);
    await page.locator("#drawer-trigger").click();
    await expect(page.locator("dialog")).toBeVisible();

    await page.locator("dialog h2").click();

    await expect(page.locator("dialog")).toBeVisible();
  });

  // issue #277 self-measured risk (not in the issue text): SettingsDrawer
  // becoming a real <dialog> means the existing confirm-close Modal
  // (issue #276) is now a <dialog> NESTED inside another <dialog> for
  // the first time -- previously the outer drawer was a plain div, so
  // there was no risk of the OUTER dialog's own Tab-trap handler also
  // firing (both dialogs' onkeydown listeners sit on the bubble path).
  // This proves the browser's native per-dialog inert scoping (the
  // outer dialog becomes inert while the inner one is topmost) keeps the
  // wraparound correctly scoped to the confirm dialog only, with no
  // leak into the drawer's own controls (e.g. the notification checkbox)
  // sitting behind it.
  test.describe("ネストした確認ダイアログ", () => {
    test("開くと確認ダイアログのキャンセルボタンに初期フォーカスが当たる", async ({
      page,
    }) => {
      await page.goto(DRAWER);
      await page.locator("#drawer-trigger").click();
      await page.locator(".conv-close").click();

      await expect(
        page.locator('dialog[aria-label="会話を閉じる確認"] button.cancel'),
      ).toBeFocused();
    });

    test("Tab を繰り返しても確認ダイアログの外(drawer 本体)へフォーカスが漏れない", async ({
      page,
    }) => {
      await page.goto(DRAWER);
      await page.locator("#drawer-trigger").click();
      await page.locator(".conv-close").click();
      await expect(
        page.locator('dialog[aria-label="会話を閉じる確認"]'),
      ).toBeVisible();

      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        const focusedInConfirm = await page.evaluate(() => {
          const confirm = document.querySelector(
            'dialog[aria-label="会話を閉じる確認"]',
          );
          return confirm !== null && confirm.contains(document.activeElement);
        });
        expect(focusedInConfirm).toBe(true);
      }
    });

    test("Escape で確認ダイアログのみ閉じ、drawer 本体は残る", async ({
      page,
    }) => {
      await page.goto(DRAWER);
      await page.locator("#drawer-trigger").click();
      await page.locator(".conv-close").click();
      await expect(
        page.locator('dialog[aria-label="会話を閉じる確認"]'),
      ).toBeVisible();

      await page.keyboard.press("Escape");

      await expect(
        page.locator('dialog[aria-label="会話を閉じる確認"]'),
      ).toBeHidden();
      await expect(page.locator('dialog[aria-label="設定"]')).toBeVisible();
    });
  });
});
