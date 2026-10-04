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

// issue 514: the same text on the agent card and in the member detail view. The
// production AgentCard / AgentDetail and the real markdown renderer are mounted;
// the only fixture is the line the harness hands them.
const CARD = "/e2e/harness/index.html?view=lobby&role=operator&statusLine=hostile";
const DETAIL = "/e2e/harness/index.html?view=detail&statusLine=hostile";

const pwned = (page: Page) => page.evaluate(() => (window as { __pwned?: unknown }).__pwned);

/** WCAG contrast of two CSS colours. Both are painted on a canvas first, so any
 *  syntax the browser accepts (color-mix included) comes back as sRGB. */
function contrastBetween(page: Page, fg: string, bg: string): Promise<number> {
  return page.evaluate(
    ([foreground, background]) => {
      const rgb = (css: string): number[] => {
        const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
        ctx.canvas.width = 1;
        ctx.canvas.height = 1;
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
      };
      const luminance = ([r, g, b]: number[]) => {
        const channel = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
      };
      const [l1, l2] = [luminance(rgb(foreground!)), luminance(rgb(background!))];
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    },
    [fg, bg],
  );
}

async function watchRequests(page: Page): Promise<string[]> {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  return requested;
}

test.describe("a hostile status line on the agent card (issue 514)", () => {
  const rows = (page: Page) => page.locator("button.status-line");

  test("draws the markdown, with nothing pressable, block or loadable inside the button", async ({ page }) => {
    const requested = await watchRequests(page);
    await page.goto(CARD);
    const row = rows(page).first();
    await expect(row).toBeVisible();

    await expect(row.locator("strong").first()).toHaveText("bold");
    await expect(row.locator("code").first()).toHaveText("code");
    await expect(row.locator(".md-link")).toHaveText(["safe link"]);
    await expect(row).toContainText("run me");
    await expect(row).toContainText("tracking pixel");

    await expect(
      rows(page).locator(
        "a, img, script, iframe, svg, style, form, input, select, textarea, button, div, p, h1, h2, ul, ol, li, table, pre, [tabindex]",
      ),
    ).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(await pwned(page)).toBeUndefined();
    expect(requested.filter((url) => url.includes("evil.test"))).toEqual([]);
  });

  test("underlines a link and nothing else", async ({ page }) => {
    await page.goto(CARD);
    const row = rows(page).first();

    const decorations = await row.evaluate((el) => ({
      link: getComputedStyle(el.querySelector(".md-link")!).textDecorationLine,
      text: getComputedStyle(el.querySelector(".status-text")!).textDecorationLine,
    }));

    expect(decorations.link).toContain("underline");
    expect(decorations.text).not.toContain("underline");
  });

  test("pressing a link's label opens the change log and goes nowhere", async ({ page, context }) => {
    let opened = 0;
    context.on("page", () => (opened += 1));
    await page.goto(CARD);
    const before = page.url();

    await rows(page).first().locator(".md-link").click();

    await expect(page.locator("#history-opened")).not.toHaveText("");
    expect(page.url()).toBe(before);
    expect(opened).toBe(0);
  });

  test("stands out: foreground colour, body-small size, a state-colour edge and a tint", async ({ page }) => {
    await page.goto(CARD);
    const row = rows(page).first();

    const style = await row.evaluate((el) => {
      const text = el.querySelector(".status-text")!;
      const probe = document.createElement("span");
      probe.style.color = "var(--fg)";
      document.body.append(probe);
      const fg = getComputedStyle(probe).color;
      probe.remove();
      const own = getComputedStyle(el);
      return {
        color: getComputedStyle(text).color,
        fg,
        background: own.backgroundColor,
        fontSize: parseFloat(own.fontSize),
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
        edge: own.borderLeftWidth,
        edgeColor: own.borderLeftColor,
        lineColor: own.borderTopColor,
      };
    });

    expect(style.color).toBe(style.fg);
    expect(style.fontSize).toBeCloseTo(style.root * 0.75, 1);
    expect(style.edge).toBe("2px");
    expect(style.edgeColor).not.toBe(style.lineColor);
    expect(await contrastBetween(page, style.color, style.background)).toBeGreaterThanOrEqual(7);
  });

  test("an agent with no line says 未設定 at the same strength", async ({ page }) => {
    await page.goto("/e2e/harness/index.html?view=lobby&role=operator&statusLine=unset");

    await expect(rows(page).first()).toHaveText("未設定");
  });
});

test.describe("a hostile status line in the member detail view (issue 514)", () => {
  const panel = (page: Page) => page.locator(".status-scroll .status-line-panel");

  test("draws the head with real http(s) links only and loads nothing", async ({ page }) => {
    const requested = await watchRequests(page);
    await page.goto(DETAIL);
    await expect(panel(page)).toBeVisible();

    await expect(panel(page).locator(".body strong").first()).toHaveText("bold");
    const links = await panel(page).locator("a").evaluateAll((nodes) =>
      nodes.map((node) => ({
        href: node.getAttribute("href"),
        rel: node.getAttribute("rel"),
        target: node.getAttribute("target"),
      })),
    );
    expect(links.map((l) => l.href)).toEqual(["https://example.test/ok", "https://evil.test/pixel.png"]);
    for (const link of links) {
      expect(link.rel).toBe("noopener noreferrer nofollow");
      expect(link.target).toBe("_blank");
    }
    await expect(panel(page).locator("img, script, iframe, svg, style, form, input")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(await pwned(page)).toBeUndefined();
    expect(requested.filter((url) => url.includes("evil.test"))).toEqual([]);
  });

  test("says the head was cut and opens the change log for the agent", async ({ page }) => {
    await page.goto(DETAIL);

    await expect(panel(page).locator(".more")).toHaveText("…続きあり (4.0 KB)");
    await panel(page).getByRole("button", { name: "続きを読む" }).click();

    await expect(page.locator("#history-opened")).not.toHaveText("");
  });

  test("keeps headings at body size and lets a table scroll inside the panel", async ({ page }) => {
    await page.goto(DETAIL);

    const measured = await panel(page).evaluate((el) => {
      const h1 = el.querySelector(".body h1")!;
      const table = el.querySelector(".body table")!;
      return {
        heading: parseFloat(getComputedStyle(h1).fontSize),
        body: parseFloat(getComputedStyle(el).fontSize),
        tableOverflow: getComputedStyle(table).overflowX,
        tableDisplay: getComputedStyle(table).display,
      };
    });

    expect(measured.heading).toBeLessThanOrEqual(measured.body * 1.25);
    expect(measured.tableOverflow).toBe("auto");
    expect(measured.tableDisplay).toBe("block");
  });

  test("an agent with no line says 未設定; a hidden line draws no panel", async ({ page }) => {
    await page.goto("/e2e/harness/index.html?view=detail&statusLine=unset");
    await expect(panel(page).locator(".unset")).toHaveText("未設定");

    await page.goto("/e2e/harness/index.html?view=detail");
    await expect(page.locator(".status-scroll")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  });
});
