---
title: Antigravity 1.5.14 over ACP — common setup, sessions, models and self-update (2026-11-22/23)
status: measured
last_updated: 2026-11-23
---

# Antigravity 1.5.14 over ACP: setup, sessions, models and self-update

These measurements of `agy` 1.5.14 over ACP are the evidence that the
approved design for
[issue #1238](https://github.com/sakuraiyuta/kaoiro/issues/1238) relies on.
That design runs one `agy acp` process per prompt and adds a Stop hook. They
were taken on 2026-11-22 and 2026-11-23. The record has three files:

- this file: common setup, prompt totals, case index, P0, P5, C2, P10, P7,
  P9, P11 and P4 (with and without `--sandbox`);
- [hooks and turns](agy-1.5.14-acp-measurements-2026-11-22-hooks-and-turns.md):
  P1, P2, P6 (i), C1, D9 and M4;
- [sandbox, teardown and subagents](agy-1.5.14-acp-measurements-2026-11-22-sandbox-and-subagents.md):
  C3, P3 and the subagent cases (P6 (ii)).

Measurement IDs are P0-P11. P8 does not exist; it was dropped in the first
design round. C1-C3, D9 and M4 are design conditions measured under their own
IDs. The authentication measurement for the same binary is a separate record:
[agy-1.5.14-authentication.md](agy-1.5.14-authentication.md).

Each section separates what was observed from what was inferred. A verdict
is positive (the design premise held), negative (it did not) or
undetermined. "Not recorded" means the measurement notes give no value.

## Common setup

The same setup applied to every case unless a section says otherwise.

| Item | Setup |
|---|---|
| Binary | `agy` 1.5.14, sha256 `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94`. Run from a copy in a read-only directory (mode 555). The copy's hash was the same before and after every batch. The 2026-11-23 batches also checked the installed binary against the same hash before and after every run. P4 alone used a writable copy (see P4); its content did not change. |
| Authentication | A service-account key through Application Default Credentials (ADC): `AGY_ADC_AUTH=true` and `GOOGLE_APPLICATION_CREDENTIALS` pointing at the key file, in a dedicated GCP project. The key directory was visible read-only and only its path was passed; the key contents were never read. |
| Isolation | Private user, mount and PID namespaces. The real home and the user runtime directory were hidden by empty tmpfs mounts, so the personal login cache and the session bus were not visible. |
| HOME | A fresh disposable HOME per case, under the user's home (not under the system temporary directory). |
| User | The P3 batch added an unprivileged form to the probe (uid 1000, effective, bounding and ambient capabilities all 0); the notes describe it as the only change from the earlier batches, which ran as uid 0 inside the user namespace. The unprivileged form ran 5 of the 6 P3 runs and every run of the 2026-11-23 batches. The first P3 run and the M4 run with `--sandbox` ran as uid 0. |
| Launch | Production-like: a customization directory with `.agents/hooks.json`; the hook smoke test `agy -p /hooks --add-dir <ws> --add-dir <custom> --output-format json`; `agy acp --add-dir <custom> [--sandbox] --dangerously-skip-permissions`; `initialize`; `session/new` or `session/resume` with an HTTP MCP stub and a per-run bearer; model applied; readiness (`tools/list`). |
| Model | `gemini-3.1-flash-lite-preview`, named in the notes of the P0-C3, D9 and P1-P10 batches; the later notes say flash-lite (the cheapest), with the lowest thinking level from the P3 batch on. The M4 notes do not name the model. |
| Redaction | Every capture passed through a redaction step before it was written, including the per-run MCP bearer. Control, recorded from the P3 batch on: the planted per-run bearer appeared as `<REDACTED:bearer>` in the captures. The subagent and the P4-with-`--sandbox` batches also ran the secret scanner on a file with a planted bearer-shaped value; it found that 1 value each time. |
| Cleanup | After each run the disposable HOME was searched for the run's bearer and deleted. After cleanup, remaining disposable HOMEs, marker files and left-over processes were 0 in every batch (processes that outlived retirement were recorded first, then stopped by PID). |
| Raw data | The redacted raw captures (one log and one metadata file per case) and the disposable probe tools are kept outside the repository. |

Secret scan of the captures (PEM, `private_key`, access token, refresh
token, JWT, API key and literal patterns):

| Batch | Files scanned | Secret-shaped hits | Bearer-shaped hits |
|---|---|---|---|
| P0, C1-C3 | 62 | 0 | 12, all false positives |
| D9 feasibility | 76 (cumulative) | 0 | 19 (7 new), all false positives |
| P1, P2, P9, P10, D9 conditions | 112 (cumulative) | 0 | 37, all false positives |
| M4 | 130 (cumulative) | 0 | 46 (9 new), all false positives |
| P3 and M4 with `--sandbox` | 18 new | 0 in logs | 9 in metadata, all false positives |
| 2026-11-23 pre-approval runs | 30 new | 0 in logs | 15 in metadata, all false positives |
| Subagents | 16 new | 0 in logs | 8 in metadata, all false positives; planted control found |
| P4 with `--sandbox` | 4 | 0 in logs | 2 in metadata, all false positives; planted control found |

Every bearer-shaped false positive was the metadata line that names the
probe's bearer variable (`PROBE_BEARER`), followed by a line break and no
value.

Observed side effect: `agy` stored the MCP server entry, including the
per-run bearer in its Authorization header, in its conversation database in
the disposable HOME (`~/.gemini/antigravity-cli/conversations/<id>.db`).
Where the notes checked it, this held in c1b and every C3 case, all six D9
runs, 16 of 18 cases of the P1-P10 batch (not `r8-p2-smoke`, which has no
session, and not `r8-p10-print`, which has no ACP prompt) and every P3 run.
In `p6-sub-allow` and `p6-sub-deny` the bearer was also in the subagent's
conversation database.

## Prompt totals

Counts are copied from the measurement notes. "Cap" is the prompt limit set
before the batch.

| Batch | Date | Prompts | Cap | Cumulative as written |
|---|---|---|---|---|
| P0, C1, C2, C3 | 2026-11-22 | 30 (P0 1, C1 2, c1b 2, C3 10, C2 15) | not recorded | 30 |
| D9 feasibility | 2026-11-22 | 6 | 10 | 36 |
| P1, P2, P9, P10, D9 conditions | 2026-11-22 | 18 | 25 | 54 |
| M4 | 2026-11-22 | 3 | 5 | 57 |
| P3 and M4 with `--sandbox` | 2026-11-22 | 7 | 10 | 64 |
| Pre-approval runs (P4, P6, P7, P9, P11, M4 plugin sources and race) | 2026-11-23 | 9 | 14 | 73 |
| Subagents | 2026-11-23 | 8 (5 planned, 3 reruns) | 8 | 81 |
| P4 with `--sandbox` | 2026-11-23 | 0 | not recorded | 81 |

Total: 81 prompts. The notes count the authentication measurement's 1 prompt
separately ("31 with it" after the first batch, 37 after D9, 55 after the
P1-P10 batch).

## Case index

| ID | Question | Where | Verdict |
|---|---|---|---|
| P0 | Authentication at each entry point | [P0](#p0-authentication-at-each-entry-point) | Positive |
| P1 | PreToolUse per tool, IDs, order, deny, cancel, timeout | [hooks and turns](agy-1.5.14-acp-measurements-2026-11-22-hooks-and-turns.md#p1-pretooluse-hook-ids-and-order) | Positive; timeout fails closed |
| P2 | Hook discovery | [hooks and turns](agy-1.5.14-acp-measurements-2026-11-22-hooks-and-turns.md#p2-hook-discovery) | Positive |
| P3 | Sandbox scope, approved bypass | [sandbox](agy-1.5.14-acp-measurements-2026-11-22-sandbox-and-subagents.md#p3-sandbox-scope-and-approved-bypass) | Negative for containment under the launch flags |
| P4 | Self-update on an ACP start | [P4](#p4-self-update-on-an-acp-start) | Positive (no updater), with and without `--sandbox` |
| P5 | Rate limits | [P5](#p5-rate-limits) | Recorded only (`groups: []`) |
| P6 (i) | Invalid tool arguments | [hooks and turns](agy-1.5.14-acp-measurements-2026-11-22-hooks-and-turns.md#p6-i-invalid-tool-arguments) | Positive |
| P6 (ii) | Calls inside a subagent | [subagents](agy-1.5.14-acp-measurements-2026-11-22-sandbox-and-subagents.md#subagents-p6-ii-and-the-subagent-runs) | Positive for the hook; other conversation ID |
| P7 | Model values | [P7](#p7-model-values) | Live list positive; fallback snapshot negative |
| P9 | kaoiro MCP: held call, discovery 401 | [P9](#p9-kaoiro-mcp) | Held call cut at 180 s; 401 positive |
| P10 | Resume, persona, print-mode conversations | [P10](#p10-resume-persona-and-print-mode-conversations) | Positive |
| P11 | Leading `/` in a prompt | [P11](#p11-leading-slash) | Positive (text reaches the model) |
| C1 | Long command output before the prompt response | [hooks and turns](agy-1.5.14-acp-measurements-2026-11-22-hooks-and-turns.md#c1-output-of-a-long-command) | Negative |
| C2 | Start time | [C2](#c2-start-time) | Recorded |
| C3 | Commands left after each retirement route | [sandbox](agy-1.5.14-acp-measurements-2026-11-22-sandbox-and-subagents.md#c3-commands-left-after-retirement) | Negative without `--sandbox`; positive with it |
| D9 | Stop hook keeps the prompt open | [hooks and turns](agy-1.5.14-acp-measurements-2026-11-22-hooks-and-turns.md#d9-stop-hook-feasibility) | Positive, with conditions |
| M4 | Effective Stop hook set vs. the listed set | [hooks and turns](agy-1.5.14-acp-measurements-2026-11-22-hooks-and-turns.md#m4-effective-stop-hook-set) | Positive; a list-to-spawn gap exists |

## P0: authentication at each entry point

Launch: one disposable HOME, switched between the ADC environment and an
environment without `AGY_ADC_AUTH` and `GOOGLE_APPLICATION_CREDENTIALS`
("none"). The personal login cache was not visible. Sandbox flag: not
recorded. Hooks: the allow-all PreToolUse hook of the common launch. Model:
`gemini-3.1-flash-lite-preview`. Prompts: 1.

| Entry point | No credentials | ADC | Verdict |
|---|---|---|---|
| `initialize` | Succeeds | Succeeds | Recorded (no authentication needed) |
| `session/new` | `-32000` `Authentication required`, immediately | Succeeds; the response has `sessionId`, `configOptions`, `models`, `modes` | Positive |
| `session/resume` | `-32000` `Authentication required` | Succeeds; the response has `sessionId` (same as requested) | Positive |
| `session/load` | `-32000` `Authentication required` | Succeeds; the response has `sessionId` (same as requested) | Positive |
| `session/prompt` | Sent without attaching: `-32000` `Authentication required` (rejected before the session lookup) | One turn ends `end_turn` (`OK`) | Positive |
| `agy -p /hooks` | Waits 60 s for an OAuth login, exit 1 | Lists the hooks in 1.2 s, exit 0 | The design's second branch: fails, so the runner refuses before spawn |
| `agy -p /usage` | Waits 60 s, exit 1 | Exit 0, `groups: []` (no bucket) | Recorded (input to P5) |
| `agy models` | Quoted from the authentication measurement (listing refused) | Quoted: 38 entries | Quoted |

Also observed:

- `initialize` returned `authMethods` including `oauth-personal`,
  `oauth-business` and `gemini-api-key`, and `agentCapabilities`
  `sessionCapabilities` with `resume`, `close`, `load`, `list` and
  `additionalDirectories`.
- `session/resume` and `session/load` returned `sessionId` (V6).
- In all 3 attaches, the MCP stub received `tools/list` before the
  `session/new`, `session/resume` or `session/load` response.

Not measured: `/hooks` with the network cut (it already fails without
credentials, so the first branch, passing locally without authentication,
does not apply).

## P5: rate limits

No case of its own; no prompts. The only observation is P0's `agy -p /usage`
with ADC: exit 0 and `groups: []`. Fields of a 429 response were not
elicited or measured.

## C2: start time

Launch: `--sandbox`, the smoke test, the HTTP MCP stub, model applied; the
allow-all PreToolUse hook; no Stop hook; `gemini-3.1-flash-lite-preview`.
The same one-word prompt, 5 times per column. Prompts: 15. Start: for A the
moment the first input was ready, for B and C the moment the previous turn
ended and the next input was ready. End: the first delivery confirmation
(the native write callback, the response or the first activity, whichever
came first; the write callback in every run).

| Column | Median | Min | Max | Breakdown (median, approximate) |
|---|---|---|---|---|
| A: first `session/new` | 2,171 ms | 1,893 | 2,522 | Smoke test 1,422; spawn 3-9; `initialize` about 117; `session/new` about 600; model 1-3; readiness 0 (`tools/list` arrived during attach) |
| B: retire, then `session/resume` | 2,679 ms | 2,523 | 2,951 | Retiring the previous process (SIGTERM to exit) 547-712; smoke test 1,202-1,658; `initialize` about 118; `session/resume` about 600; model 1-13 |
| C: same process continues | 0 ms | 0 | 1 | The write callback returns at once |

Observed: all 15 turns ended `end_turn`. Medians without the smoke test,
which runs before spawn: A 737 ms, B 1,421 ms.

Inferred: one process per prompt adds about 2.5-3.0 s per turn when the
smoke test runs every time. The earlier figure in
[issue #377](https://github.com/sakuraiyuta/kaoiro/issues/377) (about 7.5 s
first, about 0.1 s after, `agy` 1.2.7 print mode) used another path and
version and is history only.

## P10: resume, persona and print-mode conversations

Launch: the P1-P10 batch environment (`--dangerously-skip-permissions`,
`gemini-3.1-flash-lite-preview`). Sandbox flag and hooks: not recorded.
Prompts per case: not recorded (18 for the batch).

| Case | Observed |
|---|---|
| `r8-p10-persona` | `session/new` carried `_meta.antigravity.systemPrompt.append` ("answer the marker when asked for the codename"). The new process answered the marker. After retirement and `session/resume`, the next process also answered the marker. The resume response returned the ID; the model was back at the account default `gemini-4-carbon` and was applied again successfully. |
| `r8-p10-print` | One stream-json print-mode turn (22.0 s, `SUCCESS`). ACP `session/resume` attached to that conversation (ID returned, no replay); `session/load` then attached as well, replaying `user_message_chunk`, `agent_message_chunk` and `usage_update` before its response. |

Verdict: positive. Not measured: resuming a conversation created by an older
`agy` version (the print-mode conversation was made by 1.5.14).

## P7: model values

Case `p7-slugs`. Launch: one ACP start without `--sandbox`, attach only, and
one `agy models` run. Prompts: 0. Every slug was sent with
`session/set_config_option` by the design's model and level steps and read
back.

Observed:

- `agy models`: 38 entries, exit 0. All 38 read back as sent.
- The ACP model option offered 16 values.
- The fixed fallback snapshot (the pin in
  `wrapper/antigravity/src/catalog.ts`, used when `agy models` fails) has 18
  entries: 15 are also in the live list and read back; 3 were rejected with
  `-32602` `Unknown model ID`: `gemini-3.1-pro-high`, `gemini-3.1-pro-low`
  and `gpt-oss-120b-medium`.
- Negative control: a value that does not exist was rejected with `-32602`.

Verdict: live list positive; fallback snapshot negative.

Inferred, not measured: the same three values would also fail on today's
stream-json path, so the problem is not specific to ACP.

## P9: kaoiro MCP

| Case | Launch | Prompts | Observed |
|---|---|---|---|
| `r8-p9-mcphold` | P1-P10 batch environment; sandbox flag not recorded | not recorded (18 for the batch) | The stub received `tools/call` (whoami) at 1.268 s and held it. At 181.271 s (180.0 s later) `agy` aborted the HTTP request and sent `notifications/cancelled`. The call was `failed` at 181.277 s; the reply said it timed out after 3 minutes; the response came at 182.68 s, `end_turn`. Also received: two unauthenticated `GET`s under `/.well-known/oauth-protected-resource`, one of them ending in `/mcp` (stub answered 404), `server/discover` (stub answered an error), and `initialize`, `tools/list` and notifications with the bearer. |
| `p9-401` | No `--sandbox`; uid 1000; PreToolUse allow-and-record hook | 1 | The stub applied the shared tool host's checks in its order (Host, Origin, bearer, path, method) and answered both discovery `GET`s with 401 and `WWW-Authenticate: Bearer`. `agy` continued, sent `tools/list` and completed a kaoiro whoami call. Every request had a matching Host and none had an `Origin` header. |

Stub self-test before `p9-401` (no `agy`): unauthenticated `GET` gave 401
with `WWW-Authenticate: Bearer`; authenticated `POST` 200; with `Origin`
403; unauthenticated `POST` 401; another path 404.

Verdict: a held call is cut at 180 s (the call fails, the turn continues);
the discovery 401 is positive. Not measured: a wrong bearer from another
client; the real tool host (both runs used a stub).

## P11: leading slash

Case `p11-slash`. Launch: no `--sandbox`; uid 1000; PreToolUse
allow-and-record hook; flash-lite with the lowest thinking level. Prompts: 3.

| Prompt sent | Reply | Output tokens (thinking) | Observed |
|---|---|---|---|
| `/compact` | (empty) | 1,815 (1,602) | Thinking: looked for a feature for the `/compact` request and found no direct tool. Tried to read its own transcript with `read_file` and failed. Session title "Compact Content Request". |
| `/compact` (leading space) | (empty) | 618 (464) | Thinking only |
| A sentence with `/` inside | `OK` | 38 (37) | Ordinary reply |

Verdict: positive. `/compact`, a command that ACP lists, reached the model
as literal text, with and without a leading space. Only one command was
tried. The plan named `/hooks`; the run used `/compact`.

## P4: self-update on an ACP start

Launch: a writable copy of the binary (about 270 MB) in `wbin/` of the
disposable HOME, with `PATH` set to that copy plus the system binary
directories. `strace -f` followed `agy` and its children (execve, setsid,
setpgid and file writes); the process list was sampled every 100 ms. ACP
start = `initialize` and `session/new`, then a hold, then retirement
(SIGTERM to the process group, 2 s grace). Hooks: not recorded. Prompts: 0
for every P4 case. uid 1000.

| Case | Condition | Processes seen (pid, pgid, sid) | Updater | Writes outside HOME | Copy |
|---|---|---|---|---|---|
| `p4-rw`, `p4-rw2` | Writable copy, ACP start, no `--sandbox`, held 20-25 s | strace (19, 19, 19), `agy acp` (22, 19, 19) only. In `p4-rw2` the only execve was `agy acp` | None. `p4-rw2`: no updater path among the first 120 distinct written paths. `p4-rw`: paths not recorded | 0 | Unchanged |
| `p4-ro` (negative control) | Read-only copy, ACP start | Same | None | 0 | Unchanged |
| `p4-models-rw` (positive control) | Writable copy, `agy models` | `agy models` (22, 19, 19), `agy --bg-updater` (32, 32, 32), `agy --version` (51, 32, 32); `ldd` and `ld-linux` checks ran as the updater's children | Ran in its own session. Created and deleted `~/wbin/.update_test<random>` (twice); wrote `~/.gemini/antigravity-cli/updater/update.lock` and `update_status.json` (rename of a temporary file) | 0 | Unchanged (no update applied) |
| `p4-rw-sb` | Writable copy, `--sandbox`, ACP start, attach only, held 25 s | strace (19, 19, 19), `agy acp … --sandbox` (22, 19, 19) only | None: the only execve was `agy acp`; 0 setsid and 0 setpgid; 0 updater writes | 0 (all 242 writes inside HOME) | Unchanged |
| `p4-models-rw3` (positive control, rerun with the current tool) | Writable copy, `agy models`, held 15 s | `agy models` (22, 19, 19), `agy --bg-updater` (33, 33, 33), `agy --version` (52, 33, 33) | Ran; setsid into its own session. Same `.update_test<random>` create and delete (twice), `update.lock`, `update_status.json` | 0 | Unchanged (no update applied) |

Observed: no ACP start (attach only) started the updater, without
`--sandbox` (`p4-rw`, `p4-rw2`) or with it (`p4-rw-sb`), 1 run each. In both
positive controls the updater ran in its own session and process group, so
a signal to the `agy` process group would not reach it. The `--sandbox`
option reached the spawn (it appears in the recorded spawn arguments).
Start time under strace: 1.62 s to attach with the writable copy, 0.95 s
with the read-only copy (not for direct comparison).

Verdict: positive. Not measured: whether a prompt on a writable copy starts
the updater.

Tool self-tests (no `agy`): the strace write filter classified writes and
deletes under the system temporary directory as outside HOME and writes in
HOME as inside.
