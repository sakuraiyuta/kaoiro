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
