import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // stderr_sink_guard.test.ts loads the TypeScript compiler and builds a
    // Program over all five wrapper packages' sources (~366 MB retained, much
    // more transient); its fork accumulates that alongside the other files'
    // heap in the same worker. The suite was already near V8's default
    // ~4 GiB old-space ceiling on base, so give the fork headroom rather than
    // leave the whole-suite gate one test away from OOM (issue #359).
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--max-old-space-size=6144"] } },
  },
});
