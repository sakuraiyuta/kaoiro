---
title: Grok early-interjection measurements (2026-11-15)
description: Reflection, completion races, receipt identity and response loss.
status: measured
last_updated: 2026-11-15
---

# Grok early-interjection measurements

Measured for [issue #1124](https://github.com/sakuraiyuta/kaoiro/issues/1124)
on 2026-11-15. The [investigation result][result] was accepted on the issue.
The current receiving contract is in the
[Grok engine reference](../../reference/engines/grok-acp.md#capabilities).
Raw logs remain private; the report identity below binds this summary to
the accepted investigation.

[result]:
  https://github.com/sakuraiyuta/kaoiro/issues/1124#issuecomment-6887469896

## Target and method

- Grok Build: `1.0.52 (0920c8169e27) [stable]`; model `grok-4.7`.
- Grok binary SHA-256:
  `1668414b047e1050a96d25fe17dfc3efe63190fbf66d8cc1c3de8633caf50d11`.
- kaoiro source: `16dfc9a617e53c316f14e49f7521906e96a1dd2d`.
- Node: `v24.3.0`.
- Accepted private report SHA-256:
  `d3607cf505c4d68bbfac62ad5c86888011a2a9c2644f60eb170feef14e6c1451`.

The 12 native sessions contained 13 interject requests, including error
probes and unsuccessful experiments. These are not 12 confirmations of
successful early delivery or a production reliability estimate.

Runs used the production `runGrokCli` entry, `GrokHost`, `AcpSession`,
native Grok child and HTTP ToolHost. TypeScript sources were loaded
directly; an in-memory server-link double supplied persona input and
permission synchronization. No live kaoiro delivery ledger or peer send
was exercised. The probe supplied an explicit ID on ordinary ACP prompts
and sent `_x.ai/interject` through the actual ACP connection.

A harmless MCP tool held its result until the interjection was queued.
Notifications were observed without changing content, except for the
explicit response-loss experiment below. Credentials were redacted before
storage. Later probes recorded every message's method, field names and
presence of the exact caller-supplied interjection ID, in addition to
selected full notifications. Model-output markers were experimental
observations, not authorization evidence.

## Reflection and completion races

| Trigger | Observation |
| --- | --- |
| Observed thought chunk, short task | Base then corrected answer, same prompt |
| Tool result held | Corrected answer after the tool result |
| First answer chunk | Base then corrected answer, same prompt |
| Vendor completion, wrapper still active | Independent fallback prompt |
| Wrapper turn already ended | Independent fallback prompt |
| Idle session | Independent fallback prompt |

The short thinking and first-answer cases emitted
`BASE_ONLYCORRECTED_ONLY` under the original prompt ID. The correction was
additive: it did not retract the earlier text or stop the first response.
In the tool-wait case, the tool handler was still waiting when the receipt
echo and queued reply arrived. After the result was released, the same
prompt emitted `CORRECTED_ONLY`; earlier assistant narration remained.

The completion-boundary experiment sent interject upon observing the
vendor's `turn_completed`, before the wrapper ended its own turn. Although
the wrapper still considered the original prompt active when it sent the
request, Grok executed the correction in a new `interject-fallback-*`
prompt. The original prompt emitted `BASE_ONLY`; the fallback emitted
`CORRECTED_ONLY`. Checking the active wrapper turn before the RPC therefore
does not guarantee reflection into that turn.

A longer initial arithmetic prompt returned queued but neither completed
nor emitted an answer within the probe's 90-second turn deadline. The
probe closed its own host and exited 1. That run is an inconclusive
reflection test, not proof of lost input or a vendor crash. The later
shorter prompt does not replace this retained timeout observation.

## Receipt identity is not prompt ownership

Passing `interjectionId` caused `_x.ai/session/interjection` to echo
`sessionId`, the exact submitted `text`, and `interjectionId`. It contained
no prompt ID or consumed/applied flag. The RPC response was:

```json
{"result":{"status":"queued"}}
```

In the later complete message-shape audits, the supplied interjection ID
occurred only in the interjection notification. It did not occur in queue
prompt IDs, output metadata or completions. Its echo provides a positive
control that it was accepted and recorded; ordinary prompt IDs were
independently visible in output and completion events.

In-turn output retained the original ordinary prompt ID. Fallback prompts
used separate generated IDs. Adding the interjection receipt ID to an
own-prompt allowlist therefore cannot establish ownership of a fallback.
Neither the `interject-fallback-` prefix nor matching text supplies the
missing authoritative association. The absence of
[MCP turn-origin proof](2026-11-15-reply-basis-origin.md) remains a separate
constraint; the receipt echo does not provide reply-basis v1 authority.

## Errors and response loss

An unknown session and a non-string text value each returned
`RequestError: Invalid params`. These explicit errors are distinct from a
queued reply; the experiment does not cover every possible RPC failure.

For response loss, the probe forwarded one real interject request and
dropped exactly its queued response between child stdout and the ACP SDK.
The interjection echo still arrived. A local 250 ms deadline expired, but
the original and corrected answers subsequently appeared under the same
ordinary prompt ID, which completed. The pending RPC rejected only when
the probe closed the connection. No retry was sent.

Thus no RPC success reached the caller even though the correction ran.
This is deliberate response-loss injection, not a naturally observed
network fault. A timeout after a possible write cannot justify submitting
another normal prompt with the same input: that may duplicate execution.

Two preliminary runs are excluded from response-loss evidence: one merely
ignored the reply locally, and another failed to intercept a Uint8Array
write and did not drop the reply. The corrected probe counted the actual
drop and absence of a delivered RPC success. Applying that same assertion
to the failed-drop record rejected it, providing a negative control.

## Contract implications and limits

The [delivery contract](../../reference/inter-agent/delivery.md)
distinguishes receipt, submitted handoff, optional inclusion, settlement
and unknown outcome. These observations establish receipt and examples of
output reflection, not an authoritative per-interjection consumed/owner
binding. Neither queued nor its echo proves consumption by the intended
prompt, completion or stopping. Ordinary prompt completion is visible,
but does not settle the ownership of an individual interjection.

Without reply-basis v1, optional ticket-used inclusion cannot be reported;
that absence alone does not rule out every form of early delivery. The
additional blockers are unproved handoff and fallback ownership, including
the completion race and possibly delivered timeout. A weaker best-effort
receiving contract would require a separate scope decision and design;
these measurements do not silently establish one.

The boundary is one binary/configuration and controlled native scenarios.
No live peer stage-report round trip, repeated production-rate study,
background-task interjection, ownership implementation or yield/stop
guarantee was tested. Source-level observation and response-loss injection
are not validation of a shipped bundle. All native processes ended and
their dedicated working directories were removed. The long thinking run
exited 1 as described; the other 11 native runs exited 0, including the
preliminary experiments whose limits are recorded above.
