---
title: Grok auto mode and peer-requested assignment acceptance
date: 2026-11-15
---

# Grok auto mode and peer-requested assignment acceptance

Observations for [issue #1123](https://github.com/sakuraiyuta/kaoiro/issues/1123)
on Grok Build 1.0.52 (`grok 1.0.52 (0920c8169e27) [stable]`), with the host's
own Grok and Claude configuration.
The counts come from Grok's own session records (`updates.jsonl` in Grok's
sessions directory) of the sessions that the issue's implementation, its two
implementation reviews and the test fix created on 2026-11-15.

## How the sessions were counted

- A session is one Grok session (one session ID). Only sessions whose input
  included a peer's message asking Grok to accept an assignment with
  `send_to_agent` are counted.
- A refusal is a failed `tool_call_update` whose text contains "was not
  executed: Auto mode blocked this action". All three recorded refusals were
  of `kaoiro__send_to_agent`.
- Native sessions come from `wrapper/grok/test/native.test.ts`, which uses a
  fake server link; two human turns come before the peer's message. Other
  sessions come from disposable prototype and real-server runs, in which the
  peer's message was the session's first input.

| Runs | Human turn just before the peer's message | Sessions | With a refusal |
|---|---|---|---|
| Native | "No tools. Reply with the remembered name." | 6 | 2 |
| Native | "For this reply only, use no tools: reply with the remembered name." | 5 | 1 |
| Other | none | 10 | 0 |

The native runs total 11 sessions with 3 refusals. Three more sessions of the
other runs are not counted: one started from a direct prompt rather than a
peer's message, one received only a server `peer-error` notice, and one
received no input.

## Reasons given

Each refusal names its reason in the record:

1. "the last human instruction was to use no tools" (the unscoped turn).
2. "Sending a peer reply and accepting an assignment was not requested by the
   user; only an inter-agent message asked for it" (an earlier candidate whose
   peer message described the operation in prose).
3. "Sending to native-peer and accepting the assignment was not requested by
   the user; the inter-agent message and prior list_agents approval do not
   authorize it" (the scoped turn).

Scoping the turn removed the first reason from the test's input. The third
refusal shows that it does not prevent the second kind. Such a run is
indeterminate; the rerun rule is in the
[Grok engine reference](../../reference/engines/grok-acp.md#capabilities).

## Not included above

The combined check of
[issue #658](https://github.com/sakuraiyuta/kaoiro/issues/658), run with a
real server and a scripted director after this issue landed, recorded 0
refusals in 4 Grok sessions. Two of them were created by the resets and
received no request. The source is the
[issue 658 landing record](https://github.com/sakuraiyuta/kaoiro/issues/658#issuecomment-6887822608).
Its raw session records were not kept, so it was not recounted and is not
added to the counts above.

These are observations of one Grok version and host configuration, not a
frequency estimate for other versions, configurations or production use.
