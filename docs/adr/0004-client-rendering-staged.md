---
title: Select animation / 3D
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [architecture]
related_adrs: [3, 7]
---

# ADR 4 — Select animation / 3D in the future

## Status

Accepted

## Context

It was a problem how to make the client’s character drawing technology. Live2D
Animation and 3D are highly expressive, but the cost is large. Prototype
I want to prioritize the implementation speed at the stage.

## Decision

- Prototype**Changes in expressions**implement.
- Live2D animation**Alternative**Note**3D Model Character**
Study and study the possibilities and technically available **"static difference/anime/3D" per persona
Enabled**

## Consequences

### Positive

- Implementable early. You can mass-pro  expression difference material with your own ComfyUI.

### Negative

- There is a required to have a drawing type in `persona` for future drawing type addition
  ([ADR-0003](0003-persona-identity-persistence.md)).

### Neutral

- The selection of drawing type is persona unit, so it can be extended step by step.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Live2D/3D|Expires cost-effective, Search alternatives and 3D methods|
|Fixed only with static difference|Block future expansion|
