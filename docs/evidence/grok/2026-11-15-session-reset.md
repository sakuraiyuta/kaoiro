---
title: Grok session reset premises
date: 2026-11-15
---

# Grok session reset premises

Measurements for [issue #658](https://github.com/sakuraiyuta/kaoiro/issues/658)
against Grok Build 1.0.52 (`grok 1.0.52 (0920c8169e27) [stable]`) and ACP SDK
1.8.0, on Linux, with the host's own Grok and Claude configuration. The wrapper
and runner were built from commit
`0ba15295c13e43cdd39dfc6799cc470a0acfa8ce`. The probes ran outside the
repository against the built `runGrokCli` (and, for M7, the built runner
functions) with a fake server link. Only method outcomes, identifier shapes,
selection values, counts and timings were kept; no prompt output beyond a
planted marker word, token or session content was recorded. Each scratch cwd
and its Grok session group were removed by exact name; Grok's memory
workspaces were not
([issue #650](https://github.com/sakuraiyuta/kaoiro/issues/650)).

| # | Question | Observed |
|---|---|---|
| M1 | A fresh session inside a running Grok | `initialize` reported `sessionCapabilities` `list`, `resume` and `close`. A second `session/new` on the same connection succeeded with a distinct id. A `session/list` right after listed the first session only; both were on disk later. No prompt was sent. |
| M2 | A relaunch without `--resume` that carries the stored snapshot | New session id. A switched model kept its value and `config` source; the effort and sandbox were at their defaults in this run. `resume_drift: []`. One authenticated `tools/list`. The rules sent on `session/new` were the new ones: a marker word given only in the new rules was answered, the old one was not. A requested replay had no entries between its reset and its completion. |
| M3 | Idle close | `close()` of an idle wrapper took 75 ms and left no process in Grok's group. |
| M4 | Grok's own permission request before a kaoiro MCP call | None for `whoami` (in the imported Claude allow rules) and none for an unlisted test tool, whose handler ran once. Positive control: with the `live-permission` plugin forcing `ask`, the same recorder captured two requests for one call (`probe_unlisted`, then `kaoiro__probe_unlisted`) and the handler ran once. A first control run was inconclusive: the model did not call the tool. |
| M5 | Session id at the join | Read from the code: the persona prompt arrives after the join and `session/new` runs after it, so no session id is known at the join. |
| M6 | Grok's wait on a blocked kaoiro MCP call | A tool that blocked for 600 s was waited for in full (call at 36.9 s, resolved at 636.9 s) with no abort while waiting, and the reply carried its result. A 5 s run agreed. Grok's own timeout and whether it closes the HTTP request when it fires were not measured. |
| M7 | A non-default effort and sandbox through the reset relaunch | Run A launched read-only and switched the effort from `high` (default) to `xhigh` while idle. The runner's `validateResolvedSnapshot`, `applyResumeSnapshot` and `resolveWrapperConfig` built the relaunch config from launch values of workspace-write with network on; the snapshot made it read-only, network off, effort `xhigh` with source `config`, a transition id and no `--resume`. Run B reported the same effective values, `resume_drift: []`, one authenticated `tools/list` and a new session id. No prompt was sent. |

The native acceptance test `wrapper/grok/test/native-session-reset.test.ts`
(`KAOIRO_LIVE_GROK=1`) repeats M2 and M7 as assertions and drives
`request_session_reset` through Grok's own MCP path: a deny, an approval
followed by a lifecycle `session_reset_failed`, and two `agent_busy`
refusals. A first version asked Grok to call the tool by its bare name. In its
first run, no call reached the wrapper in the deny and `agent_busy`
scenarios. A diagnostic rerun of the deny scenario showed, in Grok's own
session log, `use_tool` rejecting the unqualified name before the model
retried with the qualified one; the `agent_busy` failure was not inspected.
The prompt now names `kaoiro__request_session_reset`, and the next run passed
all four scenarios.

These are observations of the measured version and host configuration, not
guarantees for later Grok versions.
