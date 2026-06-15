import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Builds straight into Phoenix's priv/static (output is gitignored;
// `mix assets.build` runs this). emptyOutDir stays false so favicon and
// robots.txt survive.
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: "../priv/static",
    emptyOutDir: false,
  },
  server: {
    // `pnpm dev` against a locally running Phoenix (mix phx.server): forward
    // the WS channel plus the public persona manifest/asset routes, so a
    // standalone Vite dev server renders sprites instead of falling back to
    // CSS faces (the persona API is unauthenticated, so no token is involved).
    proxy: {
      "/client": { target: "ws://localhost:4000", ws: true },
      "/api": { target: "http://localhost:4000" },
      "/personas": { target: "http://localhost:4000" },
    },
  },
});
