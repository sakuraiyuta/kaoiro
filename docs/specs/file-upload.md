---
title: File uploads (attachment intake)
description: Common specification by which the operator passes dashboard attachments (images/text/PDF/Office) to an agent after a wrapper renders them into SDK content blocks.
status: provisional
related: [protocol, architecture, non-goals, threat-model]
---

# File uploads (attachment intake)

## Purpose

Defines how an operator can pass attachments from the dashboard to an agent
(initially Claude Code / Claude Agent SDK). Wire details are in
[protocol](protocol.md); the decision rationale is
[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md).

## Definition

### Terminology

| Term | Meaning |
|--|--|
| upload | Transfer unit for one file, identified by `upload_id` (allocated by client; unique within a session). |
| chunk | Portion of an upload carried in one binary frame. Size and parallelism are client-defined. |
| pending_uploads | In-memory wrapper buffer retaining bytes assembled from chunks. |
| attachment | Assembled upload referenced by an instruction through `attachment_ids`. |
| fit-to-SDK | Best-effort wrapper work to downsize / extract pages / truncate / convert to meet an SDK's hard limits. |

### Responsibilities

| Layer | Responsibility |
|--|--|
| Client (dashboard) | File picker + chunker + ArrayBuffer push. Holds no normative policy (UX hints are optional). |
| Server (Phoenix) | Transparent relay + transport DoS defenses (frame limit and in-flight cap) + operator authorization. Does not interpret envelopes or attach_* (agent-independent). |
| Wrapper (per engine) | pending_uploads management / final normative decisions / fit-to-SDK / conversion to SDK content blocks / reject notification. Rendering is wrapper-internal. |

### Supported file types / MIME

