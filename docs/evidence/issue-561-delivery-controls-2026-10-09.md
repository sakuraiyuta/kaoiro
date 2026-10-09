---
title: Dashboard delivery controls implementation evidence
status: recorded
last_updated: 2026-10-09
---

# Issue 561 delivery controls

Implementation and verifier commit: `8583dd97d3564fcbf134c5531d450060c6340e4c`, based on `70bc934ad5c4926b254c5d9231c3996283325cb7`.
The adjacent [machine-readable record](issue-561-delivery-controls-2026-10-09.json)
contains every changed implementation/test input hash, gate log hash and mutation
log hash. Documentation commits preserve these implementation blobs.

## Positive gates

Tests ran under `setsid`, with `CODEX_HOME` unset for Vitest. Server commands
used the asdf shims and `LANG=C.UTF-8 LC_ALL=C.UTF-8 MIX_ENV=test`. Both pnpm
roots were installed; the dashboard adds `ws` only as a test dependency for
owned loopback transport. No production deployment, native engine or model
request was used.

| Gate | Command | Observed result | Exit |
| --- | --- | --- | --- |
| server | `mix precommit` | 2147 passed; 1 excluded | 0 |
| dashboard | `pnpm test --maxWorkers=1` | 1503 passed; 93 files | 0 |
| dashboard check | `pnpm check` | 0 errors; 0 warnings | 0 |
| dashboard build | `pnpm build` | 1 build completed | 0 |
| built browser | `pnpm exec playwright test --config playwright.delivery.config.ts` | 16 passed | 0 |
| runner | `pnpm test` | 1110 passed; 54 files | 0 |
| consumer typechecks | `pnpm -r typecheck` | 7 packages completed | 0 |
| consumer builds | `pnpm -r build` | 7 packages completed | 0 |
| focused dashboard | `pnpm test --maxWorkers=2 <five delivery test files>` | 23 passed; 5 files | 0 |
| focused server | `mix test test/kaoiro_server_web/channels/delivery_policy_test.exs` | 37 passed | 0 |

The browser loads the built production App through its default connection
construction, against an owned HTTP/WebSocket endpoint. It does not mock
`connectKaoiro`. Separate real Phoenix channel tests establish server role,
CAS, read-only, owner and serialization behavior. Browser screens were measured
at 1440x1000, 844x900 and 390x844. The fixture uses placeholder persona assets;
the screenshots establish delivery-panel layout, not persona-pack rendering.

An earlier parallel full dashboard run exceeded three existing test timers.
The final full suite ran with one worker and unchanged assertions/time limits.
Vite retains its warning about a chunk larger than 500 kB. Test fixtures emit
expected unavailable-store/auth/deprecation warnings; all listed gates exited 0.

## V1–V10 coverage

| Design check | Evidence |
| --- | --- |
| V1 | Real Phoenix client read/write/event wire, revision/conflict details, malformed success; real server handlers and two-client CAS race |
| V2 | Default built App, absent/unknown marker, disconnect and rejoin reset |
| V3 | Real App render tests, separately retained stale action callback, launch authorization, viewer rejoin with an open dialog |
| V4 | Role-first read without seed/counter/wrapper push, owner replacement/no modes/disconnect, inconsistent-owner snapshot, explicit operator none and closed viewer projection |
| V5 | Exact ack decoding/display, accepted write remains pending, no engine-derived support, none/legacy/off states |
| V6 | CAS race, no retry, uncertain save, event/read/write ordering, revision floor, generation reset, navigation and deleted/reappearing IDs |
| V7 | Canonical 8192/8193-byte and 64/65-override cases, defaults/manual/target/persona/unsupported spawn payloads, actual server register and serialized hosts retention/omission |
| V8 | No mount/rejoin write, saved off after dashboard reload, real DETS close/reopen, actual same-ID restore/resume, fresh resume-mode launch choice |
| V9 | Existing suspended-WorkStore tests keep ordinary state/permission/question delivery independent of a fresh synchronous snapshot |
| V10 | Built desktop/tablet/phone control and focus, polite pending/conflict status, fresh read, unsupported display and failed-save checkbox restoration |

V7 does **not** establish the C3 producer contract. Per the director's accepted
split, actual runner-produced metadata through register and the UI remains
unverified and belongs to issue 562 acceptance. These tests establish the C2
consumer and the existing server projection with contract-shaped inputs.

