---
title: Layered documentation taxonomy and the migration order for docs/
status: accepted
date: 2026-09-18
opened: 2026-09-18
supersedes: []
superseded_by: null
related_specs: [overview, architecture]
related_adrs: [6, 58]
---

# ADR-0060 — Layered documentation taxonomy and the migration order for docs/

## Status

Accepted (operator decision 2026-09-18, on kuroe's proposal after a design
consultation with fuji). Tracked by
[issue #368](https://github.com/sakuraiyuta/kaoiro/issues/368). The rules
that follow from this decision live in
[docs/contributing/documentation.md](../contributing/documentation.md);
this record keeps the reasoning and the options that were not taken.

## Context

At develop f4788213 the tree held specs 26 files / 10,319 lines, adr 59 /
12,165, plans 39 / 6,237, open-questions 25 / 1,426, operations 1 / 324.
The largest files mix several kinds of content: `specs/protocol.md`
(1,617 lines) and `specs/protocol-inter-agent.md` (1,814) hold wire
contracts, rationale and agent guidance in one body; `specs/deployment.md`
(1,410) holds runbooks, configuration tables and design reasons; ADR-0058
(1,211) holds a decision plus ~1,000 lines of measurement appendices; and
"how the system is built today" is spread across ADR addenda rather than
one place. A reader — a person or an agent loading a file into context —
cannot answer one question without reading several unrelated ones.

The operator asked for one file per topic, split into four kinds:
design rationale, operator procedures, explanation of the design that is
actually implemented, and the concrete implementation / protocol content.

## Options

| Option | Benefit | Cost and limit |
| --- | --- | --- |
| A: keep `specs/` and split large files in place | Smallest move; existing links survive | Kinds stay mixed inside each topic; no home for runbooks, evidence or dev procedures |
| B: four folders exactly as proposed | Matches the operator's reading model | Rationale and current design compete for the same file; decision history and measurement records have no home and keep bloating ADRs |
| C: layered taxonomy (architecture / operations / reference / adr / evidence / contributing), one file per reader question | Each folder answers one kind of question; ADRs stay immutable; evidence stops inflating decisions | Larger migration; references must move with the content |

Decision: **C**. The operator's four kinds map onto it as: rationale and
current design → `architecture/` (one topic, "why" and "how it is built"
in one file); operator procedures → `operations/`; implementation and
protocol content → `reference/`. Two kinds the proposal did not name are
added because they were the actual source of bloat: `evidence/` for
measurement records and `contributing/` for build / test / change
procedures. `adr/` stays as decision history and is never rewritten into
the present tense; `plans/` and `open-questions/` stay as the in-progress
index. `specs/` dissolves into `architecture/` and `reference/`.

## Decision details

- **Unit is one reader question, not one field.** `permission` is one
  theme but "why requested / submitted / effective are distinct", "how an
  operator recovers", and "the wire request and reply" are three files.
  Splitting every field into its own file is the opposite failure: the
  reader moves between files to assemble prerequisites.
- **Size is a trigger, not a cap.** 300–500 lines is where a split is
  considered; the reader question decides.
- **Axes are separate.** `status: accepted` in an ADR does not mean
  implemented, deployed or measured. Current contracts state which of
  accepted / implemented / released / measured applies, and evidence
  records carry the date, commit or binary hash and the conditions.
- **Types are the structural canon; documents are the semantic canon.**
  A conflict between `@kaoiro/protocol` and a reference page is resolved
  by deciding which is wrong, not by "updating the doc to match the code".
- **No duplication for humans versus agents.** People get role-based
  entry points; agents get direct references from `AGENTS.md` /
  `CLAUDE.md`. Agent working rules stay a separate contract
  (`agent-operations`).
- **Order: migration table first, then sync, then move.** The table
  (old section → new topic → canonical → checker) is designed before any
  edit. The sync pass corrects meaning only and does not rewrite the old
  files for style. Moves and de-duplication follow per agreed unit, each
  as its own commit. This keeps the operator's sync-first order while
  avoiding writing the same text twice.
- **Move safety.** In-repo references (docs, code comments, `AGENTS.md`,
  `CLAUDE.md`) change in the same commit as the move; a one-line stub at
  the old path is not enough because `#fragment` links break. External
  references (issues, ADRs) get an old-heading → new-location map. Three
  representative reading paths (operations update, permission recovery,
  adapter implementation) are walked before a unit is closed. Link-check
  tooling is a separate review, not a prerequisite.
- **Not done:** rewriting ADR bodies; blanket-archiving `plans/` (pending
  items are re-homed first, then completed plans leave the entry page);
  treating a refreshed date as a verified page.

## Consequences

- New topics are written into the layered folders from now on; the
  migration of existing files proceeds under issue #368.
- The same taxonomy is recorded project-agnostically in the operator's
  `my-docs-restructure` skill so other repositories follow the same
  layering.
- ADR-0006 (documentation language) is unaffected; the tree stays in
  English.
