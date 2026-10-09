---
title: Dashboard delivery controls
description: Launch preferences and current-owner delivery controls, including pending acknowledgements and compatibility behavior.
status: accepted
last_updated: 2026-10-09
related: [responsive-reachability, channels, runner-control]
---

# Dashboard delivery controls

`実行中の割込配送` controls whether supported delivery mechanisms may accept
new early/yield input. It does not guarantee delivery success. Normal queued
messages remain available. Turning off does not retract already accepted work.
The [channel contract](../protocol/channels.md#per-agent-delivery-policy)
defines persistence, acknowledgement and admission separately.

The dashboard keeps its own client mirror of the public delivery types; it
does not depend on `@kaoiro/protocol`. The decoder and transport tests share
the contract example in `dashboard/test/fixtures/launchDeliveryContract.ts`.

## Fresh launch

The launch dialog displays the selected host/engine's `in_flight_defaults`
value. A missing map or engine key uses the server's legacy on fallback;
a malformed value is unknown. Until changed manually, the checkbox follows
host updates. A manual choice survives re-registration, persona and model
changes for that host/engine. Changing host or engine resets the choice.

An enabled checkbox adds the displayed `delivery_policy` to the fresh spawn
request, including the dialog's resume mode, which creates a new agent ID.
Restoring or resuming an existing ID sends no policy and retains its saved
setting. Opening, closing or reconnecting the dashboard never writes policy.

The checkbox requires the lobby marker `delivery_policy_control: "v1"`, a
known default and valid next-spawn metadata with a true ceiling and at least
one mechanism for the selected persona. An own-property persona override
replaces all baseline mechanisms. Operator and inter-agent early modes are
independent; operator none does not suppress an available inter-agent mode.

The optional engine entry `launch_delivery_policy` has version `v1`, a boolean
`ceiling`, complete `mechanisms`, and optional complete `persona_overrides`.
Unknown versions, malformed booleans/enums/overrides, more than 64 overrides,
or JSON encoding larger than 8,192 UTF-8 bytes make it unavailable. A false
ceiling requires all mechanisms to be none. The dashboard does not infer
support from the engine name. Antigravity and Codex exec with all-none metadata
are disabled and show that messages enter the queue.

Absent or invalid metadata disables only the delivery checkbox. The dialog
shows `起動時の配送方法は未確認`, permits ordinary launch, and omits
`delivery_policy` so the server seeds its registered default. Metadata omitted
because of a size limit and metadata absent from an old runner have the same
display; there is no reason marker. Runner production and whole-register
pressure handling belong to the C3 [runner-control contract](../protocol/runner-control.md)
and [rollout plan](../../plans/issue-463-default-inflight-delivery.md).
C2 decoding and UI checks alone do not establish producer integration.

## Existing agent

The existing detail status panel shows three separate facts: stored on/off
(or unknown), application status, and mechanisms declared by the current
wrapper owner. Mechanisms never come from launch metadata. The server's safe
projection exposes only operator early, inter-agent early, and inter-agent
yield enums; tokens, owner IDs and arbitrary capabilities are excluded.

| State | Display and action |
| --- | --- |
| Supporting owner, on, exact applied revision, any mechanism | `on（確認済み）`; live switch available |
| Supporting owner, pending ack | `確認待ち`; off is available after the save RPC settles |
| Saved off | New early/yield admission stopped; pending wrapper ack remains visible when applicable |
| Current owner declares all none | `非対応・通常配送のみ`; switch disabled |
| Legacy owner without policy ack support | Stored setting readable; live switch disabled |
| Unknown policy | `状態不明・通常配送`; switch disabled; operator can request a fresh read |
| Disconnected owner | `接続待ち`; no offline editing |
| Old/unknown server marker | API unconfirmed; no read or write request |

Viewers see the safe state without action controls. Operator/admin actions
require a current connection, role and marker; handlers recheck these at click
time. The status is announced through a polite live region. The checkbox is
keyboard-focusable when available. At tablet/phone widths it is inside the
existing status sheet, with the same scroll owner as the other status actions.

## Save, conflict and reconnect

A save uses the displayed revision in a compare-and-set request. An accepted
reply is pending, never proof that a wrapper applied the change. A conflict
refreshes state and asks for deliberate reselection; there is no automatic
retry. A timeout, disconnect or malformed success means the save result is
uncertain. A fresh read or authoritative event resolves that uncertainty.

A policy event takes precedence over a slower read. A newer event, including
unknown, also takes precedence over a delayed save reply. After an accepted
save, older revisions cannot roll the display back. New connection generations
clear that lower bound so a restored server can report a lower revision.
Normal cached envelopes cannot overwrite an existing policy event. Navigation
discards local notices without reversing an in-flight save, and replies remain
bound to their original agent. The bounded pre-snapshot event buffer retains
at most one entry per agent, up to the server projection limit of 200.
