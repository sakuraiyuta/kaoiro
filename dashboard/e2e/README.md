---
title: Dashboard Playwright suite
status: implemented
last_updated: 2026-11-07
description: Prerequisites for the Vite fixture suite and its server integration spec.
---

# Dashboard Playwright suite

Most specs run against the fixture harness served by Vite and do not start Phoenix. The default Playwright setup uses Chromium; `pnpm exec playwright install chromium` downloads its browser binaries. Linux also needs Chromium's system dependencies; install them with `pnpm exec playwright install-deps chromium` where OS package installation is permitted.

`deliveryPolicy.spec.ts` and `launchDeliveryIntegration.spec.ts` serve the built client from `server/priv/static`, so both need a dashboard build. The latter also runs `mix test test/integration/delivery_launch_acceptance.exs` from `server/`; its fixture needs built wrapper and runner artifacts, plus the server's Mix dependencies. From the repository root, prepare and run the full suite with:

```sh
pnpm install --frozen-lockfile
pnpm -C wrapper build
pnpm -C runner build
(cd server && mix deps.get)
(cd dashboard && pnpm install --frozen-lockfile && pnpm exec playwright install chromium && pnpm build && pnpm exec playwright test)
```

`notification-worker.spec.ts` needs the dashboard build served by a running Phoenix server and full Chromium (`channel: 'chromium'`); after starting the built server, run `(cd dashboard && KAOIRO_NOTIFICATION_TEST_ORIGIN=http://127.0.0.1:4000 pnpm exec playwright test e2e/notification-worker.spec.ts --workers=1)`. Without `KAOIRO_NOTIFICATION_TEST_ORIGIN`, these tests are skipped. The current remote test image lacks `libglib-2.0.so.0`, so Chromium cannot start there without its system dependencies. Playwright tests are not included in CI.
