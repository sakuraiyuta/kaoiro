---
title: Antigravity 1.5.14 native acceptance over ACP
status: measured
last_updated: 2026-11-23
---

# Antigravity 1.5.14 native acceptance over ACP

The opt-in acceptance test of the ACP host
([ADR-0078](../../adr/0078-antigravity-over-acp.md),
[issue #1238](https://github.com/sakuraiyuta/kaoiro/issues/1238)) drove the
real `agy` against the provider on 2026-11-23. The test is
`wrapper/antigravity/test/acp_native.test.ts`; the raw log is kept outside
the repository and is available on request.

## Conditions

| Item | Value |
|---|---|
| Code | commit `dd0d094d` for the first run (the host as of `69712d4a`); commit `8578dc6f` for the one retry of N9, which changed only that case's command |
| `agy` | 1.5.14, run from a read-only copy; sha256 `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94` before and after the run |
| Model | `gemini-3.1-flash-lite-preview`; `agy` offers it no thinking level, so none was set |
| Authentication | a service-account key through ADC (`AGY_ADC_AUTH=true`, `GOOGLE_APPLICATION_CREDENTIALS`); the key's contents were not read |
| Isolation | private user, mount and pid namespaces. The user's real home and the session bus were hidden behind empty mounts; a fresh HOME under the user's home, the worktree and the key directory (read-only) were the only visible parts. A probe inside the namespaces saw neither the real `agy` settings directory, nor the installed `agy`, nor the session bus, all of which exist outside; the key file was readable and not writable |
| Composition | the production CLI with a stand-in server link; host and gate from their defaults. The test wrapped the gate's handlers, the spawn and the tool host only to record what they did |
| Redaction | all output passed a credential-shape filter before it was written; planted fake bearer, access-token, API-key and JWT values were masked and a plain line was kept |
| Prompts | 13: 12 in the first run (90.9 s for the whole file) and 1 for the N9 retry. Token counts were not recorded |

## Results

Verdicts come from the gate, operator-dialog, wire and workspace records,
never from the model's prose. Each judge has negative controls that run
without the opt-in (a passing record, failing records, a record without the
call the case needs).

| Case | Cell | What happened | Verdict |
|---|---|---|---|
| N1 operator rejection, turn goes on | workspace-write, on-request, network on | `run_command` asked; the operator stand-in rejected it; the hook answered deny; the turn ended with a result | pass |
| N2 read-only write | read-only | `write_file` denied by the gate; no file written; result | pass |
| N3a network off | workspace-write, on-request, network off | `run_command` denied without a dialog; no file written; `agy` launched with `--sandbox` | pass |
| N3b network on | workspace-write, on-request, network on | `run_command` asked and was approved; the command wrote its file; `agy` launched with `--sandbox` | pass |
| N4 `BypassSandbox` | workspace-write, on-request, network on | `run_command` with `BypassSandbox: true` asked and was approved; the command wrote its file | pass |
| N5 kaoiro tool | workspace-write, on-request, network off | `mcp_kaoiro_whoami` allowed with no dialog; result | pass |
| N6 background output | danger-full-access, never | `run_command`, two Stop requests answered `continue` while the model polled with `manage_task` and read the output, then `stop`; the command's output was in the reply | pass |
| N7 subagent report | danger-full-access, never | `invoke_subagent`; the subagent's own calls arrived with another conversation ID (`send_message` denied as agent-internal, `mcp_kaoiro_*` allowed); two `continue`, then `stop` for the subagent's and the parent's loops; the report text was in the reply | pass |
| N8 cancel during a subagent | danger-full-access, never | the interrupt came once the subagent's `run_command` hook was seen; the turn ended `interrupted`; no `agy` process was alive afterwards | pass |
| N9 cancel during a held prompt | danger-full-access, never | first run (`sleep 120; echo late`): the first Stop request was answered `stop`, so the prompt was never held and the case could not be judged. Retry (`sleep 20; echo kaoiro-n9-done`, same wording): `run_command` allowed, the Stop request answered `continue`, the interrupt ended the turn `interrupted`, and no `agy` process was alive afterwards | pass on the retry |
| N10 permission switch | workspace-write to danger-full-access | the first turn's `agy` had `--sandbox`; after `set_permission` the second turn ran on a new process without it, and the permission state became `applied` | pass |

## Transcript path

The wrapper prints the transcript path
`<HOME>/.gemini/antigravity-cli/brain/<session id>/.system_generated/logs/transcript_full.jsonl`
(`wrapper/antigravity/src/transcript_path.ts`). The HOME listings kept from
the 1.5.14 measurement runs over ACP
([setup](agy-1.5.14-acp-measurements-2026-11-22-setup-and-sessions.md))
were checked against it on 2026-11-23, with no new prompt: in 60 runs that
had both a listing and a session ID on the wire, the file existed at that
path and its directory name equalled a `sessionId` of the same run (60 of
60). Negative control: pairing each listing with the next run's wire log
matched 0 of 60.

## Observations and inferences

- Observed: every hooked call of the parent and of the subagent reached the
  gate; the subagent's calls carried a conversation ID that was not the
  session's, as the design expects (V7).
- Observed: after the first run, 13 files in the disposable HOME held one of
  the 12 tool-host bearers the run minted (`agy`'s own conversation store);
  after the retry, 1 file held its 1 bearer. Each HOME was deleted after the
  scan. A retired generation's bearer authorizes
  nothing, because its tool host is closed.
- Inferred, not measured: in the first N9 run the model started the
  command in a way `agy` did not track as background work (for example a
  shell `&`), so the Stop request reported the loop idle. The plan allowed
  one retry for N4, N6 and N7; one retry of N9 was approved separately, and
  N9 was the only case retried.
