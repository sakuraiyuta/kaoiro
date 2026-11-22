import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import "../scripts/vitest-codex-home-guard.mjs";
import { selectTier } from "./scripts/tier-selection.mjs";

// Unset means the landing selection; every accepted entry also sets it itself
// (docs/contributing/runner-development.md#test-tiers).
const selection = selectTier(
  process.env.KAOIRO_RUNNER_TIER ?? "complete",
  dirname(fileURLToPath(import.meta.url)),
  configDefaults.exclude,
);

export default defineConfig({
  define: {
    "import.meta.resolve": "globalThis.__kaoiroTestImportMetaResolve",
  },
  test: {
    ...selection,
    env: { GEMINI_API_KEY: "" },
    setupFiles: [
      "../scripts/test/fixtures/test-isolation.mjs",
      "test/vitest.setup.ts",
    ],
    // Run the isolation module before the package setup, not in parallel.
    sequence: { setupFiles: "list" },
  },
});
