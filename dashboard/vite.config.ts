import { svelte } from "@sveltejs/vite-plugin-svelte";
import { consumeBuildIdentity } from "../scripts/build-identity.mjs";
// vitest/config re-exports Vite's defineConfig with the `test` field typed;
// `vite build` / `vite dev` read it identically.
import { defineConfig } from "vitest/config";

declare const process: { env: Record<string, string | undefined> };

const UNKNOWN_BUILD_IDENTITY = { version: "unknown", channel: "dev", revision: "unknown", dirty: false, branch: "unknown" } as const;

export function buildIdentity(environment: Record<string, string | undefined> = process.env) {
  try { return consumeBuildIdentity(undefined, environment); }
  catch { return UNKNOWN_BUILD_IDENTITY; }
}

const identity = buildIdentity();

// Builds straight into the Phoenix server's priv/static (output is
// gitignored; `mix dashboard.build` from server/ runs this). emptyOutDir
// stays false so favicon and robots.txt survive.
export default defineConfig({
  plugins: [svelte()],
  define: {
    "import.meta.env.VITE_KAOIRO_BUILD_VERSION": JSON.stringify(identity.version),
    "import.meta.env.VITE_KAOIRO_BUILD_BRANCH": JSON.stringify(identity.branch),
    "import.meta.env.VITE_KAOIRO_BUILD_CHANNEL": JSON.stringify(identity.channel),
    "import.meta.env.VITE_KAOIRO_BUILD_REVISION": JSON.stringify(identity.revision),
    "import.meta.env.VITE_KAOIRO_BUILD_DIRTY": JSON.stringify(identity.dirty),
  },
  // Component integration tests mount Svelte into jsdom. Without the browser
  // condition Vitest resolves `svelte` to index-server.js, where mount() is
  // intentionally unavailable.
  resolve: {
    conditions: ["browser"],
  },
  test: {
    // Keep Vitest out of e2e/ — those are Playwright specs (31-10) with
    // their own runner (`pnpm exec playwright test`).
    include: ["test/**/*.test.ts"],
  },
  build: {
    outDir: "../server/priv/static",
    emptyOutDir: false,
  },
  server: {
    // `pnpm dev` against a locally running Phoenix (mix phx.server). Note:
    // Vite cannot forward the Cookie header on the WS upgrade, so the auth
    // cookie never reaches the /client socket here — the dashboard instead
    // mints a short-lived WS ticket over the (cookie-carrying) /session HTTP
    // routes and connects with that (ADR-0013).
    proxy: {
      "/client": { target: "ws://localhost:4000", ws: true },
      // Persona HTTP requests carry the session cookie through these proxies.
      "/api": { target: "http://localhost:4000" },
      "/personas": { target: "http://localhost:4000" },
      // Token->cookie exchange, WS ticket, and cookie refresh (ADR-0013).
      // These HTTP routes DO carry cookies through the proxy.
      "/session": { target: "http://localhost:4000" },
      // OAuth authorize redirect + callback (ADR-0042 / #65). Carries
      // cookies the same as /session above.
      "/auth": { target: "http://localhost:4000" },
    },
  },
});
