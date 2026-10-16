---
title: Native transcript reader cost on a 50 MB class file
status: measured
last_updated: 2026-10-16
---

# Native transcript reader cost on a 50 MB class file

[Design r10](../../plans/issue-426-stage2-native-continuations.md) asks for the
large-transcript prefix cost to be measured before any performance criterion is
set. This record is that measurement for
[issue #426](https://github.com/sakuraiyuta/kaoiro/issues/426). It sets no
threshold and changes no behaviour. The reader still reads the whole file,
hashes the committed prefix over every byte and parses every line, so the
tamper checks (prefix change, truncation, replacement) are unchanged.

## What was measured

`NativeTranscriptReader.capture` and `NativeTranscriptReader.validate` from this
branch's source, run in one process against synthetic JSONL files written just
before the run. Each file ends with a native opener row for a fresh prompt.
After a cold first read, 20 repetitions of `capture` and `validate` were
timed, and 20 more `capture` calls each followed one appended assistant row
plus a new opener, as in a live session.

Two 50 MB class shapes were used: 12,500 assistant rows of about 4 KB each, and
50 rows of about 1 MB each (a transcript dominated by large tool outputs).
Row content is a repeated filler character, so JSON parsing cost is lower than
for varied real text.

## Results

Timings are milliseconds of wall clock; the file was in the page cache.

| Shape | File bytes | Rows | Cold first read (ms) | `capture` median / max (ms) | `validate` median / max (ms) | `capture` after one appended row, median / max (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| many-small-rows (4000 byte rows) | 51763890 | 12500 | 228.6 | 217.5 / 242.5 | 218.3 / 255.4 | 225.2 / 245.5 |
| few-large-rows (1000000 byte rows) | 50006940 | 50 | 163.0 | 208.7 / 238.7 | 213.6 / 240.2 | 211.9 / 243.7 |

## What this does and does not show

Observed: on these synthetic files, the median `capture` or `validate` took
209–225 ms at roughly 50 MB, with a worst case of 255 ms, and the cost did not depend measurably on whether
the file had many small rows or a few large ones.

Inferred from reading `host.ts` and `native_transcript.ts`, not separately
timed: with native continuations enabled every root `UserPromptSubmit` awaits one
`capture` before admission, an accepted native root adds a `capture` and a
pre-commit `validate`, each send adds a `validate`, and a poll while the opener
row is not yet visible adds a `capture` per iteration. The reader serializes
these calls, so a single accepted root on a transcript of this size spends on the
order of a second of serialized reader time, and the 5 s acquisition budget
holds only a few dozen polls.

Not measured: real transcripts with varied content, a concurrent writer,
a cold page cache, files larger than about 50 MB, the split between hashing and
parsing, and CI hardware. Whether this cost is acceptable for production
enablement is an operator decision; no threshold is set here. If the cost
needs reducing, only the repeated `JSON.parse` may be reduced: the committed
prefix is hashed over all bytes, and the pre-send `validate` stays.
