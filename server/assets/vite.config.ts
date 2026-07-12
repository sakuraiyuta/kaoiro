import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Builds straight into Phoenix's priv/static (output is gitignored;
// `mix assets.build` runs this). emptyOutDir stays false so favicon and
// robots.txt survive.
export default defineConfig({
  plugins: [svelte()],
  // Component integration tests mount Svelte into jsdom. Without the browser
  // condition Vitest resolves `svelte` to index-server.js, where mount() is
  // intentionally unavailable.
  resolve: {
    conditions: ["browser"],
  },
  build: {
    outDir: "../priv/static",
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
      // Public persona manifest/assets (unauthenticated) so a standalone
      // Vite dev server renders sprites instead of CSS-face fallbacks.
      "/api": { target: "http://localhost:4000" },
      "/personas": { target: "http://localhost:4000" },
      // Token->cookie exchange, WS ticket, and cookie refresh (ADR-0013).
      // These HTTP routes DO carry cookies through the proxy.
      "/session": { target: "http://localhost:4000" },
    },
  },
});
