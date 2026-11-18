import { defineConfig } from "vitest/config";
import "../../scripts/vitest-codex-home-guard.mjs";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: [
      "../../scripts/test/fixtures/test-isolation.mjs",
      "test/vitest.setup.ts",
    ],
    // Run the isolation module before the package setup, not in parallel.
    sequence: { setupFiles: "list" },
  },
});
