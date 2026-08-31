---
title: File upload — markitdown fallback for Office conversion
description: Open question on whether to provide markitdown CLI (Python) as a fallback alongside the MVP officeparser (pure JS) when quality is insufficient for an Office-conversion use case.
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

The Phase 7 Stage A spike (IN3) compared Office-conversion libraries and adopted
**officeparser** for the MVP (pure JS, MIT, one library supporting docx/xlsx/pptx,
compatible with ADR-0018's single-binary direction). Microsoft's
**markitdown** (Python CLI) produces high-quality Markdown and there is existing
`my-markitdown` skill material, but the Python dependency makes wrapper
distribution heavy (a poor fit with ADR-0018).

Leave room to add markitdown as a **fallback backend** if officeparser output is
insufficient for complex xlsx layouts, animated pptx, or docx with many tables.

## 選択肢

| Option | Content | Advantages | Disadvantages |
|--|--|--|--|
| A | officeparser only (MVP) | Minimal implementation; pure JS; compatible with ADR-0018 | Markdown quality may be insufficient for complex layouts |
| B | Select `office_backend: officeparser \| markitdown` through wrapper config (officeparser by default; start markitdown as a subprocess) | Meets quality requirements; reuses existing skill material | Bundle or separately install a Python runtime; works against ADR-0018's single-binary direction |
| C | Automatic fallback (try markitdown when officeparser fails) | Good UX | Failure threshold is ambiguous; complex implementation |

## 影響

With A, the protocol is unchanged and wrapper Office conversion has one path. B
and C are internal wrapper implementation and **do not change the protocol**
(client/server do not know the conversion type; ADR-0025 F1 wrapper-internal).
With B, add a backend-selection field to wrapper config; start the markitdown path
as a subprocess following the my-markitdown skill convention.

## 判断材料

- Whether operational reports show insufficient officeparser output quality
- Timing of ADR-0018 single-binary packaging (compare bundling Python with
  requiring it separately)
- API compatibility with the existing my-markitdown skill

## 暫定方針

A — The MVP uses officeparser alone. Add B (explicit backend selection) if a
quality requirement appears. Do not adopt C (automatic fallback) because its
implementation is complex.

## 解決時のアクション

- [ ] Aggregate examples of quality requirements
- [ ] Add an `office_backend` field to wrapper config
- [ ] Implement the markitdown subprocess path (following the my-markitdown
      skill convention)
- [ ] Promote to an ADR and delete this file
