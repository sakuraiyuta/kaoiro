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
import { defineConfig, type Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The real App talks to same-origin session endpoints before it opens the
// socket (cookie login, then a ticket for the WS). The harness dev server has
// no backend, so without these the App shows the login form and never joins
// the fake channel. Exact method + path only; anything else falls through.
// Bench-only: the production vite.config.ts never imports this file.
const SESSION_ROUTES: Record<string, { method: string; body: unknown }> = {
  "/session/new": { method: "POST", body: {} },
  "/session/ticket": { method: "GET", body: { ticket: "bench-ticket" } },
  "/session/auth-methods": { method: "GET", body: { token: true, oauth: [] } },
  "/session/refresh": { method: "GET", body: {} },
};

const sessionStub = (): Plugin => ({
  name: "bench-session-stub",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const route = SESSION_ROUTES[(req.url ?? "").split("?")[0] ?? ""];
      if (route === undefined || req.method !== route.method) return next();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(route.body));
    });
  },
});

export default defineConfig({
  root: path.resolve(__dirname, ".."),
  plugins: [svelte(), sessionStub()],
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
