// issue #237/#260: ResponseTimeline クリックで AgentDetail へジャンプした
// 際、クリックしたメッセージ本文が常に GAP(TIMELINE_SCROLL_TOP_GAP_PX)
// ぶんの余白込みで正確に着地することを固定する。
//
// window(#184, LOG_WINDOW_SIZE=200)を超える深い過去のメッセージへ飛ぶ
// 経路(ensureIndexVisible による window 拡張)でのみ再現する不具合
// だった: 拡張は現在の描画位置より前に行を挿入するため、ブラウザ既定の
// CSS scroll anchoring が「直前まで見えていた行を同じ位置に保つ」目的で
// scrollTop を新しいコンテンツの末尾へ移動させる。操作者はジャンプ直前
// まで末尾に張り付いていることが多く、この anchoring 後の位置もたまたま
// 末尾(distance<=STICK_THRESHOLD_PX)に一致する。handleLogScroll はこれを
// 「操作者が自力で末尾へ戻った」と誤認し、ジャンプ用に広げたばかりの
// window を tail 側へ即座に巻き戻す — ジャンプ本体の smooth scroll が
// 動き出す前に対象行が DOM から消える。
//
// jsdom は CSS scroll anchoring も実レイアウトも実装しないため、この
// 経路は jsdom では再現できない(dashboard/test/logWindow.integration.
// test.ts の window 拡張テストは幾何を手動 mock しており、anchoring の
// 有無を問わない)。実 Chromium 上でのみ検証できる。
import { expect, test } from "@playwright/test";

const DETAIL = "/e2e/harness/index.html?view=detail";
const GAP = 24; // AgentDetail.svelte TIMELINE_SCROLL_TOP_GAP_PX
const LOG_COUNT = 300; // #184 の LOG_WINDOW_SIZE(200)を超え、window 拡張を要求する
const TARGET_INDEX = 10; // 既定 window(末尾 200 件)の外側
const TARGET_SEQ = TARGET_INDEX + 1; // makeLogs()/detailLogs() の seq = index + 1

async function readScrollTop(
  page: import("@playwright/test").Page,
): Promise<number | null> {
  return page.evaluate(() => {
    const logEl = document.querySelector(".log") as HTMLElement | null;
    return logEl?.scrollTop ?? null;
  });
}

/** Wait for the smooth-scroll animation to settle (scrollTop unchanged
 *  across two consecutive checks), then return the target message body's gap
 *  from the `.log` top edge in px. Looks the envelope row up by its `seq`
 *  (embedded in `data-envelope-key`) and then measures its actual `.msg`
 *  body. Once #184's window expands, `visibleLogs` no longer starts at
 *  absolute index 0, and that first wrapper includes a date divider;
 *  measuring the wrapper would silently accept a landing one divider short
 *  of the selected message. */
async function waitForSettledGap(
  page: import("@playwright/test").Page,
  seq: number,
): Promise<number> {
  let prev = await readScrollTop(page);
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(100);
    const cur = await readScrollTop(page);
    if (cur === prev) break;
    prev = cur;
    if (i === 49) throw new Error("scrollTop did not settle within timeout");
  }
  return page.evaluate((targetSeq) => {
    const logEl = document.querySelector(".log") as HTMLElement;
    const envelope = logEl.querySelector<HTMLElement>(
      `[data-envelope-key*="|${targetSeq}|log|"]`,
    );
    const target = envelope?.querySelector<HTMLElement>(".msg");
    if (!target) throw new Error(`target message seq=${targetSeq} not rendered`);
    return target.getBoundingClientRect().top - logEl.getBoundingClientRect().top;
  }, seq);
}

async function installTransformAtScrollProbe(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.addInitScript(() => {
    const nativeScrollTo = HTMLElement.prototype.scrollTo;
    const transforms: string[] = [];
    HTMLElement.prototype.scrollTo = function (...args: Parameters<HTMLElement["scrollTo"]>) {
      if (this.classList.contains("log")) {
        const detail = document.querySelector<HTMLElement>(".detail");
        transforms.push(detail ? getComputedStyle(detail).transform : "missing-detail");
      }
      return nativeScrollTo.apply(this, args);
    };
    Object.defineProperty(window, "__timelineTransformsAtScroll", {
      value: transforms,
      configurable: true,
    });
  });
}

async function transformsAtScroll(
  page: import("@playwright/test").Page,
): Promise<string[]> {
  return page.evaluate(() =>
    (window as Window & { __timelineTransformsAtScroll?: string[] })
      .__timelineTransformsAtScroll ?? [],
  );
}

test.describe("issue #260: timeline jump lands at the message-body GAP", () => {
  test("後付け mount 中の scale でも深い target を本文 GAP へ着地させる", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await installTransformAtScrollProbe(page);
    const deepTargetIndex = 150;
    await page.goto(
      `${DETAIL}&scrollTarget=${deepTargetIndex}&mountDelay=50&expandOrigin=1&logCount=${LOG_COUNT}`,
    );
    await expect(page.locator(".log")).toBeVisible();
    const gapPx = await waitForSettledGap(page, deepTargetIndex + 1);
    expect(Math.abs(gapPx - GAP)).toBeLessThan(2);
    // This is deliberately an active expandFrom transition. A transformed
    // rect mixed with an unscaled scrollTop drifts proportionally here.
    expect((await transformsAtScroll(page)).some((value) => value !== "none")).toBe(true);
  });

  test("window 外 target は origin=null のまま divider でなく本文へ着地する", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await installTransformAtScrollProbe(page);
    await page.goto(
      `${DETAIL}&scrollTarget=${TARGET_INDEX}&mountDelay=50&logCount=${LOG_COUNT}`,
    );
    await expect(page.locator(".log")).toBeVisible();
    const gapPx = await waitForSettledGap(page, TARGET_SEQ);
    expect(Math.abs(gapPx - GAP)).toBeLessThan(2);
    // Timeline has no tile origin. It must not begin the scale intro while its
    // pending target is measured; a 0ms transition with scale CSS is not enough.
    expect(await transformsAtScroll(page)).toEqual(["none"]);
    const entryCount = await page.evaluate(
      () => document.querySelectorAll(".transcript-entry").length,
    );
    expect(entryCount).toBe(LOG_COUNT - TARGET_INDEX);
  });

  // agent 切替と同時にジャンプする経路(App.svelte onSelectAgent の実運用
  // 経路)。この構成では切替前 agent の残存 scrollTop が新 window の末尾と
  // 一致しないため anchoring の distance<=STICK_THRESHOLD_PX 誤検知
  // そのものは踏まないが(直接 fail 側で確認済み: この harness 構成では
  // 修正前後どちらでも pass する)、switching=true 経路自体の着地精度を
  // 押さえておく回帰テストとして残す。
  test("別 agent の timeline 行クリックで切替と同時にジャンプする経路 (App.svelte onSelectAgent)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(
      `${DETAIL}&agentSwitchTarget=${TARGET_INDEX}&logCount=${LOG_COUNT}`,
    );
    await expect(page.locator(".log")).toBeVisible();
    // ハーネスは 500ms 後に agent 切替 + scrollToEntryKey を同時に発火する。
    await page.waitForTimeout(600);
    const gapPx = await waitForSettledGap(page, TARGET_SEQ);
    expect(Math.abs(gapPx - GAP)).toBeLessThan(2);
    const entryCount = await page.evaluate(
      () => document.querySelectorAll(".transcript-entry").length,
    );
    expect(entryCount).toBe(LOG_COUNT - TARGET_INDEX);
  });
});
