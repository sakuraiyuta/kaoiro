import { defineConfig } from "vitest/config";
import "../scripts/vitest-codex-home-guard.mjs";

export default defineConfig({
  define: {
    "import.meta.resolve": "globalThis.__kaoiroTestImportMetaResolve",
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/vitest.setup.ts"],
  },
});
