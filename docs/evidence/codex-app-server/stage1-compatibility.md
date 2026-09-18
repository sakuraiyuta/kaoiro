---
title: "Codex app-server Stage 1 compatibility — 2026-09-18"
status: recorded
last_updated: 2026-09-18
---

# Codex app-server Stage 1 compatibility — 2026-09-18

Historical excerpts from [ADR-0058](../../adr/0058-codex-app-server-turn-steer.md). Each increment
retains its original scope and tense; “now”, “above” and “remaining” describe that
record, not a new claim of present implementation or release.

The earlier Appendix A/B comparison is in the [transport spikes](transport-spikes-2026-09-14.md).

Scratch paths and hashes below identify the recorded experiments, not a promise
that temporary files remain available. Measurement dates are retained per record;
`last_updated` refers to the source text, not a new measurement.

## Appendix C — Stage 1 compatibility gate, 2026-09-18 JST

### Decision boundary and artifact

The current production artifact supports the measured app-server transport
surface without a pin update or `experimentalApi` opt-in. This clears the
initial compatibility probe for issue #348, not the adapter parity gates.
No adapter or launch selection is implemented by this evidence update;
`codex exec` remains the default. Operator and inter-agent steering remain
disabled in the planned transport adapter. The isolated external-message
experiment below does not authorize either feature.

- Repository baseline: `d19dad9834e3fa87984c8f793c3c9e9a8ada17f8`.
- Package: `@openai/codex@0.153.4`, resolved through its installed Linux x64
  platform package, not the user's global CLI.
- Executed binary:
  `/home/yuta/git/kaoiro/node_modules/.pnpm/@openai+codex@0.153.4-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex`.
- Binary SHA-256:
  `56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da`.
- `--version`: `codex-cli 0.153.4` (exit 0).
- `initialize` response, with `experimentalApi: false`:

```json
{"userAgent":"fuji_348_probe/0.153.4 (Ubuntu 24.4.0; x86_64) unknown (fuji_348_probe; 1)","codexHome":"/tmp/fuji-348-probe/offline/home-run","platformFamily":"unix","platformOs":"linux"}
```

The response has no `serverInfo`; clients must not require that newer shape.
The version is present in `userAgent`. The reference Python client's fallback
handles this shape.

Schema generation used this exact binary with
`app-server generate-json-schema --out <directory>`, once without flags and
once with `--experimental` (both exit 0). For each directory, sort relative
POSIX paths of all `*.json` files lexicographically and concatenate
`SHA256(file) + "  " + relative_path + "\n"`. The table hashes that UTF-8
manifest, without including the output directory name.

| Generated bundle | JSON files | SHA-256 of manifest |
| --- | ---: | --- |
| Stable | 304 | `2a24eb10034dcb9b7cfab65ab9160cb53350e66a3668829461bcb9c8c7a1e0aa` |
| Experimental | 416 | `60c1b926bc9720e7695c23bcc6f8cb1dd7dcfa92601dd3e9d7b9267804f28c87` |

The stable `ClientRequest.json` SHA-256 is
`25bc001b5dfe3b35785597b8f9ad9e5aaf7e437331fa9921f041c9e0e03fc9f3`;
`ServerNotification.json` is
`b3e76cf11842f3e8b3270c05e000212b56eabafb0152fc38e8f920e2ef902991`.
These are whole generated files, including nested definitions. A different
binary invalidates this compatibility evidence.

### Reference SDK and required surface

