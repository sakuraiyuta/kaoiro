import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: [
      "../../scripts/test/fixtures/test-isolation.mjs",
    ],
    testTimeout: 15_000,
  },
});
