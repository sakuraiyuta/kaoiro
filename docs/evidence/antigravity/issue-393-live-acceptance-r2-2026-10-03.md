---
title: "Issue 393 live acceptance r2, 2026-10-03"
description: One-turn production observation of terminal 429 handling and later usage state.
status: measured
related: [antigravity-events]
---

# Issue 393 live acceptance r2, 2026-10-03

The production `runAntigravityCli` composition used the default host and resumed
the locally selected diagnostic conversation. Account and conversation
identifiers were omitted. The run sent one model turn and ran inside the
namespace wrapper.

Command (transcript discovery was performed locally before this command):

```sh
timeout 600 env -u CODEX_HOME python3 scripts/run-antigravity-test-namespace.py -- pnpm -C worktrees/momo-393/wrapper/antigravity exec vitest run test/issue393_live_acceptance.tmp.test.ts
```

The run started at `2026-10-02T20:59:53.065Z` and completed at
`2026-10-02T21:04:00.445Z`. The one-shot Vitest command exited 1 after its
240-second wait for a `log` envelope with `kind: "result"` timed out. The
production link had already emitted the relevant rate-limit and usage
envelopes; the temporary harness waited on the wrong completion shape, so its
exit is not a passing test result. No second live run was made.

The captured outbound envelope excerpts, in sequence, show the stale terminal
429 being settled as a blocked peer error and a later positive same-family
usage state:

```json
{
  "sequence": 25,
  "ts": "2026-10-02T21:00:12.765Z",
  "type": "state_change",
  "state": "waiting_input",
  "ext": {
    "rate_limits": {
      "seven_day": {
        "status": "blocked",
        "utilization": 1,
        "resets_at": 1790974812
      }
    }
  }
}
```

```json
{
  "sequence": 27,
  "ts": "2026-10-02T21:00:12.769Z",
  "type": "inter_agent_message",
  "payload": {
    "kind": "inform",
    "error": { "code": "rate_limit" }
  }
}
```

```json
{
  "sequence": 29,
  "ts": "2026-10-02T21:00:18.707Z",
  "type": "state_change",
  "state": "waiting_input",
  "ext": {
    "rate_limits": {
      "seven_day": {
        "utilization": 0.5313726961612701,
        "resets_at": 1791002341
      },
      "five_hour": {
        "utilization": 0.02399200201034546,
        "resets_at": 1790985813
      }
    }
  }
}
```

The first two envelopes establish that the one inbound turn reproduced the
stale terminal 429 as a peer-facing `rate_limit` with a blocked overlay. The
later `state_change` carried positive same-family usage, so the live observation
also reached the second stage. This is an observation from the captured
envelopes, not a green result from the temporary Vitest command.

The wrapper output also recorded an out-of-turn `result` with status `ERROR`
at `2026-10-02T21:04:00.205Z`, after the only inbound turn (turn 1) and just
after the 240-second wait expired during shutdown. It was not treated as a
second peer turn. The temporary harness did not capture this lifecycle line in
its sanitized JSON because the lifecycle output bypassed its `stdout` spy; the
line was observed in the outer command output.
