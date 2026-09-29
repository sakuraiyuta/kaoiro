---
title: "Codex app-server initialize collisions on sqlite state, 2026-09-30"
status: recorded
last_updated: 2026-09-30
---

# Codex app-server initialize collisions on sqlite state, 2026-09-30

Measurements behind the bounded `initialize` retry of
[issue #411](https://github.com/sakuraiyuta/kaoiro/issues/411). The procedure,
per-run summaries and driver are in the
[results comment](https://github.com/sakuraiyuta/kaoiro/issues/411#issuecomment-5895399064);
this page keeps the observations the implementation relies on.

## Setup

- Binaries: the pinned `@openai/codex` 0.156.1 (SHA-256
  `0b2e9301d6100dddda3b9d5c80ebaeaa3a2f1962388f2f36f6b96a9f08b1f33f`), an older
  0.144.1 (`a96f944d1a596dbfb7fdd84f482be5c50e34b04bb371126840d873e4ebf26902`)
  and a newer 0.157.0
  (`1a822376d4634ac32dddc030e5117c63359f7f8cd4b1b64382c68190287d0258`), all
  already on the host; nothing was installed.
- Each child ran with a scratch `CODEX_HOME` and `HOME`, no auth, no model turn,
  on one core (`taskset -c 0`), launched with the `AppServerRpc` arguments and
  one `initialize` request with `experimentalApi: false`. A pair is two children
  spawned back to back on the same home; runs were sequential. The driver
  retried a child that ended without a reply after a uniform 100 to 400 ms, up
  to 3 attempts, and recorded each child's first attempt separately.

## Observed

In all 26 failed first attempts the child exited with code 1, its stdout ended
before any reply to `initialize` (no JSON-RPC error), and its stderr had this
line, identical up to the home path. A failed attempt ended 68 to 155 ms after
spawn.

```text
Error: failed to initialize sqlite state runtime under <home>: failed to initialize state runtime at <home>
```

| Scenario | Home before the pair | Binary of the pair | First attempt failed (children) | Runs with a failure | Attempts needed (max) | Healthy after (min / median / max ms) |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | empty | 0.156.1 | 8/30 | 8/15 | 2 | 404 / 500 / 706 |
| M2 | initialized by 0.156.1, `state_5.sqlite*` deleted | 0.156.1 | 8/30 | 8/15 | 2 | 259 / 376 / 665 |
| M3a | initialized by 0.144.1 | 0.156.1 | 8/30 | 8/15 | 2 | 303 / 394 / 668 |
| M3b | initialized by 0.156.1 | 0.157.0 | 2/30 | 2/15 | 2 | 232 / 333 / 561 |
| M3c (control) | initialized by 0.156.1 | 0.156.1 | 0/30 | 0/15 | 1 | 271 / 322 / 375 |

- Every one of the 26 failed children succeeded on its second attempt.
- M5: with `state_5.sqlite` created as a directory in an empty home, the pinned
  binary failed 3/3 with exit code 1 and no reply, after 19 to 21 ms, with the
  same stderr line. This is the deterministic failure the CI pin uses.
- State schema of a fresh home (`_sqlx_migrations`): 0.144.1 has 40 migrations,
  0.156.1 has 55, 0.157.0 has 57, all in `state_5.sqlite`.

## Inferred

- The collision is not specific to an empty home: it reproduces when
  `state_5.sqlite` is missing and when a home written by an older CLI is opened
  by a newer one, and does not occur when the home already matches the binary.
- A CLI update is an in-place migration of the same file, not a rename to
  `state_6.sqlite`.
- The scratch databases were 4 KB plus WAL; production has a 274 MB
  `thread_history_1.sqlite`. The measurements cannot show how long a production
  migration holds the lock, so the third attempt's wait (400 to 1600 ms) is a
  margin, not a measured requirement.
- The same signature line is printed for permanent failures (M5), so it
  identifies sqlite initialization failures in general, not the race.
