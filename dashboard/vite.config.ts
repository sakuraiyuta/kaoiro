import { svelte } from "@sveltejs/vite-plugin-svelte";
import { computeBuildIdentity } from "../scripts/build-identity.mjs";
// vitest/config re-exports Vite's defineConfig with the `test` field typed;
// `vite build` / `vite dev` read it identically.
import { defineConfig } from "vitest/config";

declare const process: { env: Record<string, string | undefined> };

const BUILD_REVISION_RE = /^[0-9a-f]{40}$/;
const BUILD_VERSION_RE = /^\d{4}\.(?:[1-9]|1[0-2])\.\d+$/;

const UNKNOWN_BUILD_IDENTITY = {
  version: "unknown",
  channel: "dev",
  revision: "unknown",
  dirty: false,
} as const;

export function buildIdentity(
  environment: Record<string, string | undefined> = process.env,
) {
  const {
    KAOIRO_BUILD_VERSION,
    KAOIRO_BUILD_CHANNEL,
    KAOIRO_BUILD_REVISION,
    KAOIRO_BUILD_DIRTY,
  } = environment;

  const explicitValues = [
    KAOIRO_BUILD_VERSION,
    KAOIRO_BUILD_CHANNEL,
    KAOIRO_BUILD_REVISION,
    KAOIRO_BUILD_DIRTY,
  ];
  if (explicitValues.every((value) => value === undefined)) {
    return computeBuildIdentity();
  }

  const validVersion =
    KAOIRO_BUILD_VERSION === "unknown" ||
    (typeof KAOIRO_BUILD_VERSION === "string" && BUILD_VERSION_RE.test(KAOIRO_BUILD_VERSION));
  const validRevision =
    KAOIRO_BUILD_REVISION === "unknown" ||
    (typeof KAOIRO_BUILD_REVISION === "string" && BUILD_REVISION_RE.test(KAOIRO_BUILD_REVISION));
  const validChannel = KAOIRO_BUILD_CHANNEL === "dev" || KAOIRO_BUILD_CHANNEL === "release";
  const validDirty = KAOIRO_BUILD_DIRTY === "true" || KAOIRO_BUILD_DIRTY === "false";

  if (!validVersion || !validRevision || !validChannel || !validDirty) {
    return UNKNOWN_BUILD_IDENTITY;
  }

  const identity = {
    version: KAOIRO_BUILD_VERSION,
    channel: KAOIRO_BUILD_CHANNEL,
    revision: KAOIRO_BUILD_REVISION,
    dirty: KAOIRO_BUILD_DIRTY === "true",
  };
  if (
    identity.channel === "release" &&
    (identity.version === "unknown" ||
      identity.revision === "unknown" ||
      identity.dirty)
  ) {
    return UNKNOWN_BUILD_IDENTITY;
  }
  return identity;
}

const identity = buildIdentity();

// Builds straight into the Phoenix server's priv/static (output is
// gitignored; `mix dashboard.build` from server/ runs this). emptyOutDir
// stays false so favicon and robots.txt survive.
export default defineConfig({
  plugins: [svelte()],
  define: {
    "import.meta.env.VITE_KAOIRO_BUILD_VERSION": JSON.stringify(identity.version),
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
      // Public persona manifest/assets (unauthenticated) so a standalone
      // Vite dev server renders sprites instead of CSS-face fallbacks.
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
