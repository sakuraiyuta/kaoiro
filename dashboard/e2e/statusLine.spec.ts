// issue 482: the status line change log renders text an agent wrote. The unit
// tests pin what the renderer emits; whether a real browser then runs, loads
// or follows any of it is only observable in one. This spec mounts the
// production dialog with the real renderer (marked + DOMPurify) and feeds it a
// hostile entry; the only fixture is the history it fetches.
import { expect, test, type Page } from "@playwright/test";

const HISTORY =
  "/e2e/harness/index.html?view=overlay&overlay=status-line-history";

async function openLog(page: Page): Promise<string[]> {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await page.goto(HISTORY);
  await page.locator("#status-line-trigger").click();
  await expect(page.locator("dialog")).toBeVisible();
  await expect(page.locator('li[data-seq="3"] .untrusted-markdown')).toBeVisible();
  return requested;
}

const newest = (page: Page) => page.locator('li[data-seq="3"]');

test.describe("status line change log renders untrusted markdown (issue 482)", () => {
  test("raw HTML is shown as text and nothing in it runs", async ({ page }) => {
    await openLog(page);

    await expect(newest(page)).toContainText(
      '<script>window.__pwned = "script"</script>',
    );
    await expect(newest(page)).toContainText("onerror=");
    await expect(page.locator("dialog script")).toHaveCount(0);
    await expect(page.locator("dialog img")).toHaveCount(0);

    // An onerror handler would fire after the image failed to load.
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => (window as { __pwned?: unknown }).__pwned)).toBe(
      undefined,
    );
  });

  test("an image becomes a link and the browser fetches nothing from its host", async ({
    page,
  }) => {
    const requested = await openLog(page);

    const pixel = newest(page).locator("a", { hasText: "tracking pixel" });
    await expect(pixel).toHaveAttribute("href", "https://evil.test/pixel.png");
    await page.waitForLoadState("networkidle");

    expect(requested.filter((url) => url.includes("evil.test"))).toEqual([]);
  });

  test("only http(s) links stay links, and they cannot reach back to the page", async ({
    page,
  }) => {
    await openLog(page);

    const anchors = newest(page).locator("a");
    const hrefs = await anchors.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("href")),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toMatch(/^https?:\/\//);

    // The labels of the refused links stay, as text.
    await expect(newest(page)).toContainText("run me");
    await expect(newest(page)).toContainText("inline data");
    await expect(newest(page).locator("a", { hasText: "run me" })).toHaveCount(0);

    const safe = newest(page).locator("a", { hasText: "safe link" });
    await expect(safe).toHaveAttribute("href", "https://example.test/ok");
    await expect(safe).toHaveAttribute("target", "_blank");
    await expect(safe).toHaveAttribute("rel", "noopener noreferrer nofollow");
  });

  test("an entry nested past the limit shows its source as text, with a note", async ({
    page,
  }) => {
    await openLog(page);
    const deep = page.locator('li[data-seq="2"]');

    await expect(deep.locator(".untrusted-markdown")).toHaveCount(0);
    await deep.getByRole("button", { name: "展開" }).click();

    await expect(deep.locator(".untrusted-markdown-note")).toBeVisible();
    await expect(deep.locator(".untrusted-markdown.plain")).toContainText(
      `${">".repeat(40)} nested past the limit`,
    );
    await expect(deep.locator("blockquote")).toHaveCount(0);

    await expect(page.locator('li[data-seq="1"]')).toContainText("(クリア)");
  });
});
