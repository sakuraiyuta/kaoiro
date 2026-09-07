import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    "import.meta.resolve": "globalThis.__kaoiroTestImportMetaResolve",
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/vitest.setup.ts"],
  },
});
