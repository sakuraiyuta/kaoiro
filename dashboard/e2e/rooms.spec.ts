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

test("a large room's chips remain reachable on desktop and scroll on mobile", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto("/e2e/harness/index.html?view=app&live=90&rooms=1");
  await page.getByRole("button", { name: "live 0 の詳細を開く", exact: true }).click();
  const strip = page.locator(".agent-strip");
  const group = strip.locator(".strip-group").first();
  const chips = group.locator(".chip");
  if (await group.locator(".room-toggle").getAttribute("aria-expanded") === "false") await group.locator(".room-toggle").click();
  await expect(chips).toHaveCount(30);
  for (const chip of [chips.first(), chips.last()]) {
    const box = await chip.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    await chip.click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const scroll = await strip.evaluate((element) => {
    const before = element.scrollLeft;
    element.scrollLeft = element.scrollWidth;
    return { before, after: element.scrollLeft, width: element.clientWidth, content: element.scrollWidth };
  });
  expect(scroll.content).toBeGreaterThan(scroll.width);
  expect(scroll.after).toBeGreaterThan(scroll.before);
});

const stripGroup = (page: Page, key: string) => page.locator(`[data-strip-key="${key}"]`);
async function openStrip(page: Page, scenario = "", live = 6): Promise<void> {
  await page.goto(`/e2e/harness/index.html?view=app&rooms=1&live=${live}&stripScenario=${scenario}`);
  await page.locator(".live-dashboard .agents article").first().click();
  await expect(page.locator(".agent-strip")).toBeVisible();
}
async function toggleTrace(page: Page, key: string) {
  return page.evaluate(async (key) => {
    const group = document.querySelector<HTMLElement>(`[data-strip-key="${key}"]`)!;
    const rows: { group: number; header: number; clip: string }[] = [];
    group.querySelector<HTMLButtonElement>(".room-toggle")!.click();
    const start = performance.now();
    await new Promise<void>((resolve) => {
      function sample() {
        rows.push({ group: group.getBoundingClientRect().height,
          header: document.querySelector("header")!.getBoundingClientRect().height,
          clip: getComputedStyle(group.querySelector(".strip-reveal")!).clipPath });
        if (performance.now() - start < 260) requestAnimationFrame(sample); else resolve();
      }
      requestAnimationFrame(sample);
    });
    return rows;
  }, key);
}
for (const width of [1280, 940, 939, 390, 844]) {
  test(`room disclosures retain layout and reachable chips at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openStrip(page, "", width === 844 ? 6 : 90);
    const group = stripGroup(page, "room:r-review");
    const folder = group.locator(".room-toggle");
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    const closed = await group.locator(".strip-row").boundingBox();
    const button = await folder.boundingBox();
    expect(button!.width).toBeGreaterThanOrEqual(48);
    expect(closed!.width).toBeCloseTo(button!.width, 1);
    const count = await group.locator(".strip-count").boundingBox();
    const lamp = await group.locator(".state-lamp").boundingBox();
    expect(count!.y).toBeGreaterThan(lamp!.y + lamp!.height);
    expect(count!.x).toBeGreaterThanOrEqual(button!.x);
    expect(count!.x + count!.width).toBeLessThanOrEqual(button!.x + button!.width);
    await folder.click();
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    const chips = group.locator(".chip");
    for (const chip of [chips.first(), chips.last()]) await chip.click();
    const first = await chips.first().boundingBox();
    const last = await chips.last().boundingBox();
    if (width > 939) expect(last!.y).toBeGreaterThan(first!.y);
    else if (width !== 844) {
      expect(last!.y).toBeCloseTo(first!.y, 1);
      expect(await page.locator(".agent-strip").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    }
    await folder.click();
    await expect(group.locator(".strip-reveal")).toBeHidden();
    expect(await group.locator(".strip-row").evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(button!.width, 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator("button.settings-toggle")).toBeInViewport();
    await expect(page.locator("button.back")).toBeInViewport();
  });
}

test("wrapped room motion has no intermediate height spike and reverses safely", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openStrip(page, "", 90);
  const group = stripGroup(page, "room:r-review");
  const opening = await toggleTrace(page, "room:r-review");
  const expanded = opening.at(-1)!;
  expect(Math.max(...opening.map((row) => row.group))).toBeLessThanOrEqual(expanded.group + 1);
  expect(Math.max(...opening.map((row) => row.header))).toBeLessThanOrEqual(expanded.header + 1);
  expect(new Set(opening.map((row) => row.clip)).size).toBeGreaterThan(1);
  expect(await group.locator(".strip-reveal").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0.18s");
  const closing = await toggleTrace(page, "room:r-review");
  expect(Math.max(...closing.map((row) => row.group))).toBeLessThanOrEqual(expanded.group + 1);
  expect(Math.max(...closing.map((row) => row.header))).toBeLessThanOrEqual(expanded.header + 1);
  await expect(group.locator(".strip-reveal")).toBeHidden();
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-strip-key="room:r-review"] .room-toggle')!;
    button.click(); queueMicrotask(() => button.click());
  });
  await expect(group.locator(".strip-reveal")).toBeHidden();
  await group.locator(".room-toggle").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(group.locator(".strip-reveal")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await group.locator(".room-toggle").click();
  await expect(group.locator(".strip-reveal")).toBeHidden();
  expect(await group.locator(".strip-reveal").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
});

test("native disclosure keys, hidden focus and waiting-question color work in English", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("kaoiro:settings:v1", JSON.stringify({ locale: "en" })));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openStrip(page, "lamp");
  const group = stripGroup(page, "room:r-review");
  const button = group.locator(".room-toggle");
  await expect(button).toHaveAccessibleName("Expand room Review, 2 agents, waiting for an answer");
  await expect(group.locator(".strip-count")).toHaveText("2");
  const colors = await group.locator(".state-lamp").evaluate((el) => {
    const expected = document.createElement("span");
    expected.style.background = "var(--c-waiting_question)"; document.body.append(expected);
    const result = { actual: getComputedStyle(el).backgroundColor, expected: getComputedStyle(expected).backgroundColor };
    expected.remove(); return result;
  });
  expect(colors.actual).toBe(colors.expected);
  await button.focus(); await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const chip = group.locator(".chip").first();
  await chip.evaluate((el: HTMLButtonElement) => el.focus());
  await expect(button).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await group.locator(".strip-reveal").evaluate((el) => el.contains(document.activeElement))).toBe(false);
});

test("lone lobby stays open and unknown still has its own disclosure", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openStrip(page, "lobby");
  await expect(page.locator(".room-toggle")).toHaveCount(0);
  await expect(page.locator(".strip-reveal")).toBeVisible();
  await openStrip(page, "unknown");
  await expect(stripGroup(page, "unknown").locator(".room-toggle")).toHaveAttribute("aria-expanded", "true");
});

test("moving a focused last chip restores focus to the closed destination folder", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openStrip(page, "", 3);
  await stripGroup(page, "room:r-review").locator(".room-toggle").click();
  await stripGroup(page, "room:r-review").locator(".chip").focus();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("e2e:room-snapshot", { detail: {
    rooms: [{ id: "lobby", name: null }, { id: "r-review", name: "Review" }, { id: "r-long", name: "Destination" }],
    memberships: { "e2e-host.live-0": "lobby", "e2e-host.live-1": "r-long", "e2e-host.live-2": "r-long" },
  } })));
  await expect(stripGroup(page, "room:r-review")).toHaveCount(0);
  await expect(stripGroup(page, "room:r-long").locator(".room-toggle")).toBeFocused();
  await stripGroup(page, "room:r-long").locator(".room-toggle").click();
  await stripGroup(page, "room:r-long").locator(".chip").first().focus();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("e2e:room-snapshot", { detail: {
    rooms: [{ id: "lobby", name: null }, { id: "r-long", name: "Destination" }],
    memberships: { "e2e-host.live-0": "lobby", "e2e-host.live-2": "r-long" }, snapshot_incomplete: true,
  } })));
  await expect(stripGroup(page, "unknown").locator(".room-toggle")).toBeFocused();
});
