# Typing latency measurement handoff

The five `bench/fuji*.mjs` scripts are snapshots of a local investigation,
not the replacement benchmark or a production gate. They run from `dashboard/`
and write to `/tmp/fuji304-measure/`; create that directory first and do not run
concurrently. The original raw evidence is retained there until review finishes.
No raw profiles or generated bundles are committed.

`bench/runIssue304.mjs` is the replacement gate. It builds the current tree and
the `2ea8f80b` baseline as separate production bundles, instruments the actual
`formatTime` function in those throwaway bundles, and writes one JSON record per
run to `bench/results/issue-304/`. It measures dispatch-to-input as the primary
metric; input-to-rAF remains secondary. Run it from `dashboard/` with
`node bench/runIssue304.mjs`. Its temporary baseline source and bundles are
removed when the invocation finishes; committed JSON is the evidence artifact.

- `fujiMeasure.mjs`: ASCII/native Chromium composition/insertText, production or
  dev harness, raw dispatch/input/rAF timestamps and CPU profiles.
- `fujiShape.mjs`: the same experiment with explicit history expansion and a
  correct `.transcript-entry` row count. Use this for shape-sensitive comparisons.
- `fujiGraph.mjs`: lexical candidates only; shadowing/untrack/event-only paths
  require manual inspection.
- `fujiCounts.mjs`: rejected CDP precise-coverage experiment. Its function call
  counts were inconsistent; do not use them as a count oracle.
- `fujiBodyCounts.mjs`: exact function-entry counter reader for an instrumented
  production bundle. It intentionally asserts the **old** 200 formats/tick;
  it must not be adopted unchanged as an after-fix performance gate.

Example production shape invocation (requires installed dashboard dependencies
and Playwright Chromium):

```bash
mkdir -p /tmp/fuji304-measure
FUJI_PROD=1 FUJI_MATRIX='[{"run":10,"mode":"ascii","tick":100,"history":1000,"expand":true}]' node bench/fujiShape.mjs
```

Run labels must be unique to retain all results. Both latency drivers copy the
current App to the ignored `.App.before.bench.svelte` import and select `after`.
They are not before/after comparison drivers despite that import. They build
unminified production JS with source maps. `fujiMeasure`'s `.log-entry` counter
is stale and always zero; use the shape driver or fix that selector in the new
benchmark. Their summary is dispatch-to-rAF; obtain dispatch-to-input from
`raw.timeOrigin + raw.inputs[index].at - starts[i]`, where `index=i` for ASCII
and insert, and `index=i+floor(i/5)` for the composition-update actions.

The function-body count reader needs the following instrumentation inserted
inside each named function in the generated unminified bundle (not tracked app
source). Preserve a byte copy and restore it after the experiment:

```js
// Substitute the actual function name for NAME.
if (window.__fujiCalls) {
  window.__fujiCalls.counts.NAME = (window.__fujiCalls.counts.NAME || 0) + 1;
}
```

Instrument `formatTime`, `dayKey`, `mergeTranscriptEntries`,
`transcriptEntryKey`, and `compareTranscriptEnvelopes` exactly once each. In
merge also record `window.__fujiCalls.sizes.push([history.length,buffered.length])`
under the same condition. Run `node bench/fujiBodyCounts.mjs` against that
bundle. Remove only the format counter to reproduce the negative control:
exit 1, `format count mismatch`. Counter timings are not latency results.
The exact local instrumentation generator is retained with the raw evidence;
its SHA is recorded below.

## Baseline findings

Measured source: `2ea8f80bcd18aaac2bb6f47b9a685dbcfe3ebb7e`. Linux Ryzen 9 3900X,
Node 24.3.0, Chromium 151.0.7922.34, headless 1440x1000, en-US. Real App and CSS,
fake Phoenix, no real persona asset service, server acceptance or OS IME UI.

