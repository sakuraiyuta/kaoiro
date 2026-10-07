---
title: Attachment rendering by engine
description: Per-engine SDK content-block mapping and fit-to-SDK size/limit handling for attachments.
status: accepted
last_updated: 2026-10-08
related: [protocol, adapter-contract]
---

# Attachment rendering by engine

### Wrapper-internal rendering

The wrapper knows the active SDK and active model, so it converts each
attachment to the most suitable SDK content block. Anthropic API terminology
(such as image_block / document_block / text_block) does not appear in the
protocol, client, or server.

For the Claude Agent SDK:

| Type | Render target |
|--|--|
| Image | `image` content block |
| Text / code | `text` content block (inline body) |
| PDF | `document` content block |
| Office | Convert to text with wrapper-internal officeparser (pure JS; docx/xlsx/pptx) → `text` block |

The table above is the policy of the Claude Code adapter
(`wrapper/claude-code/src/upload.ts`). Each engine's wrapper has its own
policy; the **Codex adapter (`wrapper/codex/src/upload.ts`) accepts images
only**. It advertises `attachment_types: ["image"]` in
`ext.session_capabilities`, and restricts the UI picker / paste / drop to
images accordingly ([plugin-model](../protocol/capabilities.md)). Protocol limits (128 MB /
20 in flight / five-minute TTL) are common to both engines.

### Fit-to-SDK

The wrapper absorbs the gap between the 128 MB protocol limit (client → server
→ wrapper) and the effective SDK limits of the Claude API. SDK limits
identified by the Phase 7 Stage A spike (IN2):

- Image content block: **10 MB (after base64, raw ~7.5 MB)** / model-specific
  visual-token limit (8,000 px longest side / automatic downscaling at a
  1,568–2,576 px longest side)
- Document content block (PDF): **32 MB / 600 pages** for 1M-context
  requests; **100 pages** below 1M context
- Text content block: no byte limit (depends on the model's context window)
- **Request total: 32 MB hard limit** (total of all attachments after base64)
- Haiku 5.5 supports images and documents, as does the retained Haiku 4.5
  model

| Type | Fit | Reject reason on failure | Library |
|--|--|--|--|
| Image | Downsize resolution / quality → within 10 MB / model-specific px limit | `unfittable_image` | sharp (through the `ImageDownsizer` abstraction; replaceable with sharp-wasm32 / jimp when supporting ADR-0018) |
| PDF | Extract first N pages → within 22 MiB raw / common 100-page limit | `unfittable_pdf` | pdf-lib (pure JS) |
| Text / code | Truncate to first N MB (marked `truncated`) + validate context window with Anthropic SDK's `countTokens` | `text_too_large` | In-house + `@anthropic-ai/sdk` `countTokens` |
| Office (docx/xlsx/pptx) | Convert to text → same as text | Same as above | officeparser (pure JS; markitdown has room as an OQ fallback) |

The provider's higher 1M-context PDF allowance does not change the wrapper's
common cap: `PDF_SDK_PAGE_LIMIT` remains **100 pages**, and
`PDF_SDK_RAW_LIMIT_BYTES` remains **22 MiB** before base64. This fits the
retained Haiku 4.5 model and Haiku 5.5 with
`CLAUDE_CODE_DISABLE_1M_CONTEXT=1`, both of which report 200K context. The
32 MiB total-request check still applies after fitting. The wrapper does not
select a PDF cap by model family. See Anthropic's
[PDF limits](https://platform.claude.com/docs/en/build-with-claude/pdf-support#pdf-support-limitations)
and the [Haiku 5.5 measurement record](../../evidence/claude/sdk-0.3.293-haiku55-2026-10-08.md).

**Zip-bomb guard**: OOXML is a ZIP container, so its compressed size can pass
the 128 MB limit yet expand explosively. The wrapper stops conversion when the
**total uncompressed size** of entries exceeds
`OFFICE_MAX_UNCOMPRESSED_BYTES` (64 MB), and reports it to the caller as a bomb
(`wrapper/claude-code/src/upload.ts`).

When an instruction arrives, the wrapper **pre-validates the total size of all
attachments after base64** and rejects it with
`instruction_rejected{reason="total_request_over"}` if it exceeds 32 MB. It
also fires when the total exceeds the limit after individual fitting. If an
operational need arises to handle over 32 MB, create an OQ for the Files API
route (referencing `file_id`).

## Constraints

- MUST: Rendering (selecting image_block / document_block / text_block and
  converting Office files) is **wrapper-internal**. The protocol, client, and
  server contain no Anthropic API terminology.
- MUST: attachment rendering (image/document/text block choice and Office conversion) is
  **wrapper-internal**. Protocol, client, and server do not use Anthropic API
  terms ([ADR-0025](../../adr/0025-file-upload-wire-and-wrapper-rendering.md) F1).

## Related protocol topics

- [Envelope contract](../protocol/envelope.md).
- [Attachment wire contract](../protocol/attachments.md).
- [Attachments](../../architecture/attachments.md).
- [Engine adapter contract](adapter-contract.md).
