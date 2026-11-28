import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: [
      "../../scripts/test/fixtures/test-isolation.mjs",
      "./test/settings-isolation.ts",
    ],
    testTimeout: 15_000,
  },
});
