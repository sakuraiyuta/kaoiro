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
    // `pnpm dev` against a locally running Phoenix (mix phx.server).
    proxy: {
      "/client": { target: "ws://localhost:4000", ws: true },
    },
  },
});
