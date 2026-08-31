---
title: Documentation/UI is Japanese; full English translation before beta
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: []
related_adrs: [26]
---

# ADR-0006 — Documentation/UI Is Japanese; Full English Translation Before Beta

## Status

Accepted

## Context

The language for documentation and the UI was a problem. The developers for the
foreseeable future are Japanese speakers, and Japanese is faster initially. On
the other hand, English is needed with public release in mind.

## Decision

- During the prototype period, both the documentation and UI are **Japanese**.
- Carry out a **full English translation process before the beta release** as an
  independent milestone ([plans/phase-5-i18n](../plans/phase-5-i18n.md)), and
  decide the primary language from that point onward.

## Consequences

### Positive

- The initial development speed is preserved.

### Negative

- The cost of bulk translation is incurred before the beta.

### Neutral

- The final policy for the primary language will be decided in Phase 5.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| English from the start | Initial development speed would drop |
| Maintaining two languages in parallel at all times | Maintenance cost is high |
