import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { deliveryLoopback, deliveryView } from "../test/deliveryPolicyLoopback";
let loop: Awaited<ReturnType<typeof deliveryLoopback>>;
test.beforeEach(async () => { loop = await deliveryLoopback(resolve("../server/priv/static")); });
test.afterEach(async ({ page }) => { await page.close(); await loop.close(); });
for (const [width, height] of [[1440, 1000], [844, 900], [390, 844]]) {
  test(`built App policy controls remain readable and focusable at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height }); await page.goto(loop.url);
    await page.locator('button[aria-label$="の詳細を開く"]').first().dispatchEvent("click");
    if (width < 1199) await page.locator(".sheet .handle .toggle").click();
    const control = page.getByRole("region", { name: "実行中の割込配送" });
    await expect(control).toContainText("on（確認済み）");
    await expect(control).toContainText("あなたから: none / エージェント間: steer");
    const checkbox = control.getByRole("checkbox", { name: "割込配送を許可する" });
    await checkbox.scrollIntoViewIfNeeded(); await checkbox.focus(); await expect(checkbox).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`delivery-${width}.png`) });
    await checkbox.uncheck(); await expect(control.getByRole("status")).toContainText("wrapper 確認待ち");
    expect(loop.frames.filter(f => f[3] === "set_delivery_policy")).toHaveLength(1);
    const box = await checkbox.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    loop.state.policy = { ...deliveryView, revision: 3, applied_revision: 3, mechanisms: { operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" } };
    loop.send("delivery_policy_changed", { version: "0", agent_id: "host.p", delivery_policy: loop.state.policy });
    await expect(control).toContainText("非対応・通常配送のみ"); await expect(checkbox).toBeDisabled();
  });
}
test("production App clears the marker and open launch dialog on viewer rejoin", async ({ page }) => {
  await page.goto(loop.url); await page.getByRole("button", { name: "+ 起動" }).click();
  const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "実行中の割込配送" })).toBeEnabled();
  loop.state.operator = false; loop.state.marker = false; loop.send("phx_error", {});
  await expect(dialog).toBeHidden();
  await page.locator('button[aria-label$="の詳細を開く"]').first().dispatchEvent("click");
  await expect(page.getByRole("region", { name: "実行中の割込配送" })).toContainText("この server の操作 API は未確認");
  await expect(page.getByRole("checkbox", { name: "割込配送を許可する" })).toHaveCount(0);
  expect(loop.frames.filter(f => ["set_delivery_policy", "spawn"].includes(f[3] as string))).toHaveLength(0);
});
test("built launch sends the displayed default, retains a manual choice, and omits unknown metadata", async ({ page }) => {
  await page.goto(loop.url); await page.getByRole("button", { name: "+ 起動" }).click();
  const checkbox = page.getByRole("checkbox", { name: "実行中の割込配送" });
  await expect(checkbox).not.toBeChecked(); await checkbox.check();
  loop.send("hosts", { version: "0", hosts: loop.state.hosts }); await expect(checkbox).toBeChecked();
  await page.getByRole("dialog").getByRole("button", { name: "起動", exact: true }).click();
  await expect.poll(() => loop.frames.filter(f => f[3] === "spawn").length).toBe(1);
  expect(loop.frames.find(f => f[3] === "spawn")![4]).toMatchObject({ delivery_policy: "on" });
  loop.send("hosts", { version: "0", hosts: { host: { ...loop.state.hosts.host, engines: [{ id: "codex", models: [] }] } } });
  await page.getByRole("button", { name: "+ 起動" }).click(); await expect(checkbox).toBeDisabled();
  await expect(page.getByRole("dialog")).toContainText("起動時の配送方法は未確認");
  await page.getByRole("dialog").getByRole("button", { name: "起動", exact: true }).click();
  await expect.poll(() => loop.frames.filter(f => f[3] === "spawn").length).toBe(2);
  expect(loop.frames.filter(f => f[3] === "spawn")[1]![4]).not.toHaveProperty("delivery_policy");
});

test("default App fresh read repairs an unknown view without a write; reconnect retains off", async ({ page }) => {
  loop.state.policy = { ...deliveryView, policy: "unknown", confirmed: false };
  loop.state.automatic = false;
  await page.goto(loop.url);
  await page.locator('button[aria-label$="の詳細を開く"]').first().dispatchEvent("click");
  await expect.poll(() => loop.frames.filter(f => f[3] === "get_delivery_policy").length).toBe(1);
  const read = loop.frames.find(f => f[3] === "get_delivery_policy")!;
  loop.state.policy = { ...deliveryView, policy: "off" };
  loop.reply(read, { agent_id: "host.p", delivery_policy: loop.state.policy });
  await expect(page.getByRole("region", { name: "実行中の割込配送" })).toContainText("off（新しい割込配送を停止）");
  await page.reload();
  await page.locator('button[aria-label$="の詳細を開く"]').first().dispatchEvent("click");
  await expect(page.getByRole("region", { name: "実行中の割込配送" })).toContainText("保存設定: off");
  expect(loop.frames.filter(f => ["set_delivery_policy", "spawn"].includes(f[3] as string))).toHaveLength(0);
});

test("launch target resets choice, model does not, and persona override disables only delivery", async ({ page }) => {
  const original = loop.state.hosts.host;
  const none = { operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" };
  const host = { ...original, personas: [...original.personas, { id: "q", name: "Other", sprite_set: "q" }],
    engines: [{ ...original.engines[0], launch_delivery_policy: { ...original.engines[0]!.launch_delivery_policy,
      persona_overrides: { q: none } } }] };
  loop.state.hosts = { host, second: host } as typeof loop.state.hosts;
  await page.goto(loop.url); await page.getByRole("button", { name: "+ 起動" }).click();
  const dialog = page.getByRole("dialog"); const checkbox = dialog.getByRole("checkbox", { name: "実行中の割込配送" });
  await checkbox.check(); await dialog.getByLabel(/^モデル/).selectOption("sample");
  await expect(checkbox).toBeChecked();
  await dialog.getByLabel(/^ペルソナ/).selectOption("q"); await expect(checkbox).toBeDisabled();
  await dialog.getByLabel(/^ペルソナ/).selectOption("p"); await expect(checkbox).toBeEnabled();
  await expect(checkbox).toBeChecked();
  await dialog.getByLabel(/^ホスト/).selectOption("second"); await expect(checkbox).not.toBeChecked();
  await dialog.getByRole("button", { name: "起動", exact: true }).click();
  await expect.poll(() => loop.frames.filter(f => f[3] === "spawn").length).toBe(1);
  expect(loop.frames.find(f => f[3] === "spawn")![4]).toMatchObject({ host_id: "second", delivery_policy: "off" });
});

for (const scenario of ["on", "omitted", "malformed", "ceiling", "none", "invalid", "antigravity"]) {
  test(`launch default and disablement: ${scenario}`, async ({ page }) => {
    const host = structuredClone(loop.state.hosts.host);
    const raw = host as unknown as Record<string, unknown>;
    if (scenario === "on") host.in_flight_defaults.codex = true;
    if (scenario === "omitted") delete raw.in_flight_defaults;
    if (scenario === "malformed") raw.in_flight_defaults = { codex: "false" };
    const metadata = host.engines[0]!.launch_delivery_policy;
    if (["ceiling", "none", "antigravity"].includes(scenario)) metadata.mechanisms = { operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" };
    if (scenario === "ceiling") metadata.ceiling = false;
    if (scenario === "invalid") metadata.version = "v2";
    if (scenario === "antigravity") { host.engines[0]!.id = "antigravity"; host.capabilities = ["antigravity"]; raw.in_flight_defaults = { antigravity: false }; }
    loop.state.hosts = { host };
    await page.goto(loop.url); await page.getByRole("button", { name: "+ 起動" }).click();
    const dialog = page.getByRole("dialog"); const checkbox = dialog.getByRole("checkbox", { name: "実行中の割込配送" });
    const supported = ["on", "omitted"].includes(scenario);
    if (supported) { await expect(checkbox).toBeEnabled(); await expect(checkbox).toBeChecked(); }
    else await expect(checkbox).toBeDisabled();
    await dialog.getByRole("button", { name: "起動", exact: true }).click();
    await expect.poll(() => loop.frames.filter(f => f[3] === "spawn").length).toBe(1);
    const request = loop.frames.find(f => f[3] === "spawn")![4];
    if (supported) expect(request).toMatchObject({ delivery_policy: "on" });
    else expect(request).not.toHaveProperty("delivery_policy");
  });
}

test("built conflict announcement requires a deliberate new choice", async ({ page }) => {
  await page.goto(loop.url);
  await page.locator('button[aria-label$="の詳細を開く"]').first().dispatchEvent("click");
  const control = page.getByRole("region", { name: "実行中の割込配送" });
  const checkbox = control.getByRole("checkbox", { name: "割込配送を許可する" });
  await expect(checkbox).toBeEnabled();
  loop.state.policy = { ...deliveryView, policy: "off", revision: 2, applied_revision: 2 };
  await checkbox.uncheck();
  await expect(control.getByRole("status")).toContainText("選び直してください");
  await expect(checkbox).not.toBeChecked();
  expect(loop.frames.filter(f => f[3] === "set_delivery_policy")).toHaveLength(1);
  await checkbox.check();
  await expect.poll(() => loop.frames.filter(f => f[3] === "set_delivery_policy").length).toBe(2);
  expect(loop.frames.filter(f => f[3] === "set_delivery_policy")[1]![4]).toMatchObject({ expected_revision: 2, policy: "on" });
});

test("a rejected write returns the checkbox to the saved setting", async ({ page }) => {
  await page.goto(loop.url);
  await page.locator('button[aria-label$="の詳細を開く"]').first().dispatchEvent("click");
  const control = page.getByRole("region", { name: "実行中の割込配送" });
  const checkbox = control.getByRole("checkbox", { name: "割込配送を許可する" });
  await expect(checkbox).toBeChecked(); loop.state.automatic = false;
  await checkbox.click();
  await expect.poll(() => loop.frames.filter(f => f[3] === "set_delivery_policy").length).toBe(1);
  loop.reply(loop.frames.find(f => f[3] === "set_delivery_policy")!, { reason: "persistence_failed" }, "error");
  await expect(control.getByRole("status")).toContainText("設定を保存できませんでした");
  await expect(checkbox).toBeEnabled(); await expect(checkbox).toBeChecked();
});
