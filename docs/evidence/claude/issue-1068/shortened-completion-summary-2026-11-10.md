---
title: How CLI 2.1.321 shortens a completion summary, and what the continuation proof accepts
status: measured
last_updated: 2026-11-10
description: The dated record behind the fix for issue 1068 — the rule by which Claude Code CLI 2.1.321 shortens a background completion summary over 1,000 characters, measured for Bash and Monitor completions without real-model turns, with the controls, the captured fixtures and the limits.
---

# How CLI 2.1.321 shortens a completion summary, and what the continuation proof accepts

This record covers [issue #1068](https://github.com/sakuraiyuta/kaoiro/issues/1068).
It corrects the rule stated in the
[SDK 0.3.321 bump record](../issue-1063/sdk-0.3.321-2026-11-10.md#a-regression-on-long-background-command-labels)
and holds the measurements the fix was designed on. The contract that follows
from it is in
[Claude events](../../../reference/engines/claude-events.md#shortened-completion-summaries).

Everything below is bound to the commits and the native executable named
here. The measurements ran on 2026-11-10 with a scripted provider on loopback
and no network: zero real-model requests.

| Item | Value |
|---|---|
| Measured commit, new pin | `4bf7767e8eff439a440a10ab33ac0918060f44ac` (SDK 0.3.321 / CLI 2.1.321) |
| Measured commit, previous pin | `6bdc90155feb5d2831507ad7573f4352f2851705` (SDK 0.3.319 / CLI 2.1.319) |
| Native `claude` (linux-x64), 2.1.321 | sha256 `426c33815ca6645a772f722fbff10dbf2cbdb124a8aeab733c1365dbf8bbf61f` |
| Test image | `sha256:56cfd9fbe740e78f5d6d219772b6f5f7ba08424bf449f688b1a2597eebd469b8` |

## The rule

The CLI shortens the **whole summary** of a completion notification, not the
label inside it. With `S` the summary the SDK reports in its
`task_notification` frame, the block the model sees carries:

- `S` unchanged when `S.length <= 1000` (UTF-16 code units);
- otherwise the first 500 and the last 300 code units of `S` around
  `\n\n... [N characters truncated] ...\n\n`, where N is the number of code
  units dropped;
- one code unit less at the head or at the tail where the cut would split a
  surrogate pair, so that N grows by one for each;
- the result escaped (`&`, `<`, `>`) after it is shortened, so N counts
  characters before escaping.

A Monitor **event** notification is not shortened; only completions are.

The rule was first read from the script embedded in the native executable
above (minified names carry no meaning):

```js
function TX(e){return e.length>1000?pF(e,500,300,Nzn):e}
function pF(t,n,e,r){if(t.length<=n+e)return t;let i=n>0?Q(t,n):"",o=e>0?Ia(t,e):"";
  return`${i}${r(t.length-i.length-o.length)}${o}`}
function Nzn(e){return`\n\n... [${e} characters truncated] ...\n\n`}
```

`Q` and `Ia` take the head and the tail and drop a trailing high or a leading
low surrogate. The completion builder passes `TX(summary)` to the function
that writes the `<summary>` field; the Monitor event builder does not call
`TX`. The reading alone is not the evidence: the table below is.

## Measured notifications

Each row is one run of a case of
`monitor_notification_advice_native.test.ts` (`bash-idle`,
`completion-response` or `event-inform`) with the tool's `description`
replaced inside the run. `S` is the SDK frame's summary and `b` the block's
summary, both read at the comparison in the built
`dist/continuation_proof.js` through a line added inside the run. "Predicted"
is `b === escape(shorten(S))`, computed afterwards by a function written
apart from the one used in the run.

| Run | Pin | Source and label | `S` length | `b` length | Shape of `b` | Predicted | Unchanged proof |
|---|---|---|---:|---:|---|---|---|
| A1 | 0.3.321 | Bash, description of 955 | 1,000 | 1,000 | whole | yes | bound |
| A2 | 0.3.321 | Bash, description of 956 | 1,001 | 838 | 480 of the label, N = 201, 275 of the label | yes | refused |
| A3 | 0.3.321 | Bash, description `<&>` × 400 | 1,245 | 3,355 | escaped after shortening, N = 445 | yes | refused |
| A4 | 0.3.321 | Bash, a surrogate pair across each cut | 1,102 | 836 | head 499, tail 299, N = 304 | yes | refused |
| A5 | 0.3.321 | Bash, no description, command of 1,339 | 1,384 | 844 | N = 584 | yes | refused |
| B1 | 0.3.321 | Monitor completion, description of 15 | 104 | 104 | whole | yes | bound |
| B2 | 0.3.321 | Monitor completion, description of 1,200 | 1,289 | 838 | 491 of the label, N = 489, 220 of the label and the marker | yes | refused |
| B7 | 0.3.321 | Monitor event, description of 1,200 | not read | 1,283 | whole | not applicable | bound |
| C1 | 0.3.319 | Bash, description of 1,200 | 1,245 | 1,245 | whole | not applicable | bound |
| C2 | 0.3.319 | Monitor completion, description of 1,200 | 1,289 | 1,289 | whole | not applicable | bound |
| C3 | 0.3.319 | Monitor event, description of 1,200 | not read | 1,283 | whole | not applicable | bound |

"Refused" is `native continuation refused: native_completion_unproved`, no
message sent and `unbound_tool_call`; "bound" is one message sent. A Monitor
description carries the registered continuation marker (66 characters with
its leading space), which is part of the label the CLI sees.

The label figures in the earlier record, "the first 480 and the last 275
characters of the label", are what the rule looks like for a successful Bash
completion, whose summary `Background command "<label>" completed (exit code
0)` has a 20-character prefix and a 25-character suffix. B2 shows another
share for a Monitor completion (`Monitor "<label>" stream ended`: 9 and 14).

Each element of the rule was varied in the prediction to show it is not met
by coincidence:

| Varied element | Rows the varied prediction misses |
|---|---|
| limit 999 instead of 1,000 | A1 |
| limit 1,001 | A2 |
| head 499, or tail 299 | A2, A3, A5, B2 (A4 gives the same value because of the surrogate rule) |
| escape before shortening | A3, A5 and the Monitor run with `<&>` × 400 below |
| shorten the label alone to 480 + 275 | A4, B2 |

## The comparison was prototyped in the run

The same runs swapped the comparison in the built proof by an environment
variable, to test the design before any source changed:

| Run | Source and label | Comparison in the run | Result |
|---|---|---|---|
| A8 | Bash, description of 1,200 | accept the whole or the shortened form; Monitor description checked against `S` | bound |
| A9 | Bash, surrogate pairs | same | bound |
| A10 | Bash, `<&>` × 400 | same | bound |
| A11 | Bash, description of 1,200 | shortened form built with a head of 499 | refused |
| B3 | Monitor completion, description of 1,200 | shortened form accepted, description still checked against the block | refused: `native_monitor_description_mismatch` |
| B4 | Monitor completion, description of 1,200 | accept either form; description checked against `S` | bound |
| B5 | Monitor completion, `<&>` × 400 | same | bound |
| B6 | Monitor completion, description of 1,200 | shortened form built with a head of 499 | refused |

B3 is why the fix moves the Monitor description check: a shortened block
still shows the marker but no longer the whole description, so the check
against the block fails on every shortened completion.

## The matcher used when native continuations are off

With `KAOIRO_CLAUDE_NATIVE_CONTINUATIONS=0` the wrapper does not call the
proof and compares the same two strings in `host.ts`.

| Run | Label | Result |
|---|---|---|
| A6 | Bash, description of 15 | one message sent |
| A7 | Bash, description of 1,200 | no message sent, `unbound_tool_call` |

No line about a fail-stop appeared in A7. What that path does when such a
completion arrives during a live wrapper turn was not measured.

## Runs

All in the remote heavy-test slot, class `test`. Every run's outcome matched
the prediction made before it: 22 of 22.

| Set | Commit | Run | vitest results |
|---|---|---|---|
| A, 11 runs | `4bf7767e` | `kohaku-4bf7767-l1068a-1110130624-414f.3e16f47a7a3390ce` | 5 passed, 6 failed |
| B, 7 runs | `4bf7767e` | `kohaku-4bf7767-l1068b-1110130624-614f.78bc14270febf34f` | 4 passed, 3 failed |
| C, 4 runs | `6bdc9015` | `kohaku-6bdc901-l1068c-1110130834-41bd.292b68d08a8e296f` | 4 passed, 0 failed |

A run that predicted a refusal ends in a failed case, because the committed
assertion expects one message; the nine failures are those nine predictions.
The slot's summary reported `pass` for all three sets, which reflects only
the last command of the body, so each run was judged by its own exit status
and printed outcome.

The committed files were not changed for these measurements. The edits lived
inside each run: the `description` of the scripted tool call, the
`KAOIRO_CLAUDE_NATIVE_CONTINUATIONS=0` variable for A6 and A7, a line printing
the outcome before the final assertion, and the lines in the built
`dist/continuation_proof.js` that printed `S` and `b` and selected the
prototype comparison. The throwaway scripts are not kept.

## Captured fixtures

`wrapper/claude-code/test/fixtures/claude-cli-2.1.321-completion-summaries.json`
holds the `S` and `b` of A1, A2, A3, A4, A5, B2 and of the Monitor run with
`<&>` × 400, as the CLI and the SDK produced them. Only the continuation
token of the two Monitor pairs was replaced, in both strings, by a
placeholder of the same length; shortening depends on positions alone, so
the pair keeps its relation. The unit tests compare the product function
against these pairs and build their rejected variants from the captured `b`.

## Limits

- Measured: successful Bash completions and Monitor completions that ended
  with their stream. **Not measured**: Workflow completions, failed
  completions, stopped or killed tasks. The proof accepts a shortened form
  only when it is byte-equal to the one derived from `S` by the rule above,
  so a different form from one of those sources is refused, not accepted.
- A label containing an unpaired surrogate was not measured. The CLI passes
  the kept head and tail through a UTF-16 round trip that kaoiro does not
  reproduce; a difference there is refused.
- An Agent's `<result>`, a TaskStop tool result and the quiet check-in
  notification were not examined.
- The rule is that of CLI 2.1.321. The two long-label cases added to
  `monitor_notification_advice_native.test.ts` run against the installed CLI
  and fail when it shortens differently; that file's version guards force
  them to run on every pin change.
- The server's journal and a production peer were not observed.
