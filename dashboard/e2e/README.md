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

`notification-worker.spec.ts` needs the dashboard build served by a running Phoenix server and full Chromium (`channel: 'chromium'`); after starting the built server, run `(cd dashboard && KAOIRO_NOTIFICATION_TEST_ORIGIN=http://127.0.0.1:4000 pnpm exec playwright test e2e/notification-worker.spec.ts --workers=1)`. Without `KAOIRO_NOTIFICATION_TEST_ORIGIN`, these tests are skipped. The shared remote test image lacks `libglib-2.0.so.0`, so Chromium cannot start there; use a test image derived from it with `playwright install-deps chromium`, fetch the browser in the prepare step, and pass `--workers=1`, because the remote container's process limit makes Chromium fail to start threads (`pthread_create: Resource temporarily unavailable`) with more workers. Playwright tests are not included in CI.

## Markdown worker gate

Run `markdownWorker.spec.ts` on the exact candidate build whenever worker code,
Markdown ownership/scroll integration, CSP or static serving changes. Both the
implementer and independent reviewer record their own candidate SHA, command,
browser version, exit, warnings and results before landing. This manual gate is
outside CI; Vitest covers the deterministic handler/ownership contracts.

Prepare the dashboard's frozen dependencies and build, plus the server's Mix
dependencies. Start an isolated loopback Phoenix server from `server/` with
`MIX_ENV=test PHX_SERVER=true PORT=46173 mix run --no-halt`. Set `TMPDIR` to a
new owned temporary directory before starting it, so the test-config stores
and caches can be removed after stopping that process. Do not inherit production
configuration variables. From `dashboard/`, run:

```sh
KAOIRO_MARKDOWN_TEST_ORIGIN=http://127.0.0.1:46173 \
  pnpm exec playwright test e2e/markdownWorker.spec.ts --workers=1
```

Use the remote test launcher by default, with a Playwright-capable image;
record an applicable local-execution exception when necessary. The browser
receives the actual Phoenix HTML, CSP and hashed JavaScript worker asset.
Only HTTP/WS application data is mocked. CSP denial is an explicit negative
control. Normal-result ordering after a main-thread stall is a Chromium 151
observation, not a portable ordering guarantee. Timing criteria cover the
named foreground fixtures; they do not promise a maximum arbitrary-history
wait. Preserve the test output until review has recorded the evidence.
