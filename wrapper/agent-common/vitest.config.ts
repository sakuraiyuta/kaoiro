import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve sibling workspace packages to their TS source so tests run
// against fresh code without a prior `pnpm -r build` (package.json main
// points at dist for runtime).
export default defineConfig({
  resolve: {
    alias: {
      "@kaoiro/wrapper-core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
