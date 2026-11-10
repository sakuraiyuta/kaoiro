// Issue #269: the English UI keeps the layout guarantees of
// docs/reference/ui/responsive-layout.md. English text is longer than the
// Japanese it replaces, so each screen is opened in both languages at the
// narrowest and the widest viewport its own spec uses. In en the page must not
// scroll sideways, no element may overflow its box sideways unless it already
// does in ja, and a dialog's buttons must stay inside the viewport. A long
// sentence that wraps is fine.
import { expect, test, type Browser, type Page } from "@playwright/test";

test.use({ locale: "en-US" });

const LOBBY = "/e2e/harness/index.html?view=lobby&role=operator";
const ROOMS = "/e2e/harness/index.html?view=app&live=6&offline=2&rooms=1";
const DETAIL = "/e2e/harness/index.html?view=detail";
const DIALOG = "/e2e/harness/index.html?view=overlay&overlay=dialog";
const DRAWER = "/e2e/harness/index.html?view=overlay&overlay=drawer";

type Prepare = (page: Page) => Promise<void>;

// The harness pages mount the screens without App, so <html lang> does not
// follow the locale there; the browser language is what "auto" resolves from.
async function expectEnglishBrowser(page: Page): Promise<void> {
  expect(await page.evaluate(() => navigator.languages[0])).toBe("en-US");
}

// A drawer slides in; measured mid-transition, its buttons are still outside.
// Looping animations (a face, a ring) are frozen at their first frame, so both
// languages are measured at the same phase.
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite: Promise<unknown>[] = [];
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().iterations === Infinity) {
        animation.pause();
        animation.currentTime = 0;
      } else {
        finite.push(animation.finished);
      }
    }
    await Promise.all(finite);
  });
}

/** Elements whose content is wider than their box, named by their position in
 *  the tree (the tree is the same in both languages). */
async function overflowing(page: Page): Promise<string[]> {
  await settle(page);
  return page.evaluate(() => {
    const position = (el: Element): string => {
      const parts: string[] = [];
      for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
        const index = Array.prototype.indexOf.call(e.parentElement!.children, e);
        parts.unshift(`${e.tagName.toLowerCase()}[${index}]`);
      }
      return parts.join("/");
    };
    const out: string[] = [];
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
      if (el.clientWidth > 0 && el.scrollWidth - el.clientWidth > 1) {
        out.push(`${position(el)} .${el.className}`);
      }
    }
    return out;
  });
}

async function expectNoNewOverflow(
  browser: Browser,
  page: Page,
  prepare: Prepare,
): Promise<void> {
  const viewport = page.viewportSize()!;
  const context = await browser.newContext({ locale: "ja-JP", viewport });
  try {
    const reference = await context.newPage();
    await reference.goto(page.url());
    await prepare(reference);
    const inJapanese = new Set(await overflowing(reference));
    const onlyInEnglish = (await overflowing(page)).filter((el) => !inJapanese.has(el));
    expect(onlyInEnglish).toEqual([]);
  } finally {
    await context.close();
  }
  const sideways = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(sideways).toBeLessThanOrEqual(0);
}

async function expectButtonsInside(page: Page, width: number): Promise<void> {
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

for (const width of [939, 1920]) {
  test(`lobby in en at ${width}px`, async ({ browser, page }) => {
    const prepare: Prepare = async (p) => {
      await expect(p.locator(".card").first()).toBeVisible();
    };
    await page.setViewportSize({ width, height: 900 });
    await page.goto(LOBBY);
    await expectEnglishBrowser(page);
    await prepare(page);
    await expect(page.locator('button[aria-label^="Open details of "]').first()).toBeVisible();
    await expectNoNewOverflow(browser, page, prepare);
  });
}

for (const width of [375, 1920]) {
  test(`rooms in en at ${width}px`, async ({ browser, page }) => {
    // The room names are the operator's own and stay as typed in both languages.
    const prepare: Prepare = async (p) => {
      await expect(p.locator(".live-dashboard .room-header").first()).toBeVisible();
      await p.locator('button[aria-label$="to another room"], button[aria-label$="を別の部屋へ移動"]').first().click();
      await expect(p.locator("dialog[open] .note")).toBeVisible();
    };
    await page.setViewportSize({ width, height: 900 });
    await page.goto(ROOMS);
    await expectEnglishBrowser(page);
    await prepare(page);
    await expect(page.locator(".live-dashboard .room-header h3").first()).toHaveText("Lobby");
    await expectNoNewOverflow(browser, page, prepare);
    await expectButtonsInside(page, width);
  });
}

for (const width of [844, 1198, 1920]) {
  test(`detail in en at ${width}px`, async ({ browser, page }) => {
    // Below the sidebar breakpoint the status column lives in a sheet; at
    // 1198px the pinned gauges sit side by side above the log (issue 1074).
    const prepare: Prepare = async (p) => {
      await expect(p.locator("form.instruct")).toBeVisible();
      const toggle = p.locator(".sheet .handle .toggle");
      if (await toggle.isVisible()) {
        await toggle.click();
        await expect(p.locator("aside.status")).toBeVisible();
      }
    };
    await page.setViewportSize({ width, height: 900 });
    await page.goto(DETAIL);
    await expectEnglishBrowser(page);
    await prepare(page);
    await expect(page.locator("button.back")).toHaveText("Back to the grid");
    await expectNoNewOverflow(browser, page, prepare);
  });
}

// The settings drawer shows one tab at a time and only the visible tab is
// measured, so each of its four tabs gets its own case (issue 1076).
for (const [name, url, content, tab] of [
  ["launch dialog", DIALOG, ".launch-dialog-content", null],
  ["settings drawer, tab 1", DRAWER, ".settings-drawer-content", 0],
  ["settings drawer, tab 2", DRAWER, ".settings-drawer-content", 1],
  ["settings drawer, tab 3", DRAWER, ".settings-drawer-content", 2],
  ["settings drawer, tab 4", DRAWER, ".settings-drawer-content", 3],
] as const) {
  for (const width of [375, 1024]) {
    test(`${name} in en at ${width}px`, async ({ browser, page }) => {
      const prepare: Prepare = async (p) => {
        await expect(p.locator(content)).toBeVisible();
        if (tab !== null) {
          await p.getByRole("tab").nth(tab).click();
          await expect(p.getByRole("tab").nth(tab)).toHaveAttribute("aria-selected", "true");
        }
      };
      await page.setViewportSize({ width, height: 700 });
      await page.goto(url);
      await expectEnglishBrowser(page);
      await prepare(page);
      await expectNoNewOverflow(browser, page, prepare);
      await expectButtonsInside(page, width);
    });
  }
}
