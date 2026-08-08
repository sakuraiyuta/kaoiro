// Viewport regression suite (phase-31 31-10, ADR-0052). Runs against the
// fixture harness under e2e/harness/ served by the plain Vite dev server —
// no Phoenix server involved. `pnpm exec playwright test` from dashboard/.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:4173",
  },
  webServer: {
    command: "pnpm exec vite --port 4173 --strictPort",
    url: "http://localhost:4173/e2e/harness/index.html",
    reuseExistingServer: !process.env.CI,
  },
});
