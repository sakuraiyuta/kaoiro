---
title: A standing design for engine pin bumps
status: accepted
date: 2026-11-18
opened: 2026-11-17
supersedes: []
superseded_by: null
related_specs: []
related_adrs: []
---

# ADR-0074 — A standing design for engine pin bumps

## Status

Accepted (2026-11-18). Operator decisions on
[issue #1168](https://github.com/sakuraiyuta/kaoiro/issues/1168)
([questions](https://github.com/sakuraiyuta/kaoiro/issues/1168#issuecomment-6952400710),
[reductions](https://github.com/sakuraiyuta/kaoiro/issues/1168#issuecomment-6953569903)).
Design review: two rounds, must 2 cumulative, 0 at round 2
([summary](https://github.com/sakuraiyuta/kaoiro/issues/1168#issuecomment-6956094065)).

## Context

kaoiro depends on engine behaviour that is not a documented contract, so an
engine pin is kept and an unmeasured version must not reach production. Every
pin change was treated as a new high-risk design. The Claude part of
[issue #1044](https://github.com/sakuraiyuta/kaoiro/issues/1044) took four
design-review and three implementation-review rounds, and
[issue #1063](https://github.com/sakuraiyuta/kaoiro/issues/1063) two of each.
The E1 to E4 harness lived outside the repository and had to be restored for
each bump. The operator asked for fewer checks and less code, accepting some
loss of product stability for maintainability.

## Decision

1. **Standing design.** An Agent SDK bump that meets none of the exit
   conditions below follows the
   [Agent SDK bump checklist](../contributing/agent-sdk-bump.md) with no design
   or design review of its own: one implementation review by a reviewer of
   another model family, must 0, then the operator's release decision. The
   classification stays high risk; the measurements stay.
2. **Exit conditions.** If any one holds, the bump goes back to a full design.
   The implementer states each in the evidence and the implementation reviewer
   checks them.

   | Condition | Holds when |
   |---|---|
   | X1 | kaoiro source, or a test's claim, has to change for the bump to pass |
   | X2 | the dependency shape changes (`peerDependencies`, `exports`, `engines.node` beyond the wrapper's own requirement, the platform package set), the lockfile changes outside the allowed set below, or a resolved peer moves |
   | X3 | an E1 to E4 judgement fails, a negative control does not bite, `judge.mjs`, `seam.mjs` or `checker.mjs` has to change, or `probe.mjs` has to change beyond its server-link stub ([harness README](../../wrapper/claude-code/test/fold-premises/README.md)) |
   | X4 | a changelog entry in the four categories (folding and queued input, permissions, hooks, model switching) reaches a kaoiro path with a behaviour change no existing test or E1 to E4 covers, or a regression is observed |
   | X6 | the chosen version is not the `dist-tags.latest` at the time it was chosen, or it leaves `0.3.x` |
   | X7 | the engine is Codex, until a Codex standing design is approved |

   X5 (a catalog value resolves to another model, or a row disappears) was
   dropped by the operator. Catalog rows added or removed and alias destination
   changes do not meet X4 by themselves; they go into the release note. If
   they change kaoiro's own behaviour, that change is judged under X1 or X4.
   Moving a fixed expected model name in a test to the destination the same
   bump's catalog probe reports is not X1; changing a test's inputs, property
   or number of cases is.
3. **Allowed lockfile set for X2.** Lines inside the `packages` and
   `snapshots` entries of `@anthropic-ai/claude-agent-sdk` and its platform
   packages (`@anthropic-ai/claude-agent-sdk-<platform>`), old and new
   version, including snapshot keys with a peer suffix whose peer versions are
   unchanged; and, in the `wrapper/claude-code` importer, only that
   dependency's `specifier` and `version` lines. Any other package, including
   a transitive dependency only this engine uses, is outside. A line that
   cannot be attributed to an entry, or a diff this definition cannot decide,
   counts as X2. For example, the 0.3.319 to 0.3.321 bump changed 74 lines in
   37 entries, all inside.
4. **The harness lands in the repository** and runs at a bump, not in CI.
5. **No new mechanism**: no central pin file, bump script, evidence
   generator, lockfile scope checker, changelog classifier, version detector
   or real-model turns. Tests do not hard-code engine versions or the native
   binary hash; the lockfile and `package.json` are the pin.

## Alternatives considered

- **A full design for every bump** (the previous practice). Rejected by the
  operator for its cost.
- **Running E1 to E4 in CI on every change.** It would detect harness ageing
  as soon as the wrapper changes, but it needs the harness paths rewritten
  (losing its byte identity with the recorded runs) and adds CI time and
  upkeep. Rejected.
- **Scripts that generate the evidence and check the lockfile scope.**
  Rejected: a short evidence form grounded in the CI and harness runs avoids
  the hand-written sentences they were meant to protect.

## Consequences

The operator accepted these losses:

- the changelog is still read in full, but only the entries in the four
  categories and changes the operator can see are recorded;
- the lockfile scope is judged by the reviewer reading the diff, with no
  mechanical proof that nothing else changed;
- no test pins the SDK or CLI version or the native hash, so a bump no longer
  forces a re-read of each native test's premise; a framing test stands in for
  the hash pin and covers only the framing fragments;
- the catalog is not committed per version; only the rows that differ go into
  the release note;
- the evidence is short, so the details of method and observation are in the
  harness README, this checklist and the run records, not in the file;
- an aged harness is found at the next bump, not when the wrapper changes.
