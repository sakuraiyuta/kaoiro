---
title: "Codex app-server rate-limit refresh evidence"
status: recorded
last_updated: 2026-10-02
---

# Codex app-server rate-limit refresh evidence

One live turn used the production `runCodexCli` entry with the default
`CodexHost`, `AppServerSession`, and `AppServerTransport`, a real Codex account,
and the pinned `@openai/codex` 0.159.3 app-server binary. A local Phoenix
loopback supplied the wrapper protocol only. The turn completed without tool
use. The wrapper source was commit
`e1073d7db4505f693c00f69880c33941e75bde1f`; the app-server binary SHA-256 was
`8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`.

The read was issued after `thread/start` completed. The app-server then emitted
one `account/rateLimits/updated` notification during the turn. Both observations
reported the same seven-day utilization; this sample does not demonstrate a
numeric change or establish a per-turn notification frequency.

| Observation | `limitId` | `primary` | `secondary` | `rateLimitsByLimitId` |
| --- | --- | --- | --- | --- |
| Notification `rateLimits` | `codex` | Present: `windowDurationMins=10080`, `usedPercent=47`, `resetsAt=1791431221` | Present as `null` | Absent |
| Thread-open read `rateLimits` | `codex` | Present: `windowDurationMins=10080`, `usedPercent=47`, `resetsAt=1791431221` | Present as `null` | Present; key `codex`, with the same bucket |

The capture contained no populated five-hour window. It includes only the
requested rate-limit fields and no account identifier or token. The raw capture
is retained at `/tmp/momo484-capture.0tqZ1e` until [issue #484](https://github.com/sakuraiyuta/kaoiro/issues/484) is closed.

## Multi-turn follow-up

A second live run on 2026-10-02 used the same production entry and defaults for
three consecutive turns against the real account and app-server 0.159.3. The
first turn asked Codex to run a fixed `printf` command; the next two requested
fixed text replies. Two startup reads were observed: the idle startup probe on
RPC instance 1 and the session's thread-open read on RPC instance 2. After each
result envelope, the probe issued one additional `account/rateLimits/read` on
the same session RPC to compare the post-turn account value with the latest
forwarded notification. These post-turn reads were measurement-only.

The startup probe, thread-open read, all seven notifications, and all three
post-turn reads reported `limitId=codex`, a present `primary` with
`windowDurationMins=10080`, `usedPercent=48`, and `resetsAt=1791431221`, plus a
present `secondary=null`. Both startup reads and each post-turn read also
contained `rateLimitsByLimitId` with the sole key `codex`; notifications did not
contain `rateLimitsByLimitId`. The seven notifications arrived as 3, 2, and 2
per successive turn. Every post-turn read matched the last notification for
that turn; no five-hour window was populated and no stale read was observed.
This sample supports relying on accepted notifications without adding a
turn-completion read.

The selected-field capture is `/tmp/momo484-capture.2ox0U3/live-followup.jsonl`
(SHA-256
`90c199e988f1cf0233ee2d619630423ae3e72e513fcae2a979ee2a6b7a3ebeb4`). It
contains timestamps and the requested rate-limit fields only, with no account
identifier or token, and remains until [issue #484](https://github.com/sakuraiyuta/kaoiro/issues/484) is closed.