## Independent negative controls

Each mutation changed one named check/wiring point in an owned detached
worktree, starting from the same fixed implementation. Files were restored
exactly between runs. All 44 final mutations failed on behavior, not compilation.
Vitest/Playwright returned 1; ExUnit returned 2. M22 specifically leaves the
checkbox disabled, so the browser's attempted check times out with the element
reported disabled. M34 was manually classified from its failed `refute`
assertion because the log summarizer did not recognize that wording.

The initial action-guard test survived M15 because another layer masked the
cut. The final retained-callback test isolates App's action recheck and fails.
Only the final logs under `tmp/reviews/issue-561/kogane-logs/final-mutations/`
are used below; earlier attempts are retained separately.

| Mutation | Suite | Targeted check | Result / exit |
| --- | --- | --- | --- |
| M01-event-binding | unit | test/deliveryPolicyWire.integration.test.ts | red / 1 |
| M02-cas-revision | unit | test/deliveryPolicyWire.integration.test.ts | red / 1 |
| M03-conflict-details | unit | test/deliveryPolicyWire.integration.test.ts | red / 1 |
| M04-readiness-reset | unit | test/deliveryPolicyWire.integration.test.ts | red / 1 |
| M05-ack-exact | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M06-accepted-confirmed | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M07-fabricated-support | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M08-auto-retry | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M09-read-generation | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M10-request-token | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M11-read-event-order | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M12-revision-floor | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M13-json-bound | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M14-override-bound | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M15-role-action | unit | test/appDeliveryAction.integration.test.ts | red / 1 |
| M16-detail-role-render | unit | test/appDeliveryRole.integration.test.ts | red / 1 |
| M17-launch-action | unit | test/launchDelivery.integration.test.ts | red / 1 |
| M18-launch-default | unit | test/launchDelivery.integration.test.ts | red / 1 |
| M19-buffer-bound | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M20-local-notice | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M21-unknown-wins | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M22-app-marker | browser | built launch sends | red / 1 |
| M23-launch-role-render | browser | viewer rejoin | red / 1 |
| M24-manual-choice | browser | built launch sends | red / 1 |
| M25-launch-capability | browser | launch default and disablement: none | red / 1 |
| M26-spawn-policy | browser | built launch sends | red / 1 |
| M27-mount-write | browser | viewer rejoin | red / 1 |
| M28-built-event | browser | at 1440 | red / 1 |
| M29-built-read | browser | fresh read repairs | red / 1 |
| M30-live-status | browser | at 1440 | red / 1 |
| M31-read-role | server | test/kaoiro_server_web/channels/delivery_policy_test.exs | red / 2 |
| M32-operator-none | server | test/kaoiro_server_web/channels/delivery_policy_test.exs | red / 2 |
| M33-viewer-whitelist | server | test/kaoiro_server_web/channels/delivery_policy_test.exs | red / 2 |
| M34-owner-consistency | server | test/kaoiro_server_web/channels/delivery_policy_test.exs | red / 2 |
| M35-stale-owner | server | test/kaoiro_server_web/channels/delivery_policy_test.exs | red / 2 |
| M36-ordinary-cache | server | test/kaoiro_server_web/channels/delivery_policy_test.exs | red / 2 |
| M37-restore-overwrite | server | test/kaoiro_server_web/channels/agents_channel_test.exs:6052 | red / 2 |
| M38-delete-read-token | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M39-delete-saving | unit | test/deliveryPolicy.integration.test.ts | red / 1 |
| M40-register-retention | server | test/kaoiro_server_web/channels/delivery_policy_test.exs | red / 2 |
| M41-persona-override | browser | launch target resets | red / 1 |
| M42-target-reset | browser | launch target resets | red / 1 |
| M43-read-shape | server | test/kaoiro_server_web/channels/delivery_policy_test.exs | red / 2 |
| M44-failed-choice-resync | browser | rejected write | red / 1 |

The local reproducibility script is
`tmp/reviews/issue-561/kogane-mutations-final.py`; complete commands, changed
fragments and outputs are in each hashed log. The disposable worktree is
removed after recording evidence. Independent implementation review and C3
integration are still required before the director marks the work accepted.
