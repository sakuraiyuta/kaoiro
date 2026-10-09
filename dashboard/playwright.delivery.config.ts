import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./e2e", testMatch: "deliveryPolicy.spec.ts", workers: 1,
  timeout: 30_000, use: { headless: true } });
