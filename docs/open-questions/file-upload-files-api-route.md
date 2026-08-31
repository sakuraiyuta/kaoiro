---
title: File upload — Files API path (handle >32 MB?)
description: Open question on whether to adopt a path that sends large files beyond the SDK's effective 32 MB limit (image >10 MB / PDF >32 MB / total >32 MB) through the Claude Files API (referencing file_id).
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

The Phase 7 Stage A spike (IN2) found the effective content-block limits of the
Claude API: image 10 MB (after base64) / PDF 32 MB / **request total 32 MB is a
hard limit**. The individual 128 MB limit in the kaoiro spec is the wrapper-local
receive limit and is separate from the SDK acceptance limit. In the MVP,
fit-to-SDK reduces content to at most 32 MB with downsize / page-extract, but
rejects content that cannot be reduced (ultra-high-resolution images / PDFs over
600 pages, etc.).

The Files API (`file_id` reference) allows one file up to 500 MB (the beta header
`files-api-2025-04-14` is required). However, whether a path exists to pass the
beta header through the Agent SDK has not been confirmed by a spike.

## 選択肢

| Option | Content | Advantages | Disadvantages |
|--|--|--|--|
| A | Base64 inline path only (MVP); fit-to-SDK or reject content over 32 MB | Minimal implementation; unchanged protocol surface; no spike needed | Very large files are effectively rejected |
| B | Add a Files API (`file_id` reference) path alongside it | Practical up to 500 MB; efficient reuse of one file across turns | Requires a spike for enabling the Files API beta header, Files API integration in the wrapper, and lifecycle management (when to delete files) |

## 影響

With A, UX ends at wrapper fit-to-SDK and rejection with no protocol change. With
B, add a Files API client integration to the wrapper and a path that generates
the instruction content block in the form
`{type: "image", source: {type: "file", file_id: "..."}}` (a wrapper-internal
matter; client/server remain unchanged at the protocol level).

## 判断材料

- Frequency of real operation with files over 32 MB (ultra-high-resolution
  images / large PDFs / RAW, etc.)
- Feasibility of enabling the Files API beta header through the Agent SDK (needs
  a spike)
- Whether the wrapper can own the Files API lifecycle (up to 500 GB accumulates
  within one organization; explicit deletion is required)
- Whether Bedrock / Vertex AI use is expected (Files API is unsupported)

## 暫定方針

A — The MVP uses only the base64 inline path. If an operational need for over
32 MB appears, run a spike and consider B.

## Actions upon resolution

- [ ] Spike enabling the Files API beta header through the Agent SDK
- [ ] Implement Files API client integration in the wrapper (use
      `@anthropic-ai/sdk` directly)
- [ ] Specify file lifecycle management (upload → reference → delete)
- [ ] Promote to an ADR and delete this file
