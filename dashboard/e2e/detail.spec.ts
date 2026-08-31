// T4-T8 (phase-31 31-10): AgentDetail status sheet, scroll ownership, and
// pending-decision reachability across the ADR-0052 breakpoints.
import { expect, test, type Locator, type Page } from "@playwright/test";

const DETAIL = "/e2e/harness/index.html?view=detail";

// T11 (issue #180 follow-up) 幾何回帰の共通ヘルパー。

/** Web Animations API でアニメーションを 0ms (真上、最も高く伸びる点) へ
 *  固定する — ランダムな再生位置での flaky を避ける。 */
async function freezeRingAtApex(ring: Locator): Promise<void> {
  await ring.evaluate((el) => {
    const anim = (el as HTMLElement).getAnimations()[0];
    anim.pause();
    anim.currentTime = 0;
  });
}

/** リングの最遠点(真上)が box-shadow の 6px ブラー込みで .bar(「グリッド
 *  へ戻る」ボタン行)に重ならないことを確認する。呼び出し前に
 *  freezeRingAtApex 済みであること。 */
async function expectRingClearsBar(page: Page, ring: Locator): Promise<void> {
  const ringBox = (await ring.boundingBox())!;
  const barBox = (await page.locator(".bar").boundingBox())!;
  const GLOW_BLEED_PX = 6; // box-shadow: 0 0 6px var(--fg)
  expect(ringBox.y - GLOW_BLEED_PX).toBeGreaterThanOrEqual(
    barBox.y + barBox.height,
  );
}

test.describe("T4: detail status — sidebar ⇔ sheet at 1199/1198", () => {
  test("1199px: status renders as the left sidebar, no handle", async ({ page }) => {
    await page.setViewportSize({ width: 1199, height: 900 });
    await page.goto(DETAIL);
    await expect(page.locator("aside.status")).toBeVisible();
    await expect(page.locator(".sheet .handle .toggle")).toBeHidden();
  });

  for (const width of [1198, 844]) {
    test(`${width}px: status sheets behind the handle`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(DETAIL);
      await expect(page.locator("aside.status")).toBeHidden();
      const toggle = page.locator(".sheet .handle .toggle");
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(page.locator("aside.status")).toBeVisible();
    });
  }
});

test("T5: open sheet — background frozen, sheet content owns the scroll", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 500 });
  await page.goto(DETAIL);
  const log = page.locator(".log");
  await expect(log).toBeVisible();
  await page.locator(".sheet .handle .toggle").click();
  const status = page.locator("aside.status");
  await expect(status).toBeVisible();
  // 背景 (page main) は overflow:hidden で固定される (body.sheet-open).
  await expect(page.locator("main.harness-main")).toHaveCSS(
    "overflow-y",
    "hidden",
  );
  const logTopBefore = await log.evaluate((el) => el.scrollTop);
  // Wheel over the sheet: at sheet sizes .status itself is the single
  // scroll owner (the identity header scrolls with the content).
  const box = (await status.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  // mouse.wheel does not wait for the scroll to land — poll (クロエ M2).
  await expect
    .poll(() => status.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  expect(await log.evaluate((el) => el.scrollTop)).toBe(logTopBefore);
});

