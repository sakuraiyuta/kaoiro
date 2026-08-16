// issue #237: ResponseTimeline クリックで AgentDetail へジャンプした際、
// クリックしたメッセージが常に GAP(TIMELINE_SCROLL_TOP_GAP_PX)ぶんの
// 余白込みで正確に着地することを固定する。
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
 *  across two consecutive checks), then return the target row's gap from
 *  the `.log` top edge in px. Looks the row up by its `seq` (embedded in
 *  `data-envelope-key`) rather than by array index — once #184's window
 *  expands, `visibleLogs` no longer starts at absolute index 0, so a
 *  plain `.transcript-entry` array index would silently point at a
 *  DIFFERENT row than the one actually clicked. */
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
    const target = logEl.querySelector<HTMLElement>(
      `[data-envelope-key*="|${targetSeq}|log|"]`,
    );
    if (!target) throw new Error(`target row seq=${targetSeq} not rendered`);
    return target.getBoundingClientRect().top - logEl.getBoundingClientRect().top;
  }, seq);
}

test.describe("issue #237: timeline jump lands at the GAP offset for deep history", () => {
  test("同一 agent を表示中に別行(window 外)をクリックする経路", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(
      `${DETAIL}&scrollTarget=${TARGET_INDEX}&scrollDelay=500&logCount=${LOG_COUNT}`,
    );
    await expect(page.locator(".log")).toBeVisible();
    // scrollDelay(500ms)経過後にジャンプが発火する。
    await page.waitForTimeout(600);
    const gapPx = await waitForSettledGap(page, TARGET_SEQ);
    expect(Math.abs(gapPx - GAP)).toBeLessThan(2);
    // #184: 対象を含むよう window が拡張されたままであること(巻き戻って
    // いない)も併せて固定する。
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
