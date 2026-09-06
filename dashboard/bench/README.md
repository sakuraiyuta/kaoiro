# #174 input-latency bench

Measures composer input latency in a real Chromium (Playwright), comparing
`src/lib/AgentDetail.svelte` (after the #174 render-window fix) against a
pinned pre-#174 baseline (commit `37e89a3640a02fbd4524a0f36630d8e8e0db0c38`,
the commit immediately before the fix landed). `runBench.mjs` materialises
that baseline on the fly as `src/lib/.AgentDetail.before.bench.svelte` via
`git show <SHA>:...` right before starting the dev server, and deletes it
when the run finishes — it is gitignored and never a tracked file (ふじ
round-2 S2: a permanent copy under `src/lib/` reads as shipped code and
drifts silently from its cited baseline). Not wired into CI; re-run manually
whenever the window logic changes.

## Setup (once per machine)

```bash
PATH="$HOME/.asdf/shims:$PATH" pnpm exec playwright install chromium
```

## Method

`harness.ts` mounts one of the two component variants (`?variant=before|after`)
with `count` synthetic assistant log entries (`?count=`), each carrying a
short markdown paragraph so the transcript DOM is non-trivial per entry (this
was never about mermaid specifically — the #174 report's mechanism is the
per-entry markdown HTML, mermaid is just one contributor). A listener on the
composer `<textarea>`'s `input` event records `performance.now()` and resolves
the sample on the next `requestAnimationFrame` — i.e. "time from keystroke to
next painted frame", which is where a forced layout/style recalc over a huge
transcript DOM would show up.

`runBench.mjs` boots a throwaway Vite dev server, drives both variants with
Playwright, and reports `avg` / `median` / `p95` / `max` per variant. Two
typing modes:

- **`plain`**: types the character `a` repeatedly. Round-1 code review
  established that a plain keystroke does NOT itself force a transcript
  reflow (Svelte 5 fine-grained reactivity only touches the `instruction`
  `$state`) — this mode measures the ambient cost of a huge DOM being
  present, not a specific trigger.
- **`slash`**: types `/` then Backspace repeatedly, toggling the slash-command
  menu open/closed. This is the concretely-identified mechanism: opening the
  menu inserts a `<ul>` sibling in-flow inside the same scrollable container
  (`.log`) as the transcript, forcing the browser to lay out that whole
  container — exactly what the render window is meant to shrink.

```bash
PATH="$HOME/.asdf/shims:$PATH" node bench/runBench.mjs <count> <keystrokes> <mode>
# e.g.
PATH="$HOME/.asdf/shims:$PATH" node bench/runBench.mjs 5000 30 slash
```

Results are also written to `bench/results/inputLatency-<mode>-<count>.json`.

## Results (2026-08-03, this machine)

| mode  | count | before avg/median (ms) | after avg/median (ms) |
|-------|------:|------------------------|------------------------|
| plain |  1000 | 3.0 / 2.4               | 3.8 / 0.9               |
| plain |  5000 | 9.9 / 9.0               | 4.2 / 1.0               |
| slash |  1000 | 8.1 / 9.1               | 5.1 / 3.1               |
| slash |  5000 | 35.9 / 35.8             | 5.7 / 4.7               |

Honest read: at the issue's baseline size (1000 entries) with plain
character typing, the two variants are within noise of each other — the
render window does not measurably help THAT specific interaction at THAT
scale, matching the round-1 finding that a plain keystroke has no direct
reflow trigger. The window clearly helps in the two cases that were actually
identified as costly: the slash-menu toggle (the concrete reflow trigger, at
both 1000 and 5000 the after variant is faster and far more stable — before
degrades roughly linearly with history size, ~8ms at 1000 to ~36ms at 5000,
while after stays ~5ms regardless of history size) and plain typing once
history grows past the issue's stated floor (5000: before nearly 10ms avg,
after under half that). Sample size is modest (30-60 samples per cell,
single machine, single run) — treat these as directional, not
statistically rigorous.

## App-level bench (candidate A, error-index scan)

