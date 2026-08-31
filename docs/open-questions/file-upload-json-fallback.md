---
title: File upload — need for the `attach_chunk_b64` JSON ingress fallback
description: Open question on whether to provide JSON base64 ingress as a fallback for simple clients (neovim Lua / Python, etc.) where sending binary frames is expensive.
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F2 finalized
the transfer wire as one binary-frame chunked path (avoid base64 expansion /
maximize frame efficiency). If a simple client (neovim Lua / Python, etc.) with
an expensive ArrayBuffer push implementation appears, it remains undecided
whether to add JSON ingress (a base64-attached version of `attach_chunk`) as a
fallback.

## 選択肢

| Option | Content | Advantages | Disadvantages |
|--|--|--|--|
| A | MVP with one binary path and no fallback | One wire path; clear specification; “widening the entry point” remains an implementation responsibility for the customer | Higher barrier for customers with simple implementations (Phoenix Channels V2 binary is implementable, but takes work) |
| B | If a simple-client requests it, add `attach_chunk_b64` (JSON `{upload_id, chunk_index, data_b64}`) | Good UX (simple-client support); wire compatibility remains possible (both paths) | Protocol surface +1; two ingress paths; ongoing spec cost |

## 影響

With A, the protocol is unchanged. With B, add one client→server event (keep
the version unchanged and preserve forward compatibility through ADR-0015). The
wrapper aggregates both ingress paths into the same pending_uploads.

## 判断材料

- Requests from third-party client implementers (kaoiro.nvim Lua / Python CLI,
  etc.)
- Measured implementation difficulty for a simple client (code volume when
  implementing Phoenix Channels V2 binary without ArrayBuffer)
- Binary support status of existing Channels client libraries (phoenix-elixir,
  websockex, etc.)

## 暫定方針

A — MVP uses one binary path. Add B (backward compatible) if requests become
real.

## Actions upon resolution

- [ ] Aggregate simple-client requests
- [ ] Specify the `attach_chunk_b64` wire
- [ ] Promote to an ADR and delete this file
