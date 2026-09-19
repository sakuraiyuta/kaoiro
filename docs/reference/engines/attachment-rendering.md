---
title: Attachment rendering by engine
description: Per-engine SDK content-block mapping and fit-to-SDK size/limit handling for attachments.
status: accepted
last_updated: 2026-09-19
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
images accordingly ([plugin-model](../../specs/plugin-model.md)). Protocol limits (128 MB /
20 in flight / five-minute TTL) are common to both engines.

### Fit-to-SDK

The wrapper absorbs the gap between the 128 MB protocol limit (client → server
→ wrapper) and the effective SDK limits of the Claude API. SDK limits
identified by the Phase 7 Stage A spike (IN2):

- Image content block: **10 MB (after base64, raw ~7.5 MB)** / model-specific
  visual-token limit (8,000 px longest side / automatic downscaling at a
  1,568–2,576 px longest side)
- Document content block (PDF): **32 MB / 600 pages** (100 pages for 200K
  context models)
- Text content block: no byte limit (depends on the model's context window)
- **Request total: 32 MB hard limit** (total of all attachments after base64)
- All currently active Claude models (Fable 5 / Mythos 5 / Opus 4.x / Sonnet
  4.6 / Haiku 4.5) support images and documents

| Type | Fit | Reject reason on failure | Library |
|--|--|--|--|
| Image | Downsize resolution / quality → within 10 MB / model-specific px limit | `unfittable_image` | sharp (through the `ImageDownsizer` abstraction; replaceable with sharp-wasm32 / jimp when supporting ADR-0018) |
| PDF | Extract first N pages → within 32 MB / model-specific page limit | `unfittable_pdf` | pdf-lib (pure JS) |
| Text / code | Truncate to first N MB (marked `truncated`) + validate context window with Anthropic SDK's `countTokens` | `text_too_large` | In-house + `@anthropic-ai/sdk` `countTokens` |
| Office (docx/xlsx/pptx) | Convert to text → same as text | Same as above | officeparser (pure JS; markitdown has room as an OQ fallback) |

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

## Related protocol topics

- [Envelope contract](../protocol/envelope.md).
- [Attachment wire contract](../protocol/attachments.md).
- [Attachments](../../architecture/attachments.md).
- [Engine adapter contract](adapter-contract.md).