Reference: OpenAI's [Python SDK at commit
9fd29dfd8c583e93855aeb2a51e1725346765162](https://github.com/openai/codex/tree/9fd29dfd8c583e93855aeb2a51e1725346765162/sdk/python/src/openai_codex),
the commit selected by tag `python-v0.154.0`. Inspection covered `client.py`,
`_message_router.py`, `_approval_mode.py`, `_inputs.py`, `api.py`, `_run.py`,
and `_runtime_requirements.py`. Its runtime minimum alone is not a
compatibility proof.

| TS adapter surface | Python reference | Fixed CLI schema / measurement |
| --- | --- | --- |
| `initialize`, then `initialized` | Client initialization and reader startup | Stable; measured with experimental capability false |
| `thread/start` | Thread creation | Stable `approvalPolicy`, `approvalsReviewer`, `developerInstructions`, `config`, `sandbox`; startup measured |
| `thread/resume`, `thread/read` | Resume and persisted history access | Stable `threadId`, `excludeTurns` / `includeTurns`; new-process resume and full read measured |
| `turn/start` | Run input conversion and turn submission | Stable `threadId`, `input`, `clientUserMessageId`, `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy`; sequential start/terminal measured; client message correlation and all setting overrides remain adapter gates |
| `turn/interrupt` | Turn interruption | Stable `threadId`, `turnId`; runtime interruption remains a later gate |
| `thread/compact/start` | Explicit compaction | Stable `threadId`; runtime compaction remains a later gate |
| `model/list` | Model discovery | Stable method; integration remains a later gate if required by the existing catalog path |
| Responses, server requests, notifications | `client.py` reader and `_message_router.py` | Separate response `id`, server request `method` + `id`, and notification `method`; response-before/after-event races require adapter tests |
| `item/started`, `item/completed`, `item/agentMessage/delta`, `turn/started`, `turn/completed`, `thread/tokenUsage/updated` | Turn event subscription and `_run.py` result collection | Stable notifications; observed from the real CLI using fixed local model responses |
| Command/file/MCP/reasoning progress, `thread/compacted`, error | Notification dispatch | Present in stable schema; runtime parity is not established by the text-only probe |
| `turn/start.toolOutput` | `_inputs.py` → `api.py` `ExternalMessage` conversion | Stable; isolated active-turn join measured below; excluded from the production adapter |
| `turn/steer` | Explicit steer helper | Excluded from the adapter; Appendix A retains its separate primitive measurement |

The TS implementation must retain notifications that arrive before the
`turn/start` response binds a turn id, and drain retained events before ending
a per-turn consumer. The persistent process reader must survive that consumer's
completion. Thread id, app-server turn id, host turn token, JSON-RPC request id,
and client user-message id remain separate identities.

Do not copy the Python client's default command/file approval acceptance
handler. Keep approval `never` and reviewer `user`, and reject unexpected
approval requests with a diagnostic. Its default `experimentalApi: true` is
also unnecessary for the surface measured here. Account login, goal management,
fork, and archive APIs are not migration requirements merely because the
reference SDK exposes them.

### Isolated procedure and observations

The temporary Node driver launched the resolved binary directly with
`--config approvals_reviewer="user" --config approval_policy="never"
app-server --listen stdio://`. Each child had an isolated `HOME` and
`CODEX_HOME`, no `auth.json`, and only `PATH`, `HOME`, `CODEX_HOME`, and `LANG`
in its environment. Its fixture `config.toml` deliberately retained
`approvals_reviewer = "auto_review"`; a local Responses provider and
`[analytics] enabled = false` were configured, with shell snapshots disabled.
The thread used a read-only sandbox. The driver was configured to reject unexpected server
requests; none occurred.

The final run used `unshare --user --map-root-user --net`, enabled only `lo`,
and had no network route. The fake provider ran inside that namespace at
`127.0.0.1`, returning fixed Responses SSE events. Thus this run required
neither external model service nor authentication. It proves protocol and
routing behavior, not model reasoning or real tool execution. It does not
prove the CLI never attempts outward traffic: startup behavior, including
update checks, must still be disclosed in future integration tests. Analytics
was explicitly disabled. This host allowed unprivileged network namespaces;
CI runners need not do so.

Observed results (driver exit 0, checker exit 0):

- One child completed two sequential ordinary turns, then exited 0 on stdin
  close. A second child resumed the same persisted thread, completed another
  ordinary turn and the isolated external-message experiment, then exited 0.
- Four distinct `turn/started` / `turn/completed` pairs, all completed without
  error; five local provider requests and 60 notifications. All four recorded
  rollout turn contexts had approval policy `never` and reviewer `user`.
  The fixture config still contained `auto_review`, and no auth file existed.
- No `turn/steer` request was sent. Each ordinary `turn/start` followed the
  prior terminal event. This demonstrates the probe's serial admission only;
  the production queue/lease behavior is still an adapter implementation gate.
- Initialize latency was 352 ms and 174 ms for the two children. RPC/event
  waits used a 25-second bound and shutdown a 5-second bound. These two samples
  do not establish a CI latency bound.
- Stderr contained only the known temporary-home PATH-helper warning; no
  unknown-config warning, unexpected protocol error, or unhandled exception
  occurred.
- A nonexistent thread id returned error `-32600` and created no extra turn.
  Removing all terminal notifications from the captured trace made the same
  checker exit 1; the conditional subsequent phase executed zero times.

Final evidence retained for review under `/tmp/fuji-348-probe`:

| Artifact | SHA-256 |
| --- | --- |
| `probe.mjs` | `c606d56e627143a342330d38283581dff07cfcc0aaa45066bbe3a3a92a00458f` |
| `check.py` | `ff1c31475fa0ff3f644bd60152f38cd8687ca8c081731d2031a26a948f0375d9` |
| `offline/trace.json` | `ad7a0cb9101670f80cbcf3cbbc8a313a9015c7f85c361a2f24f28451c6337088` |

The driver/checker are disposable probe tools, not shipped adapter code.
The selected capture below preserves the important wire facts after scratch
cleanup. Schema regeneration uses the commands and manifest definition above.

### Selected final capture and ExternalMessage boundary

The first ordinary turn and the isolated external-message experiment used
thread `01a0b08c-d1d7-7403-831e-1ac09eeea395`. The latter withheld the provider's
response, submitted `input: []` with `toolOutput`, then released the response.
The RPC returned the **existing** turn id. The CLI emitted a
`functionCallOutput` item between two `agentMessage` items with phase
`final_answer`, followed by one terminal notification. `thread/read` with
`includeTurns: true` retained all four items: user message, first answer,
function output, second answer. The terminal's `itemsView: "summary"` contained
only the last answer. It cannot replace the accumulated item stream when
projecting results or restoring history.

This is tool-level external content, not user authorization. The experiment
shows the wire representation and active-turn membership; it does not enable
IA steering or prove that an in-flight model request was interrupted.

```jsonl
{"direction":"send","message":{"id":3,"method":"turn/start","params":{"threadId":"00000000-0000-0000-0000-000000000000","input":[{"type":"text","text":"invalid","text_elements":[]}]}}}
{"direction":"receive","message":{"error":{"code":-32600,"message":"thread not found: 00000000-0000-0000-0000-000000000000"},"id":3}}
{"direction":"send","message":{"id":4,"method":"turn/start","params":{"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","input":[{"type":"text","text":"first","text_elements":[]}],"approvalPolicy":"never","approvalsReviewer":"user"}}}
{"direction":"receive","message":{"id":4,"result":{"turn":{"id":"01a0b08c-d1e7-72a1-932d-3fc02902981d","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}}
{"direction":"receive","message":{"method":"item/completed","params":{"item":{"type":"userMessage","id":"01a0b08c-d24c-7a02-afa5-141a933cff15","clientId":null,"content":[{"type":"text","text":"first","text_elements":[]}]},"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turnId":"01a0b08c-d1e7-72a1-932d-3fc02902981d","completedAtMs":1789668414028},"emittedAtMs":1789668414033}}
{"direction":"receive","message":{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_1","text":"LOCAL_OK_1","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null},"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turnId":"01a0b08c-d1e7-72a1-932d-3fc02902981d","completedAtMs":1789668414214},"emittedAtMs":1789668414218}}
{"direction":"receive","message":{"method":"turn/completed","params":{"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turn":{"id":"01a0b08c-d1e7-72a1-932d-3fc02902981d","items":[{"type":"agentMessage","id":"msg_1","text":"LOCAL_OK_1","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null}],"itemsView":"summary","status":"completed","error":null,"startedAt":1789668413,"completedAt":1789668414,"durationMs":300}},"emittedAtMs":1789668414232}}
{"direction":"receive","message":{"method":"item/completed","params":{"item":{"type":"userMessage","id":"01a0b08c-e798-79c1-981b-9fdd13545165","clientId":null,"content":[{"type":"text","text":"external observation base","text_elements":[]}]},"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turnId":"01a0b08c-e77c-7dd0-a1fe-830bcefae88c","completedAtMs":1789668419480},"emittedAtMs":1789668419486}}
{"direction":"send","message":{"id":11,"method":"turn/start","params":{"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","input":[],"toolOutput":{"name":"probe_external","output":"UNTRUSTED_EXTERNAL_348"}}}}
{"direction":"receive","message":{"id":11,"result":{"turn":{"id":"01a0b08c-e77c-7dd0-a1fe-830bcefae88c","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}}
{"direction":"receive","message":{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_4","text":"LOCAL_OK_4","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null},"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turnId":"01a0b08c-e77c-7dd0-a1fe-830bcefae88c","completedAtMs":1789668419519},"emittedAtMs":1789668419523}}
{"direction":"receive","message":{"method":"item/completed","params":{"item":{"type":"functionCallOutput","id":"fco_01a0b08c-e7bd-7010-9455-ac6128828227","name":"probe_external","namespace":null,"output":"UNTRUSTED_EXTERNAL_348"},"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turnId":"01a0b08c-e77c-7dd0-a1fe-830bcefae88c","completedAtMs":1789668419534},"emittedAtMs":1789668419537}}
{"direction":"receive","message":{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_5","text":"LOCAL_OK_5","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null},"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turnId":"01a0b08c-e77c-7dd0-a1fe-830bcefae88c","completedAtMs":1789668419716},"emittedAtMs":1789668419720}}
{"direction":"receive","message":{"method":"turn/completed","params":{"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turn":{"id":"01a0b08c-e77c-7dd0-a1fe-830bcefae88c","items":[{"type":"agentMessage","id":"msg_5","text":"LOCAL_OK_5","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null}],"itemsView":"summary","status":"completed","error":null,"startedAt":1789668419,"completedAt":1789668419,"durationMs":278}},"emittedAtMs":1789668419735}}
```
