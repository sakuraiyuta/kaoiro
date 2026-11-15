---
title: Grok MCP turn-origin measurements (2026-11-15)
description: Explicit ACP prompt IDs, MCP metadata and delayed-call ownership.
status: measured
last_updated: 2026-11-15
---

# Grok MCP turn-origin measurements

Measured for [issue #1126](https://github.com/sakuraiyuta/kaoiro/issues/1126)
on 2026-11-15. The current contract is in the
[Grok engine reference](../../reference/engines/grok-acp.md#capabilities).
The [investigation result][result] was accepted on the issue; the private
report's identity is listed below. Raw logs remain private. This page
retains only general-form observations.

[result]:
  https://github.com/sakuraiyuta/kaoiro/issues/1126#issuecomment-6887267422

## Target and method

- Grok Build: `1.0.52 (0920c8169e27) [stable]`.
- Grok binary SHA-256:
  `1668414b047e1050a96d25fe17dfc3efe63190fbf66d8cc1c3de8633caf50d11`.
- kaoiro source: `0ba15295c13e43cdd39dfc6799cc470a0acfa8ce`.
- Node: `v24.3.0`.
- Accepted private report SHA-256:
  `9a6c8145ce352846954662379e0654fa93e9dec8818436fb28ca593ed6424082`.

Four native runs used the production `runGrokCli` entry, `GrokHost`,
`AcpSession`, native Grok child and HTTP `ToolHost`. Workspace TypeScript
sources were loaded directly, rather than the older local build output.
The server link was an in-memory double supplying persona input and
permission synchronization. This did not exercise the live server or UI.

A harmless extra MCP tool, `observe_origin`, recorded its handler context
and echoed a marker. Markers are model-supplied experimental labels, not
authorization. No inter-agent send was performed. Request bodies were
recorded before SDK dispatch, with credentials redacted before storage;
headers were sanitized before logging. The recorder forwarded the original
body bytes. This was a sanitized request record, not a packet capture.

One variant added `_meta.promptId` to `session/prompt` in the probe process.
The two timing variants held an actual native request after bounded body
reading and before dispatch. They changed timing deliberately; they did not
inject a fabricated request or construct fake native turns. Product source
was unchanged.

## Observations

| Run | MCP calls | Observation |
| --- | ---: | --- |
| Ordinary prompts | 2 | Only `progressToken` in call `_meta` |
| Explicit ACP prompt IDs | 2 | IDs echoed on ACP, absent from MCP |
| Delay through the next turn | 2 | A's call entered during B, not aborted |
| Delay until idle | 1 | A's call entered with an aborted signal |

All seven `tools/call` requests contained only `progressToken` in `_meta`.
Their header names were `accept`, `mcp-protocol-version`, `content-type`,
`authorization`, `user-agent`, `host` and `content-length`. No captured call
carried an ACP session ID, prompt ID or tool-use ID. The bearer and endpoint
belonged to the resident ToolHost, not individual turns.

The explicit-ID run used two distinct prompt IDs. Both appeared unchanged
on ACP `turn_completed`, providing a positive control that Grok accepted
them. Their MCP requests instead had JSON-RPC IDs 2 and 3 and progress
tokens 1 and 2. Discovery metadata and progress tokens were also preserved
by the recorder; absence of origin metadata was not inferred from a
name-filtered search. These counters supplied no proved mapping to ACP IDs.

### Controlled delay across retirement

The active-turn experiment followed this sequence:

1. Capture A's native MCP request and hold its body before SDK dispatch.
2. Interrupt A through the host, observe vendor completion and wrapper end.
3. Start B and hold B's own MCP tool result while B remains active.
4. Release A's original request body.

A's handler then observed `current: "B"`, `aborted: false`, `origin: null`,
9,367 ms after A's wrapper turn ended. The idle counterpart omitted B;
its handler observed `current: null`, `aborted: true`, `origin: null`,
4 ms after A ended. The probe recorded even an aborted context; this does
not show that a real inter-agent send succeeds while idle.

The socket received A's body during A. The experiment demonstrates late
**dispatch after a processing delay**, not first network-byte arrival
after A ended or a naturally occurring production incident.

At the measured commit, `wrapper/grok/src/host.ts` supplies ToolHost with
the current signal callback and no `resolveOrigin`.
`wrapper/grok/src/toolhost.ts` awaits body reading before sampling that
callback at dispatch. Idle produces an aborted signal, whereas dispatch
during B can receive B's signal. This explains the observed distinction.

## Interpretation and limits

The [earlier premise](2026-10-14-premises.md) is confirmed for the measured
HTTP ToolHost path: ACP prompt identity does not establish MCP origin.
Using the currently active turn would misattribute the delayed A call.
Arguments, request order and the latest ACP update do not supply a proved
binding. This matters to the
[reply-basis origin contract][origin-contract],
which forbids borrowing another turn's confirmed input snapshot.

[origin-contract]:
  ../../reference/inter-agent/reply-basis.md#default-basis-and-tool-origin

Analysis checked all four completions, seven requests, explicit-ID echoes,
the delayed-call context and the idle counterpart. As a negative control,
changing the recorded delayed-call owner from B to A made the same analysis
assertion fail. This checks the analysis claim, not a product protection gate.

The boundary is one binary/configuration, one induced active-turn race and
one idle counterpart. No background-task or subagent MCP mode, alternative
transport, v1 negotiation or actual peer send was tested. This does not
establish that every possible isolation architecture is incapable of v1,
nor rule out all early delivery. A future origin binding requires native
measurement of its own, including delayed calls and retirement.