`runBenchApp.mjs` mounts the real `src/App.svelte` (via `harnessApp.ts`
and a fake `phoenix` transport, `fakePhoenix.ts` aliased in only by
`vite.harness.config.ts`) instead of `AgentDetail.svelte` alone, so it can
drive multi-agent state, live receive ticks, and the error-index scan
(App.svelte's `errorIndex`). Compares the current worktree ("after")
against a pinned baseline immediately before the error-index feature
landed ("before"), materialised the same generate-then-delete way as
`runBench.mjs` above (`src/.App.before.bench.svelte`).

```bash
PATH="$HOME/.asdf/shims:$PATH" node bench/runBenchApp.mjs \
  <agentCount> <historyCount> <keystrokes> <tickMs> <errorAgents> [runLabel]
# e.g. the catastrophic case (candidate A's own reproduction recipe)
PATH="$HOME/.asdf/shims:$PATH" node bench/runBenchApp.mjs 5 5000 30 100 none
# repeated runs of the SAME scenario for a median: give each an explicit
# label, or the same filename gets silently overwritten each time
PATH="$HOME/.asdf/shims:$PATH" node bench/runBenchApp.mjs 5 5000 30 100 none run1
PATH="$HOME/.asdf/shims:$PATH" node bench/runBenchApp.mjs 5 5000 30 100 none run2
PATH="$HOME/.asdf/shims:$PATH" node bench/runBenchApp.mjs 5 5000 30 100 none run3
```

- `agentCount`: total agents seeded (1 viewed + `agentCount-1` background).
- `historyCount`: synthetic transcript length per agent.
- `keystrokes`: composer keystrokes typed.
- `tickMs`: interval between live-log receive ticks, sent to the viewed
  agent and one background agent at this same frequency each tick.
- `errorAgents`: `"all"` or `"none"` — whether every seeded agent's history
  ends with an `is_error` result.
- `runLabel` (optional): appended to the result JSON and trace filenames
  (e.g. `-run1`) so repeated runs of the same scenario land in separate
  files instead of overwriting each other. Omit for a single run.

Each run also types `/` into the composer and confirms `.slash-menu`
actually appears before measuring (the seeded `ext.slash_commands` alone
only wires the data the menu needs; this is the observation that it
renders).

Results are written to `bench/results/candidateA/candidateA-agents<N>-hist<N>-tick<N>-err<mode>[-<runLabel>].json`,
plus one Playwright trace per variant. **The invocation exits non-zero**
(not just an `error` field in the printed JSON) when either variant:

- fails to mount/measure at all (harness error),
- the slash menu never appears,
- the typing loop does not finish all requested keystrokes,
- a required measurement (DOM node count) comes back missing,
- reading back the rAF latencies / Event Timing / Long Tasks arrays from
  the page itself failed (`page.evaluate()` rejected -- distinct from
  those arrays legitimately being empty; the harness tracks this
  separately so a read failure can't be mistaken for "0 samples"), or
- at least one keystroke completed but the rAF latency probe recorded
  ZERO samples -- this is the wiring-failure case specifically (the
  probe's `input` listener never fired), not a legitimate empty result.

Event Timing / Long Tasks are NOT held to that last rule: a fast run can
legitimately produce zero events over the 16ms threshold or zero long
tasks, so an empty array there is not itself a failure. Performance
itself (long task counts/durations) has no automatic pass/fail
threshold — read the printed numbers.

To confirm the exit-code behavior yourself (catching a rejection into
the saved JSON is not enough on its own, the exit code is what actually
gates):

- **Harness error**: temporarily make `window.__bench.waitReady()`
  reject inside `harnessApp.ts`, run the command above, and check
  `echo $?` is non-zero.
- **Measurement read failure**: temporarily insert `await page.close()`
  in `runBenchApp.mjs`'s `measure()` right after `domCountAfter` is read
  (before the `latencies`/`eventTimings`/`longTasks` reads), run the
  command above, and check `echo $?` is non-zero.
- **rAF probe wiring failure**: temporarily change the event name
  `armLatencyProbe` listens for (e.g. `"input"` -> `"nope"`) so it never
  fires, run the command above (with a non-zero `<keystrokes>` so at
  least one keystroke completes), and check `echo $?` is non-zero.

When testing exit codes, check `$?` from a plain `cmd; echo $?` (or
`cmd > log 2>&1; echo $?`) -- piping the command's output through
another one (e.g. `cmd | tail`) makes `$?` report THAT command's exit
code instead, not the bench's.

### Reading `domNodeCount`

`harnessApp.ts` imports the real `src/app.css` (mirroring `src/main.ts`,
so the harness page's layout matches production instead of browser
defaults). Loading it made the `.log` transcript container an
actual scrollable region for the first time in this harness, so the
rendered row count is no longer fixed the way it was before: it settled
around 200 rows without the real CSS (matching #174's render-window
design exactly) but around 232/231 with it, because a real scroll
position now exists for that window logic to anchor against. This is a
CSS-driven rendering difference, not a product regression -- don't read
`domNodeCount` across runs as "the same fixed DOM"; the actual row count
also depends on receive-tick volume and how much has scrolled by the
time it's measured. What stays meaningful is the before/after DELTA
within a single run (candidate A's own before/after comparison), not the
absolute count.