| Category | Permitted |
|--|--|
| Images | `image/png`, `image/jpeg`, `image/webp`, `image/gif` |
| Text | `text/plain`, `text/markdown`, `text/*` (UTF-8 only), `application/json`, `application/xml`, and major source-code MIME types |
| PDF | `application/pdf` |
| Office | OOXML only: docx (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`) / xlsx (`…spreadsheetml.sheet`) / pptx (`…presentationml.presentation`) |
| Rejected | Archives (zip/tar), legacy Office (.doc/.xls/.ppt), video/audio, and executable types |

A wrapper that receives an unsupported MIME returns
`attach_rejected{reason="mime_denied"}`.

### Size, count, and in-flight limits

| Item | Value | Owner |
|--|--|--|
| Per-file limit | **Uniform 128 MB** | wrapper |
| Total size per instruction | **Removed** (wrapper fit-to-SDK and RSS are practical limits) | — |
| Count per instruction | 10 | wrapper |
| In-flight uploads | 20 / wrapper | wrapper |
| Transport frame limit | 8 MB | server |
| TTL (unreferenced upload / incomplete chunks) | Five minutes | wrapper |

### Transfer wire

For wire details, see the "Direction-specific message types" and "File-upload
wire" sections of [protocol](protocol.md). Overview:

- `attach_open` (text/JSON, client → server → wrapper) announces an upload.
- `attach_chunk` (binary frame, same direction) transfers bytes in chunks. It
  may run in parallel.
- `attach_close` (text/JSON, same direction) signals completion of one upload.
- `instruction` is extended with `{ agent_id, text, attachment_ids? }` to
  reference IDs.

The server relays bytes transparently to the agent channel without interpreting
or persisting them (they never reach disk; [ADR-0020](../adr/0020-dashboard-battery-included-client.md)
F3).

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
images accordingly ([plugin-model](plugin-model.md)). Protocol limits (128 MB /
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

### Reject path

When wrapper decisions make an upload unacceptable, the wrapper notifies using
a dedicated envelope type:

| Envelope `type` | Payload | Purpose |
|--|--|--|
| `attach_rejected` | `{ upload_id, reason, detail? }` | Rejection of one upload (validation at attach_close) |
| `instruction_rejected` | `{ attachment_ids?, reason, detail? }` | Rejection of the entire instruction (SDK errors, etc.) |

Reason enum: `size_over` / `mime_denied` / `count_over` / `timeout` /
`interrupted` / `unfittable_image` / `unfittable_pdf` / `text_too_large` /
`total_request_over` / `sdk_error`.

Existing `result.is_error` is not reused so that it retains its meaning of an
"error at turn completion." Both envelopes are delivered to operators only
([ADR-0021](../adr/0021-role-information-disclosure-policy.md)).

### Extended meaning of `interrupt`

The existing `interrupt` operation also does the following:

- **Drops all pending_uploads** for that agent (including chunks in transit)
- **Drops staged attachment bytes** if the previous instruction is processing
  within the SDK
- Fires `attach_rejected{reason="interrupted"}` for every dropped upload_id
- Operates whenever uploads exist even if no turn is in progress (the previous
  no-op condition is relaxed)
- Behaves as before when no uploads / staged bytes exist (preserving forward
  compatibility)

### UI model (deferred upload)

Client rules that do not alter the protocol:

1. **Attachment button or D&D drop zone** → retain files selected by the file
   picker / drop in the client-local "to-send tray" **by reference only** (no
   byte transfer). Limit a drop zone to one agent (for example, the chat-box
   area in AgentDetail) to avoid ambiguity among multiple agents.
2. Remove an item from the tray with ✕ (this is client-local; the protocol is
   uninvolved).
3. Press the send button → transfer in this order: `attach_open` × N →
   `attach_chunk*` → `attach_close` × N →
   `instruction(attachment_ids=[...])`.

Immediate upload when a picker / D&D obtains a file is not adopted (avoids
wasting bandwidth and relying on TTL when cancelling before sending).

### TTL and fail-safe

The wrapper discards unreferenced `pending_uploads` after **five minutes**.
Explicit cancellation is issued by `interrupt` (above). TTL is a fail-safe for
client failures / instructions that never arrive.

## Constraints

- MUST: Rendering (selecting image_block / document_block / text_block and
  converting Office files) is **wrapper-internal**. The protocol, client, and
  server contain no Anthropic API terminology.
- MUST: The server does not interpret or persist bytes (agent-independent;
  [ADR-0020](../adr/0020-dashboard-battery-included-client.md) F3).
- MUST: `attach_open` / `attach_chunk` / `attach_close` / `attach_rejected`
  / `instruction_rejected` are delivered **to operators only**
  ([ADR-0021](../adr/0021-role-information-disclosure-policy.md)).
- MUST: Transport retains [the single Phoenix Channels route](../adr/0009-client-transport.md)
  (do not add a separate socket / HTTP POST upload).
- MUST: Add extensions without changing the protocol `version`
  ([ADR-0015](../adr/0015-protocol-version-stamping.md)); receivers ignore
  unknown keys.
- MUST: The `interrupt` extension is forward compatible (previous behavior
  applies when uploads / staged bytes are absent).
- SHOULD: The client has no normative policy; all rejections follow wrapper
  decisions (UX hints are optional).

## Open Questions

| ID | Slug | Urgency |
|--|--|--|
| Q1 | [file-upload-fs-read-fallback](../open-questions/file-upload-fs-read-fallback.md) | low |
| Q2 | Settled — folded into [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F7 (publish accepted file types through `ext.session_capabilities`) | — |
| Q3 | [file-upload-json-fallback](../open-questions/file-upload-json-fallback.md) | low |
| Q5 | [file-upload-spill-storage](../open-questions/file-upload-spill-storage.md) | low |
| Q6 | [file-upload-exif-stripping](../open-questions/file-upload-exif-stripping.md) | low |
| Q8 | [file-upload-name-collision](../open-questions/file-upload-name-collision.md) | low |
| Q9 | [file-upload-files-api-route](../open-questions/file-upload-files-api-route.md) | low |
| Q10 | [file-upload-markitdown-fallback](../open-questions/file-upload-markitdown-fallback.md) | low |

## See Also

- Related specs: [protocol](protocol.md),
  [architecture](architecture.md), [non-goals](non-goals.md),
  [threat-model](threat-model.md)
- ADRs:
  [0009](../adr/0009-client-transport.md) (single Channels route),
  [0015](../adr/0015-protocol-version-stamping.md) (version convention),
  [0020](../adr/0020-dashboard-battery-included-client.md)(battery-included),
  [0021](../adr/0021-role-information-disclosure-policy.md) (delivery policy),
  [0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) (decision
  rationale for this specification)
