import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deliveryLoopback } from "../test/deliveryPolicyLoopback";
import { parseLaunchDeliveryPolicy } from "../src/lib/deliveryPolicy";

let directory: string;
let forwarded: Record<string, { host_id: string; host: { engines: { id: string; launch_delivery_policy?: unknown }[]; in_flight_defaults: Record<string, boolean> } }>;
test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "kogane562-v7-"));
  const output = join(directory, "forwarded.json");
  const log = execFileSync("setsid", ["-w", "mix", "test", "test/integration/delivery_launch_acceptance.exs"], {
    cwd: resolve("../server"), timeout: 180_000, encoding: "utf8",
    env: { ...process.env, PATH: `${process.env.HOME}/.asdf/shims:${process.env.PATH}`, MIX_ENV: "test",
      LANG: "C.UTF-8", LC_ALL: "C.UTF-8", KAOIRO_DELIVERY_V7_OUTPUT: output },
  });
  console.info(log);
  forwarded = JSON.parse(readFileSync(output, "utf8"));
});
test.afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

for (const scenario of ["actual", "disabled", "oversized"]) {
  test(`C3 producer through real server and built public client: ${scenario}`, async ({ page }) => {
    const value = forwarded[scenario]!;
    const decoded = parseLaunchDeliveryPolicy(value.host.engines.find(e => e.id === "codex")?.launch_delivery_policy);
    if (scenario === "actual") expect(decoded).toMatchObject({ version: "v1", ceiling: true,
      mechanisms: { operator_early: "none", inter_agent_early: "steer", inter_agent_yield: "none" } });
    else if (scenario === "disabled") expect(decoded).toMatchObject({ ceiling: false,
      mechanisms: { operator_early: "none", inter_agent_early: "none", inter_agent_yield: "none" } });
    else expect(decoded).toBeUndefined();
    expect(value.host.in_flight_defaults.codex).toBe(false);
    const loop = await deliveryLoopback(resolve("../server/priv/static"));
    try {
      loop.state.hosts = { [value.host_id]: value.host } as unknown as typeof loop.state.hosts;
      await page.goto(loop.url); await page.getByRole("button", { name: "+ 起動" }).click();
      const dialog = page.getByRole("dialog"); await dialog.getByLabel(/^エンジン/).selectOption("codex");
      const checkbox = dialog.getByRole("checkbox", { name: "実行中の割込配送" });
      if (scenario === "actual") { await expect(checkbox).toBeEnabled(); await expect(checkbox).not.toBeChecked(); }
      else await expect(checkbox).toBeDisabled();
      if (scenario === "oversized") await expect(dialog).toContainText("起動時の配送方法は未確認");
    } finally { await page.close(); await loop.close(); }
  });
}
