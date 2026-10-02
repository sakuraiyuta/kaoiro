---
title: Antigravity CLI usage and rate limits evidence
description: Measured `/usage` response fields and the current Antigravity rate-limit mapping contract.
status: provisional
last_updated: 2026-10-03
related: [antigravity-adapter]
---

# Antigravity CLI usage and rate limits evidence

## Measured response

On `agy` 1.2.14, `agy -p /usage --output-format json` completed successfully
with a `command.name` of `usage`. Its response contains `command.data.groups`,
each with `buckets`. A bucket provides an `id`, `window`,
`remaining_fraction`, and `reset_time`. The measured families are `gemini-*`
and `3p-*`; windows are `5h` and `weekly`.

No account-specific output is retained here. The raw live response contained
quota values and is intentionally not checked in.

## Mapping contract

- A committed `gemini-*` model selects `gemini-*` buckets; committed `claude-*`
  and `gpt-*` models select `3p-*` buckets. Other models have no classified
  family and do not expose an old probe snapshot.
- `5h` maps to `five_hour`; `weekly` maps to `seven_day`.
- `utilization` is `clamp(1 - remaining_fraction, 0, 1)`.
- `reset_time` maps to Unix-seconds `resets_at` only when
  `remaining_fraction < 1`. For unused buckets the timestamp moves with each
  probe, so it is not an active reset deadline.
- A missing or unrecognized bucket set is an unusable sample. It does not
  replace the last good snapshot for the current family.

## Process observation correction

An earlier draft interpreted CLI log messages about language-server
initialization and an updater check as proof that `/usage` starts descendant
OS processes, then recommended detached process-group signaling. Those log
messages did not establish process ancestry. The bounded process measurement
in [issue-384-probe-stop-2026-10-03.md](issue-384-probe-stop-2026-10-03.md)
observed no child process at either PID-targeted SIGKILL point and no child at
the successful invocation's completion. The current design therefore signals
the checked probe PID and waits for the child's `close` event. Re-measure this
behavior when the CLI binary changes.