// クロエ M1 regression: the sheet must keep the status controls reachable
// on LANDSCAPE phones, where the 60% panel is at its shallowest. A single
// height band cannot catch this class of defect — pin the two worst real
// devices (844x390 iPhone landscape, 740x360 compact Android landscape).
for (const [width, height] of [
  [844, 390],
  [740, 360],
] as const) {
  test(`M1 regression: status stays reachable at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(DETAIL);
    await page.locator(".sheet .handle .toggle").click();
    const status = page.locator("aside.status");
    await expect(status).toBeVisible();
    // The scroll owner must retain a usable viewport of its own…
    const clientHeight = await status.evaluate((el) => el.clientHeight);
    expect(clientHeight).toBeGreaterThanOrEqual(80);
    // …and scrolling to the end must expose the pane-bottom controls.
    await status.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const action = page.locator(".terminate");
    await expect(action).toBeVisible();
    const box = (await action.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
  });
}

for (const [taskId, pending, dockSelector] of [
  ["T6", "permission", ".permission-dock"],
  ["T7", "question", ".question-dock"],
] as const) {
  test.describe(`${taskId}: ${pending} arrival stays reachable`, () => {
    test("sheet closed: the in-flow dock is directly visible", async ({ page }) => {
      await page.setViewportSize({ width: 844, height: 900 });
      await page.goto(`${DETAIL}&pending=${pending}`);
      await expect(page.locator(dockSelector)).toBeVisible();
    });

    test("sheet open: handle lamp announces it; closing reaches the dock", async ({ page }) => {
      await page.setViewportSize({ width: 844, height: 900 });
      await page.goto(`${DETAIL}&pending=${pending}`);
      const toggle = page.locator(".sheet .handle .toggle");
      await toggle.click();
      await expect(page.locator(".sheet .handle .pending-lamp")).toBeVisible();
      await toggle.click();
      await expect(page.locator(dockSelector)).toBeVisible();
    });
  });
}

// T11 (issue #180 follow-up, 2026-08-10, ふじ round1 S1): 頭上リングが
// 実ブラウザで AgentDetail 側にも描画・アニメーションされることを、
// LobbyHarness が AgentCard 側で既にやっている taskRing パターンの
// 対で固定する。App.svelte の配線 (activeTaskCountForDetail) までは
// 通さない (このハーネスは AgentDetail を直接 mount する) —
// activeTaskCountForDetail() 自体の guard semantics は protocol.test.ts
// の単体テストが担当、App.svelte 側の一行配線は型付き直結のみで分岐・
// 変換を持たないため静的レビューで確認する (ふじ round2, 2026-08-10:
// 追加投資不要と判断)。
test.describe("T11: 頭上リング (AgentDetail, issue #180 follow-up)", () => {
  test("1199px desktop sidebar: taskRing=1 で .task-ring が描画・回転する", async ({ page }) => {
    await page.setViewportSize({ width: 1199, height: 900 });
    await page.goto(`${DETAIL}&taskRing=1`);
    const ring = page.locator("aside.status .portrait .task-ring");
    await expect(ring).toBeVisible();
    await expect(ring).toHaveAttribute("role", "img");
    const animationName = await ring.evaluate(
      (el) => getComputedStyle(el).animationName,
    );
    expect(animationName).not.toBe("none");
  });

  test("1199px desktop sidebar: taskRing 省略時は .task-ring を描画しない", async ({ page }) => {
    await page.setViewportSize({ width: 1199, height: 900 });
    await page.goto(DETAIL);
    await expect(page.locator("aside.status .portrait .task-ring")).toHaveCount(0);
  });

  // M1 regression (マスター実機確認, 2026-08-10): 広いデスクトップでは
  // `.status` の flex 比率で `.portrait` が 8rem を大きく超え、cqw だけの
  // 軌道半径だと肥大して .bar(「グリッドへ戻る」ボタン)まで到達して
  // いた。実際の要求は「.bar に重ならない、.portrait/顔への多少のはみ出し
  // は許容」(マスター 2026-08-10) なので、.portrait の枠そのものではなく
  // .bar との重なりを基準にする。min(cqw, AgentCard絶対値) キャップ +
  // topOffset(頭上退避のアンカーを AgentCard 用の -2% より下げる)の
  // 実効性を、アニメーションを最遠点(0%/100% キーフレーム = 真上)で
  // 静止させて幾何的に固定する。box-shadow の 6px ブラーぶんの安全マージン
  // を含める。
  //
  // sprite/face 両分岐を検証する(round2, workflow-review QUALITY 指摘,
  // 2026-08-10): DetailHarness は元々 manifest=null 固定で face-orbit
  // (小さい方の半径)しか通らず、マスターが実際に見た報告(あお = sprite
  // 解決済みペルソナ)側の、より大きく・はみ出しやすい sprite-orbit 半径
  // が未検証だった。
  for (const [label, query, expectFaceOrbit] of [
    ["face fallback", "", true],
    ["sprite", "&sprite=1", false],
  ] as const) {
    test(`1600px 幅広デスクトップ (${label}): 最遠点でも .bar(戻るボタン)に重ならない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`${DETAIL}&taskRing=1${query}`);
      const ring = page.locator("aside.status .portrait .task-ring");
      await expect(ring).toBeVisible();
      await expect(ring).toHaveClass(
        expectFaceOrbit ? /face-orbit/ : /^(?!.*face-orbit).*$/,
      );
      await freezeRingAtApex(ring);
      await expectRingClearsBar(page, ring);
    });

    // クロエ round2 指摘 (2026-08-10): 狭幅(.portrait が max-width: 8rem
    // でキャップされる BottomSheet モード)側は topOffset の絶対寄与
    // (6% × portrait 高さ)が小さく、orbitRy は同じ絶対値(0.72rem)の
    // ままなので理論上ワースト側になりうる — 「広い方で安全だから狭い方
    // も比例して安全」と実測せず結論しないこと(クロエ自身、cqw の上限
    // を実測せず「比例するから大丈夫」と判断したのが今回の不具合の
    // 原因、という自己指摘あり)。実測すると .bar はページ最上部に固定、
    // .portrait は BottomSheet として画面下部にオーバーレイされるため
    // 空間的に大きく離れており(実測で 300px 超のマージン)、このレイ
    // アウトでは 8rem キャップと .bar 隣接が同時には起こらない(8rem
    // キャップは常に BottomSheet モード側でのみ有効 — T4 の
    // sidebar/sheet 切替と同じ条件分岐)。それでも「たぶん大丈夫」で
    // 終わらせず、1600px と同じ幾何チェックを固定する。
    test(`844px sheet open (${label}): 最遠点でも .bar(戻るボタン)に重ならない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 844, height: 900 });
      await page.goto(`${DETAIL}&taskRing=1${query}`);
      await page.locator(".sheet .handle .toggle").click();
      const ring = page.locator("aside.status .portrait .task-ring");
      await expect(ring).toBeVisible();
      await expect(ring).toHaveClass(
        expectFaceOrbit ? /face-orbit/ : /^(?!.*face-orbit).*$/,
      );
      await freezeRingAtApex(ring);
      await expectRingClearsBar(page, ring);
    });
  }
});

// T12 (issue #231): compare the rendered apex against the pre-fix anchor in
// the same layout, so the assertion measures pixels rather than CSS strings.
test.describe("T12: 頭上リングの apex 移動 (AgentDetail, issue #231)", () => {
  for (const [label, query] of [
    ["face fallback", ""],
    ["sprite", "&sprite=1"],
  ] as const) {
    test(`1920x1080 ${label}: apex が旧位置から 8px 下がる`, async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(`${DETAIL}&taskRing=1${query}`);
      const ring = page.locator("aside.status .portrait .task-ring");
      await expect(ring).toBeVisible();
      await freezeRingAtApex(ring);

      const afterBox = (await ring.boundingBox())!;
      const oldAnchor = await page.addStyleTag({
        content: ".task-ring { top: 6% !important; }",
      });
      const beforeBox = (await ring.boundingBox())!;
      await oldAnchor.evaluate((el) => el.remove());

      const apexDrop = afterBox.y - beforeBox.y;
      expect(apexDrop).toBeGreaterThan(7);
      expect(apexDrop).toBeLessThan(9);
    });
  }

  test("dev の taskRingOffset が 1920x1080 の実測 apex に反映される", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`${DETAIL}&taskRing=1&sprite=1&taskRingOffset=14`);
    const portrait = page.locator("aside.status .portrait");
    const ring = portrait.locator(".task-ring");
    await expect(ring).toBeVisible();
    await freezeRingAtApex(ring);

    const portraitBox = (await portrait.boundingBox())!;
    const topPx = await ring.evaluate((el) =>
      parseFloat(getComputedStyle(el).top),
    );
    const expectedTop = portraitBox.height * 0.06 + 14;
    expect(Math.abs(topPx - expectedTop)).toBeLessThan(1);
  });
});

test("T8: handle attention badge returns to the grid while the sheet is open", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 900 });
  await page.goto(`${DETAIL}&attention=1`);
  // Closed sheet: the ordinary blindspot button carries the affordance.
  await expect(page.locator("button.blindspot")).toBeVisible();
  await page.locator(".sheet .handle .toggle").click();
  const badge = page.locator(".sheet .handle .attention");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("1 体");
  await badge.click();
  // onClose fired — same operation as button.blindspot (ADR-0052 F3).
  await expect(page.getByTestId("closed-marker")).toBeVisible();
});
