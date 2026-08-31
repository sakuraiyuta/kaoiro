---
title: File upload — need for EXIF / metadata stripping
description: Open question on whether the wrapper should strip EXIF / metadata (shooting location, device information, and so on) from uploaded images. Privacy concern.
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) specifies
that the MVP passes attachment bytes directly from wrapper → SDK. Image EXIF
may contain location / device / capture time and other data, so the wrapper may
need to strip it if sensitive-image operation becomes common. It remains
undecided because current use centers on dogfooding.

## 選択肢

| Option | Content | Advantages | Disadvantages |
|--|--|--|--|
| A | Pass through wrapper → SDK unchanged (MVP) | Minimal implementation; fidelity to the original data | Sensitive EXIF may leak |
| B | Strip in the wrapper (opt-out available) | Privacy-safe | Adds a stripping implementation (sharp, etc.); causes trouble where original information is needed (photo analysis, etc.) |
| C | Let the user choose strip / unchanged in the client picker | Respects user intent | More complex UX; implementation in both client / wrapper |

## 影響

With A, the protocol / implementation is unchanged. With B / C, add a stripping
step before the wrapper's fit-to-SDK processing (images only). The protocol is
unchanged (wrapper-internal implementation).

## 判断材料

- Whether operation will involve images containing sensitive EXIF
- Balance with legitimate use cases that need location and similar data retained
  (image analysis including geographic information)
- EXIF API of the image library planned for fit-to-SDK (sharp, etc.)

## 暫定方針

A — Do not strip in the MVP. Consider B (opt-out available) if sensitive-image
operation becomes necessary.

## 解決時のアクション

- [ ] Specify EXIF stripping (opt-out flag location / default)
- [ ] Add a stripping step before wrapper fit-to-SDK
- [ ] Promote to an ADR and delete this file
