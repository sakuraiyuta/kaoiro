// issue #304 M2: a SEPARATE Vite config for bench/harnessApp.* only.
// vite.config.ts (the production/dev config) is untouched -- the "phoenix"
// alias below must never leak into the real app's build. Reuses the same
// svelte() plugin so the real src/App.svelte compiles identically to
// production; the only difference is resolving "phoenix" to
// bench/fakePhoenix.ts instead of the real npm package, so protocol.ts's
// `import { Socket } from "phoenix"` picks up the in-memory fake with zero
// changes to protocol.ts or App.svelte.
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, ".."),
  plugins: [svelte()],
  resolve: {
    alias: {
      phoenix: path.resolve(__dirname, "fakePhoenix.ts"),
    },
  },
  optimizeDeps: {
    // Without this, Vite's dependency scan crawls every *.html under the
    // project root, including bench/harness.html and e2e/harness/index.html
    // -- the former imports a gitignored file (.AgentDetail.before.bench.svelte)
    // that only exists mid-run of bench/runBench.mjs, failing the scan and
    // silently disabling pre-bundling for THIS server too. Scope it to the
    // one entry this config actually serves.
    entries: ["bench/harnessApp.html"],
  },
});
