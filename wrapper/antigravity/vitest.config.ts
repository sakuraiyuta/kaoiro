import { defineConfig } from "vitest/config";
import "../../scripts/vitest-codex-home-guard.mjs";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup_tmpdir.ts"],
  },
});
