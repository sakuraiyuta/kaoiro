---
title: Documentation rules — where a page goes and how it moves
status: accepted
last_updated: 2026-09-18
description: The layered docs/ taxonomy (architecture / operations / reference / adr / evidence / contributing), the placement test for a new page, and the sync-then-move order for reorganizing existing pages.
---

# Documentation rules

Where to put a page, what belongs in it, and how to move one. The
reasoning behind these rules is [ADR-0060](../adr/0060-documentation-taxonomy-and-migration.md);
the migration of the pre-2026-09 tree is tracked in
[issue #368](https://github.com/sakuraiyuta/kaoiro/issues/368).

## Layers

| Folder | Reader question | Holds | Does not hold |
|---|---|---|---|
| `architecture/` | How is this built today, and why this shape? | Structure, responsibilities, data flow, constraints and their reasons; one topic per file with a "why" and a "how it is built" part | Field tables, long command sequences, options that were not taken |
| `operations/` | How do I, the operator, get X done? | Runbooks: prerequisites → steps → success check → failure / rollback, kept in one file | Copies of configuration tables or wire fields (link to `reference/`) |
| `reference/` | What exactly is the contract? | Exact current contracts by topic (`protocol/`, `configuration/`, `engines/`, `ui/`): required fields, owner, ordering, rejection, compatibility | Rationale, procedures |
| `adr/` | What was decided, when, against which alternatives? | Decision records in the past tense; addenda for later decisions | Rewrites into the present tense; current contracts (link out instead) |
| `evidence/` | What was measured, under which conditions? | Date, target commit or binary hash, real CLI vs fixture, observations, negative controls, limits; a short summary plus a pointer to the stored artifact | Full logs; claims that rest on a `/tmp` path |
| `contributing/` | How do I change the project? | Build, test, review and change procedures, including this page | Operator runbooks |
| `plans/`, `open-questions/` | What is in progress or undecided? | Phase plans with live status; unresolved questions until they become ADRs | Finished work presented as current (re-home pending items, then demote) |

`specs/` is the pre-taxonomy folder and is being dissolved into
`architecture/` and `reference/`; do not add new pages there.

## Placement test

1. Write the question the reader brings. One question → one file. Three
   questions about the same theme (for example the rationale for the
   permission axes, the operator's recovery steps, and the wire request)
   are three files that link to each other.
2. Do not split one question across files just to shorten them. 300–500
   lines is where a split is *considered*; the question decides.
3. State which axis a page speaks for: accepted, implemented, released,
   measured. The folders are the typical homes (ADR / architecture and
   reference / operations / evidence), not a classification rule: never
   infer implementation, release or measurement status from the folder a
   page sits in. A status that matters is written on the page with the
   target version or commit and the conditions. An ADR marked
   `accepted` is not evidence that anything shipped.
4. Types in `@kaoiro/protocol` are the canon for structure; the reference
   page is the canon for meaning the types cannot express (ownership,
   ordering, rejection). When they disagree, decide which one is wrong.
5. Threat model content is an `architecture/security` topic plus concrete
   constraints under `reference/security`; a glossary exists once.
6. People and agents read the same pages. Give people role-based entry
   points; give agents direct references from `AGENTS.md` / `CLAUDE.md`.
   Agent working rules remain their own contract
   (`agent-operations`).

## Writing rules

- English (ADR-0006); frontmatter carries `status` and `last_updated`
  and is updated together with the body.
- Refreshing `last_updated` without checking the claims is not a sync.
  A sync compares each claim against the code it describes and records
  the evidence line.
- Do not restate another page; link to it. A code comment points at a
  page (`See docs/reference/...`) rather than paraphrasing it.
- Incidents and postmortems go to the issue tracker; only a durable rule
  extracted from them becomes an ADR or a constraint on a page.

## Reorganizing existing pages

1. **Migration table first.** For each old section: new topic, canonical
   page, and who checks it. Agree the table before editing.
2. **Sync second.** Correct meaning only (wrong, stale, missing). Do not
   rewrite the old page for style; it is about to move.
3. **Move third, one unit per commit.** A move is information-preserving:
   every paragraph, table and code block of the old page lands in a named
   new page (contracts and event shapes in `reference/`, dated inputs,
   outputs and negative controls in `evidence/`, reasons in
   `architecture/`) or is dropped as a duplicate of a specific surviving
   page, and the report lists that old-section → new-location mapping.
   Shortening, paraphrasing into a table, or pointing at source code as
   "the canon" is not a move; a doubtful claim found on the way is a
   separate semantic-sync commit. In the same commit: update every
   in-repo reference (docs, code comments, `AGENTS.md`, `CLAUDE.md`);
   remove the old text (no second canon); at the old path keep a stub
   whose headings or explicit anchors still resolve the existing
   `#fragment` links and point each one at its new location, because a
   one-line stub does not preserve them and a mapping kept in another
   file does not rescue an old URL either.
4. Before closing a unit, walk three reading paths from the entry page:
   an operations update, a permission recovery, and an adapter
   implementation. Fix broken relative links and fragments found on the
   way.
5. Link-check tooling is reviewed separately; it is not a prerequisite
   for moving pages.
