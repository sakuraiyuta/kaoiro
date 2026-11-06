---
title: Dashboard Playwright suite
status: implemented
last_updated: 2026-11-07
description: Prerequisites for the Vite fixture suite and its server integration spec.
---

# Dashboard Playwright suite

Most specs run against the fixture harness served by Vite and do not start Phoenix. The default Playwright setup uses Chromium; install its browser with `pnpm exec playwright install chromium`.

`launchDeliveryIntegration.spec.ts` also runs `mix test test/integration/delivery_launch_acceptance.exs` from `server/` and serves the built client from `server/priv/static`. It needs the server's Mix dependencies and a dashboard build. From the repository root, prepare and run the full suite with:

```sh
(cd server && mix deps.get)
(cd dashboard && pnpm install --frozen-lockfile && pnpm exec playwright install chromium && pnpm build && pnpm exec playwright test)
```
