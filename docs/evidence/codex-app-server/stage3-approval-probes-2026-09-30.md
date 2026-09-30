---
title: "Codex app-server Stage 3 approval probes, 2026-09-30"
status: recorded
last_updated: 2026-09-30
---

# Codex app-server Stage 3 approval probes, 2026-09-30

Diagnostic probes for [issue #367](https://github.com/sakuraiyuta/kaoiro/issues/367)
(ADR-0058 Stage 3, decided in [ADR-0064](../../adr/0064-codex-app-server-approval-requests.md)).
The director approved seven model turns as diagnostic observation only; the
probes did not enable the approval axis and did not accept any design point.
The raw JSON-RPC excerpts are in the
[probe comment](https://github.com/sakuraiyuta/kaoiro/issues/367#issuecomment-5903024525);
this page keeps the observations the implementation relies on.

## Artifact and setup

- Binary: the pinned `@openai/codex` 0.156.1 Linux x64 native executable,
  SHA-256 `0b2e9301d6100dddda3b9d5c80ebaeaa3a2f1962388f2f36f6b96a9f08b1f33f`
  (re-hashed before the run), launched with the `AppServerRpc` arguments and
  `experimentalApi: false`.
- A disposable `CODEX_HOME` (mode 0700) with one copy of `auth.json` made with
  `install -m 0600`. After the run the copy was byte-identical to the
  original (`cmp`), so no token refresh happened, and it was deleted. The
  production `~/.codex` was not modified.
- A scratch working directory as the only writable root
  (`workspaceWrite`, no network, `excludeSlashTmp`, `excludeTmpdirEnvVar`),
  and a separate scratch escalation target outside it.
- For P4, a probe-owned `ToolHost` with one tool (`whoami`, returning a fixed
  string) behind the real built `bridge.js` and `BRIDGE_MCP_POLICY`. No
  production bridge or peer was used.
- `gpt-6-luna` at low effort; one fresh child and one thread per probe;
  seven model turns in total.

| File | SHA-256 |
|---|---|
| driver `driver.mjs` | `994587817c0691b48feb951d963d0df4b34e96606dd0ca22ba219dd093a65ded` |
| checker `check.py` | `8b5a453c823ade2af02f1d1e7910835e565b7588f826146ab2d6c8b57ba05fcd` |
| P1 log | `c7bbc1a4b3982df69f6fe1bfb70c08c8aff325cea255d1ea49d12a95f26d41da` |
| P2 log | `50cf57f349873ccff18623f7614b868ea30c7002606840156e389f86f869d485` |
| P3 log | `2a7bbd880602649ca2a1f4e10b4b2a0bce3538c078eae197e95247dbb817ae70` |
| P4a log | `104de510e8f9d6fd4f7f62286912612613efff7d89ca6a129fe178af3b947955` |
| P4b log | `67715872a4e4bdfc822732b69f0a476d2cf115c555cd6a9edb56ef97bc38a54e` |
| P5 log | `d52396001d50db472956e93d938ce0a6ef42ae6baa50565bef64a34c01e70bfc` |
| P6 log | `9b14d0c59daee4bf72c1c3bcff9887db154cec004267c9d2e3c9769771b2159d` |

## Observations

| Probe | Policy and action | Observed |
|---|---|---|
| P6 (negative control) | `never`; the model is asked to escalate a command outside the workspace | No server request. The model refused and ran no command. |
| P1 | `on-request`; a steer while the approval is pending, then `accept` 3 s later | `item/started` (commandExecution) came first, then in the same millisecond `thread/status/changed` with `activeFlags: ["waitingOnApproval"]` and `item/commandExecution/requestApproval` with id `0`. The steer was accepted at once with the same `turnId`. `serverRequest/resolved` came 1 ms after `accept`; the steered input item started only after the command completed. |
| P2 | `on-request`; `decline` | `serverRequest/resolved` 1 ms later, the item ended `declined`, and the turn completed. |
| P3 | `on-request`; unanswered for 120 s, then `turn/interrupt` | Nothing resolved the request in 127 s. After the interrupt: its `{}` response, then `turn/completed` (`interrupted`), then `serverRequest/resolved`, in the same millisecond. The terminal came before the resolution, with no client reply. |
| P4a | `on-request`; the model calls the bridge `whoami` | No server request; the `mcpToolCall` completed. |
| P4b | `untrusted`; the same call | No server request; the `mcpToolCall` completed. |
| P5 | `untrusted`; `apply_patch` creating a file, answered with `-32601` | `item/started` (fileChange, carrying `changes`) came 2 ms before `item/fileChange/requestApproval` (`reason` and `grantRoot` null). After the `-32601` reply: `serverRequest/resolved`, the item ended `declined`, and the turn completed (it did not fail). The file was not created. |

**Not in the generated schema:** every command approval carried
`availableDecisions: ["accept", {"acceptWithExecpolicyAmendment": {...}}, "cancel"]`.
`generate-json-schema` for 0.156.1 has no such property on
`CommandExecutionRequestApprovalParams`. `decline` is not listed, yet P2's
`decline` was honoured: the item ended `declined` and the turn continued.
The director decided on 2026-09-30 to keep mapping an operator deny to
`decline`. The captured request, reply and outcome are pinned verbatim in
`wrapper/codex/test/fixtures/app_server_approval_decline_0.156.1.jsonl`,
next to an assertion on the `@openai/codex` pin, so a pin bump fails that
test until the shape is measured again.

Not measured: server-request id reuse on one connection (each probe had one
request, and each fresh connection started at id `0`), and a second request
on the same connection.

## Checker and negative controls

`python3 check.py logs` exited 0. It checks one request per approval probe, no
id reuse, the request's `turnId` equals the started turn, `item/started`
precedes the request, exactly one resolution after it, P3's ordering, P4's
absence of requests with a completed tool call, P6's absence of requests,
and P5's declined item with a completed turn. Each negative control ran on a
copy of the logs and exited 1: P1 without its `serverRequest/resolved`, P2
with a foreign `turnId`, P6 with an injected `requestApproval`, and P5 with
the request line duplicated.

## What rests on them

- The bridge tools raise no server request under either non-`never` policy,
  so enabling the axis does not change them (P4a, P4b).
- A `-32601` reply fails closed like a decline (P5), so every rejected
  record answers `-32601`.
- `serverRequest/resolved` follows a client reply and follows an interrupt
  with no reply (P1-P3), so it is the `S` event of the record table; after an
  interrupt the terminal `T` comes first and `S` is then ignored.
- An item's `item/started` precedes its approval request, so a file-change
  dialog can carry `changes` from the item snapshot (P5).
- An unanswered request does not expire by itself (P3); the turn watchdog
  bounds it.
