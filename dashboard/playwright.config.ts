// Viewport regression suite (phase-31 31-10, ADR-0052). Runs against the
// fixture harness under e2e/harness/ served by the plain Vite dev server —
// no Phoenix server involved. `pnpm exec playwright test` from dashboard/.
import { defineConfig } from "@playwright/test";

const port = process.env.KAOIRO_DASHBOARD_E2E_PORT;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  use: port ? { baseURL: `http://127.0.0.1:${port}` } : {},
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4173",
    // Vite reports a busy port before it logs the bound URL; capture only Local.
    wait: {
      stdout: /Local:\s+http:\/\/127\.0\.0\.1:(?<kaoiro_dashboard_e2e_port>\d+)\//,
    },
    reuseExistingServer: false,
  },
});
