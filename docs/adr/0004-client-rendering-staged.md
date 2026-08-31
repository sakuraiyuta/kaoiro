---
title: Rendering starts with static variants; animation/3D selectable in the future
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [architecture]
related_adrs: [3, 7]
---

# ADR-0004 — Rendering Starts with Static Variants; Animation/3D Selectable in the Future

## Status

Accepted

## Context

How far to develop the client's character-rendering technology was a problem.
Live2D-style animation and 3D are highly expressive, but costly, and research
into OSS alternatives is incomplete. At the prototype stage, implementation
speed should be prioritized.

## Decision

- The prototype will be implemented with **switching static expression
  variants**.
- In the future, investigate and consider the implementation possibilities of
  **OSS alternatives** for Live2D-style 2D animation and **3D model characters**.
  If technically possible, make **"static variants/animation/3D" selectable per
  persona**.

## Consequences

### Positive

- Implementable early. Expression-variant assets can be mass-produced with the
  available ComfyUI setup.

### Negative

- To prepare for adding drawing types in the future, `persona` must carry the
  drawing type ([ADR-0003](0003-persona-identity-persistence.md)).

### Neutral

- Drawing-type selection is per persona, so it can be extended incrementally.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Live2D/3D from the start | Cost is too high, and research into OSS alternatives and 3D approaches is incomplete |
| Fixed to static variants only | It closes off room for future expression expansion |
