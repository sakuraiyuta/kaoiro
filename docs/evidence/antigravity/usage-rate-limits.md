---
title: Antigravity CLI usage and rate limits evidence
description: Measured `/usage` response fields and the current Antigravity rate-limit mapping contract.
status: provisional
last_updated: 2026-11-06
related: [antigravity-adapter]
---

# Antigravity CLI usage and rate limits evidence

## Measured response

On `agy` 1.2.14, `agy -p /usage --output-format json` completed successfully
with a `command.name` of `usage`. Its response contains `command.data.groups`,
each with `buckets`. A bucket provides an `id`, `window`,
`remaining_fraction`, and `reset_time`. The measured families are `gemini-*`
and `3p-*`; windows are `5h` and `weekly`.

On `agy` 1.4.7 (observed 2026-10-24, issue
[#725](https://github.com/sakuraiyuta/kaoiro/issues/725)) the response gains a
third group, "Gemini 4 Argon", with a bucket `gemini-argon-wtu-weekly` whose
`window` is `weekly`. It shares the `gemini-` prefix and the window of the
`gemini-weekly` bucket but has its own quota, so it must not supply
`seven_day` for an ordinary Gemini model. The current three-group structure
is recorded in [the 1.5.1 evidence](agy-1.5.1-usage-groups-2026-11-05.md).

No account-specific output is retained here. The raw live response contained
quota values and is intentionally not checked in.

## Mapping contract

- A committed model with prefix `gemini-4-argon-` selects only the exact id
  `gemini-argon-wtu-weekly`. Other `gemini-*` models select `gemini-5h` and
  `gemini-weekly`; `claude-*` and `gpt-*` select `3p-5h` and `3p-weekly`.
  Existing prefix classification is preserved, including older catalog and
  declared extra models. Unrecognized prefixes have no vendor usage snapshot;
  an independent terminal-429 overlay can still appear.
- Select by exact bucket id and its expected vendor window, never group name
  or description. Argon expects `weekly` only and has no `five_hour` value.
  The other two groups require both windows for stale-429 confirmation;
  partial readings can still be displayed. Another group's positive quota
  cannot confirm that the selected group has quota remaining.
- `5h` maps to `five_hour`; `weekly` maps to `seven_day`.
- `utilization` is `clamp(1 - remaining_fraction, 0, 1)`.
- `reset_time` maps to Unix-seconds `resets_at` only when
  `remaining_fraction < 1`. For unused buckets the timestamp moves with each
  probe, so it is not an active reset deadline.
- A missing or unrecognized bucket set is an unusable sample. It does not
  replace the last good snapshot for the current group; before one exists,
  vendor usage is absent. There is no other-group fallback. The existing
  failure floor and three-consecutive-failure suppression apply; successful
  turns reset the count, so this is not a lifetime warning limit.
- A group change clears snapshot, terminal overlay, pending confirmation and
  its timer, including CANCELED turns that promote a pending model. A failed
  cross-group model attempt reports its quota error/reset delay without
  installing an overlay for the rolled-back current model.

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