| Condition | dispatch-to-input p95 ms | Longtasks |
|---|---:|---:|
| H5000 tail ASCII, no receive, runs 0/1/2 | 4.2 / 3.7 / 4.0 | 0 / 0 / 0 |
| H5000 tail ASCII, tick100, runs 0/1/2 | 37.1 / 41.6 / 37.1 | 2 / 2 / 1 |
| H5000 tail IME, no receive, runs 0/1/2 | 4.0 / 3.9 / 3.4 | 0 / 0 / 0 |
| H5000 tail IME, tick100, runs 0/1/2 | 43.8 / 42.2 / 43.7 | 1 / 1 / 1 |
| H1000 tail ASCII, tick100, shape control | 19.0 | 0 |
| H1000 expanded ASCII, tick100 | 85.3 | 51 |

The listener-to-rAF median stays around 2–4ms in the H5000 receive cases and
misses most waiting before the input listener. Dispatch includes CDP transport;
rAF precedes presentation. Sixty completion-paced actions change exposure
length between conditions; this is not an externally paced production trace.

A separate ten-tick counter run with stable 200-row tail gave:

| H per agent | merges | merge-internal keys | all key calls | dayKey | formatTime |
|---:|---:|---:|---:|---:|---:|
| 1000 | 20 | 20,110 | 22,130 | 10,055 | 2,000 |
| 5000 | 20 | 100,110 | 102,130 | 50,055 | 2,000 |

The live receive path rebuilds a Set/key/sort over the entire affected history.
Detail maps fresh row wrappers, computes full-history day dividers, and
reevaluates row constants including timestamp formatting. Keyed DOM identity
alone did not avoid those calls in the measured baseline. At H1000 expanded,
51 ticks gave 52,326 native time formats / 3121.2ms. At H5000 tail, the profile
attributes 526.9ms inclusive to merge, including 249.0ms key work, and 387.3ms
to formatTime. Inclusive times overlap; do not sum them.

At 50ms requested tick, H1000→5000 increases merge CPU 153.3→975.0ms and
synchronous handler median 3.0→16.8ms (61 ticks each). Format count stays
14,030 in both. At 20ms the H5000 browser timer manages only 61 ticks/3234ms;
that is not proof of handling externally queued 20ms traffic. Dense runs also
grow visible DOM; the reading-freeze trigger needs a separate investigation.

The input graph itself is instruction→slash query/matches/menu/reset and the
send-button trim; ordinary input is O(text length), not a history scan. Logs
replacement drives merge→displayable wrappers→day dividers/window→row constants
and scroll effects. State-envelope updates drive agents/catalog/status paths;
ordinary log ticks do not replace the agents map. The 30-second App clock feeds
the grid timeline, which is unmounted while this composer is open. The lexical
graph counts (76 derived/22 top-level effects in Detail, 9/1 in App) are not
runtime execution counts.

Ranked causes: timestamp/row-constant fanout dominates expanded history;
full-history merge dominates long-history tail; full-history filter/day metadata
is smaller. No IME-specific reactive explosion was established. Real session
shape and OS/browser assets remain outside this evidence. The approved fix
scope and verification requirements are in [acceptance.md](acceptance.md).

## Evidence identity and checks

Original local reports (unchanged):

- `report.md`: SHA256 `85314e9c5aa311cb8d2c73056e094f0cc8bdc54e26fd1659dc6f1747ea9701b1`
- `addendum.md`: SHA256 `68abf4426db44ce28e6b2776b181d8e3e5e0bc88ab05e2addd889feb33f1e192`
- `instrument-counts.py`: SHA256 `3108b82db2e1c38627ff4de68b1ca2f2aa9bde5cbd2c13a6475c1e3fd335c0be`

Production primary/repeats/shape/extension commands exited 0 with completed
inputs and no page errors. Disconnecting the input listener gave exit 1
(`Invalid frame measurement`); removing only the exact count probe's format
counter gave exit 1 (`format count mismatch`); source/bundle bytes were restored.
The five scripts pass `node --check`. These results support the investigation,
not a claim that the eventual replacement benchmark is already verified.
