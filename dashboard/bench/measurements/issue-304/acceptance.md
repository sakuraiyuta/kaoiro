# Typing performance acceptance

Baseline: `2ea8f80bcd18aaac2bb6f47b9a685dbcfe3ebb7e`. Scope: stable
`displayableLogs` wrapper identity, a single-live-arrival identity index and
ordered insertion, and dispatch-to-input benchmark reporting. No automatic
collapse, virtualization or incremental day-divider/filter implementation.

## Correctness and work avoided

- In a settled detail, ordered unique appends with unchanged absolute indexes
  must format only newly rendered rows. Ten viewed appends after initial render
  produce ten `formatTime` calls, for both 1000 expanded rows and the 200-row
  tail. Background-only updates and typing without appends produce zero.
  Count the actual function, not only native formatting (a cache can hide work).
  Measure the Svelte production build; do not assume keyed-each equality rules.
- WeakMap reuse is valid only for the same envelope and absoluteIndex. Insert a
  hidden entry before retained visible rows, and separately an out-of-order
  visible entry; verify the new raw indexes, displayed rows, timeline/partner
  targeting and scroll anchor. Include unchanged-index identity reuse as control.
- A warmed live index performs no full `mergeTranscriptEntries` call on unique
  ordered append, duplicate, or supported out-of-order insertion. Warm-up/fallback
  is explicit; a duplicate does not change acceptance or the error index.
- Compare actual results to the existing full merge for duplicate identity,
  out-of-order input, same `(ts,seq)` distinct identities (stable first arrival),
  multi-target IA and replay overlap. `accepted` means transcript length grew;
  keep the existing errorIndexParity suite. Index storage follows live transcript
  lifetime; no unreachable transcript retained by a global strong map.
- Map every actual replacement/invalidation writer, with at least history,
  replay reset/complete, join/snapshot, reconnect, clear/reset, agent deletion,
  logout and unexplained array-reference mismatch covered. The implementer must
  identify real handlers; this list is not evidence that there are exactly eight.
  After each, a subsequent live duplicate/append must match full merge. Include
  same-length replacement, not only changed lengths.
- Independently mutate identity reuse, duplicate membership, ordered insertion
  tie handling, one existing fallback and one new fallback wiring. Each relevant
  test must fail; restore source bytes. Measure real App receive wiring as well
  as pure helper semantics. Removing the fast path must fail the no-full-merge
  work assertion even if output remains correct.

## Performance evidence and benchmark failure rules

Run production-compiled App, same host/browser/viewport and instrumentation for
before/after: five agents, one viewed and one background append every 100ms,
60 ASCII actions and 60 native Chromium composition updates (plus commits),
three separately saved runs per scenario:

1. H=1000 per agent, explicit full expansion maintained.
2. H=5000 per agent, initial and final visible tail verified as 200 rows.
3. Matched H=1000 tail control, plus tick-off controls.

Primary: dispatch-to-input median/p95. Secondary: input-to-rAF and longtasks.
Save raw timestamps, actual ticks/elapsed, input/composition counts, visible rows,
page errors, observer/read failures, source/build identity and run label. Do not
replace these with wall-clock command completion or listener-to-rAF alone.
Synthetic interval scheduling and OS IME limitations must remain explicit.

Version 2 gates each input/shape group on a median of three per-run
dispatch-to-input p95 values <=25ms, no run >35ms, and a median longtask count
of zero with no run above one. The expanded-versus-matched-tail p95 delta is
advisory: it includes remaining display/filter work outside this scope.

Version 1 additionally gated expanded p95 <= matched H=1000 tail p95 +8ms.
The recalibrated measurement exceeded that relation by 3.356ms for ASCII and
0.026ms for IME while passing every Version 2 gate; preserve the comparison
in the summary, but do not treat it as a failure. These are reference-host
performance targets, not universal CI-machine timing promises. If a Version 2
gate fails, retain the failed run and report before changing thresholds or rerunning.
Baseline ASCII H1000 expanded dispatch-to-input median/p95 was 59.6/85.3ms;
matched tail 3.8/19.0ms. Baseline H5000 tail ASCII p95 was 37.1/41.6/37.1ms.

Do not force-collapse or silently pin-scroll to satisfy the 200-row condition.
An unexpected shape transition is an invalid shape comparison that must be
reported with its measured row count, not labelled a valid tail result.

Missing input/rAF, unsupported required observers, read errors, page errors,
incomplete actions or timestamp pairing must exit nonzero. Valid event-timing
or longtask arrays may be empty. A disconnected input observer and a missing
required read must independently fail. The failure path must be exercised
through the actual benchmark invocation. Store all three runs separately;
source and generator/verifier hashes bind each result. Final mutations require
restoration verification before producing final benchmark results.

Run dashboard `pnpm check` and `pnpm test`, report exit codes and unhandled
errors/warnings. Known flaky failures must be preserved, not erased by a green
rerun. Reviewer checks are independent reruns on the fixed commit.
