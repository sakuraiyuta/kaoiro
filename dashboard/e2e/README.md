---
title: Dashboard Playwright suite
status: implemented
last_updated: 2026-11-07
description: Prerequisites for the Vite fixture suite and its server integration spec.
---

# Dashboard Playwright suite

Most specs run against the fixture harness served by Vite and do not start Phoenix. The default Playwright setup uses Chromium; install its browser with `pnpm exec playwright install chromium`.

`deliveryPolicy.spec.ts` and `launchDeliveryIntegration.spec.ts` serve the built client from `server/priv/static`, so both need a dashboard build. The latter also runs `mix test test/integration/delivery_launch_acceptance.exs` from `server/`; its fixture needs built wrapper and runner artifacts, plus the server's Mix dependencies. From the repository root, prepare and run the full suite with:

```sh
pnpm install --frozen-lockfile
pnpm -C wrapper build
pnpm -C runner build
(cd server && mix deps.get)
(cd dashboard && pnpm install --frozen-lockfile && pnpm exec playwright install chromium && pnpm build && pnpm exec playwright test)
```
