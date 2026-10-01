---
title: "Issue 464: native Codex home isolation on 0.159.3"
status: recorded
last_updated: 2026-10-01
---

# Native Codex home isolation on 0.159.3

Tracking: [issue #464](https://github.com/sakuraiyuta/kaoiro/issues/464).
Design: [home isolation](../../plans/issue-464-codex-home-tool-isolation.md).
The [machine-readable record](codex-home-isolation-native-0.159.3-2026-10-01.json)
binds source, built output, binary, native traces, logs, and rollout hashes.

## Bound execution and status

Source: `38bed7e0516d06e5e83263115b6cb62f4da32ea0`, branch
`issue-464-codex-home-isolation-pin`. Native binary: **0.159.3**, SHA-256
`8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`.
The default built runner launcher started the actual built wrapper and native
Codex CLI. Forwarding observation hooks recorded child environments, RPCs,
and actual native command output. The loopback project-server endpoint was a
Phoenix protocol fixture. Native tool calls used a local provider first, then
the authenticated default ChatGPT provider.

**Approved pre-landing gates passed.** The director limited Claude Code and
Antigravity gates to real child-process boundaries and mutation evidence.
Their native model-driven tool execution remains unmeasured and is assigned
to post-deployment confirmation; authenticated turns on those engines are
outside this authorization.

All Codex processes explicitly used the authenticated scratch state home
`~/.local/share/kaoiro-scratch/codex-468-v1593`; every probe had a disposable
operator HOME. Production state and credentials were untouched. Test commands
started with `env -u CODEX_HOME`; native invocations explicitly set scratch.

## Results

| Gate                                          | Cases / tests         | Exit code | Observation                                                                                                                          |
| --------------------------------------------- | --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Native local Codex exec                       | 1                     | 0         | CLI sees state home; actual shell sees private home; marker and existing exclusion/set policy preserved; hook runs; cleanup succeeds |
| Native local app-server start                 | 1                     | 0         | thread/start carries private home A; actual shell reports A; state-home session and model-profile hook valid                         |
| Native local app-server resume, forced exit   | 1                     | 0         | Same native thread; thread/resume carries new home B; actual shell reports B; fresh hook marker; forced-child cleanup removes B      |
| Authenticated exec / start / resume           | 3                     | 0 each    | gpt-6-luna / low; all complete; native shell markers, hooks, policy and cleanup pass                                                 |
| Home ownership and Vitest preflight           | 10 passed             | 0         | Three Codex files                                                                                                                    |
| Default built launcher boundary               | 8 passed              | 0         | All three engines; Codex tool-home override cannot select the state home                                                             |
| Claude SDK and real-process boundary          | 2 passed, 308 skipped | 0         | SDK env filter and real SDK child lifecycle                                                                                          |
| Restored Claude env filter                    | 1 passed, 305 skipped | 0         | Caller-supplied env remains filtered                                                                                                 |
| Restored Antigravity default child boundaries | 1 passed, 130 skipped | 0         | Discovery, registration and turn OS processes receive no CODEX_HOME                                                                  |

The authenticated app-server start and resume share the native thread
`01a0f6dc-a761-7130-b9ea-e5474376a23d`. The second wrapper owns a different
private tool home. Native output and the live marker are checked before
wrapper shutdown; after shutdown that home is absent. The exec turn has its
own native state-home rollout. Completed ChatGPT turns establish turn-time
authentication; login-status output is not used as a substitute.

The real model-profile hook and resolver ran against a disposable `gpt-6`
profile. Native `hooks/list` supplied the current trust hashes. Before each
start/resume probe the disposable operator-HOME marker was cleared, so the
resumed turn's marker demonstrates a new hook invocation.

Exactly **3 authenticated turns** were used on this branch. Across the separate
phase-3 branch and this branch, the ledger records **5 of the approved maximum
7**, no retries, and one actual native turn start per attempt.

## Negative controls

Removing the exec shell-policy setting from the built Host makes the actual
native tool write `FUJI464` into the scratch **state home** instead of the
private home. The gate invocation exits **1**. Removing the app-server
thread-policy setting has the same observed effect and exit **1**. Both
canaries were read, removed, and the built artifacts restored before final
positive runs. The live confirmations use the restored artifacts.

Each runner, Claude Host, Antigravity turn, and Antigravity discovery filter
was removed independently: its targeted test exited **1**. Restored targeted
checks then exited **0**. Those are boundary tests; they do not claim actual
Claude or Antigravity model-driven tool execution.

With a hostile disposable inherited home, the Vitest preflight invocation
exits **1**, executes no sentinel, and leaves the canary unchanged. Removing
that import makes the sentinel test execute and write its observation marker
(**1 passed**, exit **0**); the enclosing preflight test then exits **1**.
The actual test-execution marker and test count distinguish bypass from a
configuration failure before collection. Neither path writes the canary.
Removing a native trace's tool-home separation, marker, cleanup, or state-home
fact also makes the observation checker fail.

## Limits, failures, and retention

Claude Code measurements reach the real SDK child boundary; the environment
assertion uses the supplied SDK options. Antigravity measurements reach real
OS children with a fixture executable. Native model-driven tool shells for
these engines remain unmeasured and are deferred to post-deployment
confirmation under the director's accepted scope decision.

Remaining confirmation: after issue 464 lands and the runner is updated, the
director will ask a Claude Code peer and an Antigravity peer to execute
`printenv CODEX_HOME` once in their tool shells and require an empty value,
then require a Codex peer's tool shell to report its isolated private home.

An earlier disposable probe used a TMPDIR path too long for a Unix socket.
It failed before model-provider execution, with zero authenticated turns;
its full log is retained. Short dedicated temporary paths fixed the harness.
The first local-provider attempt also failed because its handler parsed an
empty native models GET as JSON; explicitly handling that GET fixed the probe.
Its complete `local-exec.log` is retained and bound in the JSON.
The initial local batch also stopped on a disposable result-field extraction
error after successful exec/start gates; the resumed gate was then measured
using the actual envelope session ID. Final records include all three positive
native local results from the restored build.

The Claude real-process test emitted the known
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning. Positive native and live Codex runs
emitted no unhandled errors or warnings. Deliberate policy/preflight failures
are retained as negative evidence.

Raw artifacts remain at `tmp/reviews/issue-464/fuji-native-pin/` for review
(about 3.6 MiB at collection). Owned temporary socket trees were removed;
private tool homes were removed by runner cleanup. Temporary state-home
configuration, probe profiles, and mutation canaries were removed. Existing
authentication and native rollouts remain in the shared authenticated scratch
home. Evidence commits change no product sources.
