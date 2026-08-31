---
title: File Upload (Attachment Ingestion)
description: Enable passing images/text/PDF/Office files from the dashboard to Claude Code — in three stages: pre-spike + single-image E2E + feature-complete MVP.
status: done
phase: 7
depends_on: [phase-3.5-response-display, phase-4-host-runner]
last_updated: 2026-07-03
---

# Phase 7 — File Upload (Attachment Ingestion)

Implement [file-upload spec](../specs/file-upload.md) and
[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md). Proceed in
three substages (Stage A → B → C).

## Stage A — pre-spike (pre-work confirmation)

| Item | Purpose | Output |
|--|--|--|
| IN1 | Phoenix V2 binary-frame wire format / phoenix.js ArrayBuffer push API / default `max_frame_size` | Spike notes (at the bottom of this file), wire details finalized (header format: u32 vs varint, etc.) |
| IN2 | Exact limits for Claude API image_block / document_block | Fit-to-SDK thresholds finalized |
| IN3 | Fit-to-SDK library selection (image: sharp candidate / PDF: pdf-lib candidate / Office: markitdown CLI integration) | Selected library finalized; license and dependency size confirmed |

Completion criterion: record the conclusions for the three items above in “Spike
Results” in this file, and update the numbers and wire details in the spec /
ADR-0025 as needed.

## Stage B — phase-0: Single-image end-to-end (minimal demonstrable slice)

Demonstrate the skeleton of the wire / authorization / transparent relay / wrapper
pending_uploads / SDK content-block conversion through the smallest code path.

### IN (included)

- One image file / instruction (PNG / JPEG / WebP / GIF, 5 MB limit; adjust the
  number after Stage A confirmation)
- Implement all wire operations: `attach_open` / `attach_chunk` (binary) /
  `attach_close` / `instruction` extension (`attachment_ids`) /
  `attach_rejected` / `instruction_rejected`
- wrapper: pending_uploads (in-memory only), direct image → image_block delivery;
  reject reasons are limited to `size_over` / `mime_denied` / `sdk_error`
- server: transparent binary relay, operator authorization guard, frame limit (8 MB),
  in-flight cap (20)
- client: simple file picker (one file), upload → instruction from the send button,
  reject toast display
- E2E confirmation: dashboard sends one file → wrapper SDK accepts image_block →
  turn response appears

### OUT (explicitly excluded)

- Multiple files, PDF / text / code / Office
- Fit-to-SDK (downsize / page-extract / truncate)
- Uniform 128 MB cap (provisional through the MVP)
- `interrupt` extension (uploads drop)
- Five-minute TTL GC
- Progress UI / delayed upload tray / multi-select UX
- The complete reject-reason enum

### Layered Slices (order)

| Order | Layer | Contents |
|--|--|--|
| A | docs | spec / ADR / non-goals / index (complete in this session) |
| B | wrapper | pending_uploads + image → image_block conversion + reject emission |
| C | server | transparent binary relay + operator authorization + transport safety valve |
| D | client | file picker (one file) + chunker + ArrayBuffer push + reject display |
| Acceptance | E2E | dashboard sends one file → confirm SDK response |

## Stage C — phase-1: Feature-complete MVP

Fully expand the features while keeping Stage B's wire unchanged. Session 1 (backend
a-f) was completed on 2026-06-27 (commits `245b927` through `dc632e1`, wrapper 197
tests + dashboard 49 + server 215 green). Session 2 (UI g/h/i) was also completed
the same day (commits `ac6be01` through `3ea6224`, dashboard 49 tests green,
svelte-check 0/0).

### Progress

| ID | Item | Status |
|--|--|--|
| (a) | Multiple files + multi-select picker | done (245b927) |
| (b1) | Add text/code types | done (5c405f3) |
| (b2) | PDF type + pdf-lib fit-to-SDK | done (e89ed5a) |
| (d-image) | Image fit-to-SDK + ImageDownsizer abstraction + protocol cap 128MB | done (c2ddcd6) |
| (b3) | Office type + officeparser + fflate decompression-bomb protection | done (6231c26) |
| (d-text) | Truncate text tail + pre-validate every request at 32MB | done (b34d543) |
| (e) | `interrupt` extension (pending_uploads drop) | done (4dd835a) |
| (f) | Five-minute TTL GC + timeout reject | done (dc632e1) |
| (h) | Delayed upload-tray UX (chip containerization + count display) | done (ac6be01) |
| (g) | Per-upload progress UI (mini bar inside chip) | done (7cd8a26) |
| (i) | D&D drop zone (composer area + hover outline) | done (3ea6224) |

### IN (included)

- Multiple files (10 / instruction, in-flight 20), multi-select picker
- All types: image + text / code + PDF + Office (docx / xlsx / pptx via
  officeparser; the markitdown CLI fallback is Q10 OQ)
- Uniform 128 MB per-file limit, no total cap
- Wrapper fit-to-SDK:
  - Image = downsize above the API limit; reject as `unfittable_image` when impossible
  - PDF = extract the first N pages above the limit or reject as `unfittable_pdf`
  - Text/code = truncate above 1 MB with a `truncated` marker
  - Office = officeparser AST → text path (pre-flight decompression-bomb protection with fflate, 8 MB character output cap)
- Complete reject-reason enum (`size_over` / `mime_denied` / `count_over` /
  `timeout` / `interrupted` / `unfittable_image` / `unfittable_pdf` /
  `text_too_large` / `total_request_over` / `sdk_error`)
- `interrupt` extension: pending_uploads drop + staged attachment drop + emit
  `attach_rejected{reason="interrupted"}`
- Five-minute TTL GC (unreferenced + incomplete-chunk uploads)
- Per-upload progress UI
- Delayed upload-tray UX (removable with ✕)
- D&D drop zone (limited to the AgentDetail chat-box area, with hover emphasis)

### OUT (follow-up candidates)

- Q1 ([file-upload-fs-read-fallback](../open-questions/file-upload-fs-read-fallback.md)):
  decide whether to switch if (1) causes memory/speed problems
- Q2: Resolved — publishing accepted types was absorbed into
  `ext.session_capabilities` by F7 of
  [ADR-0034](../adr/0034-session-capabilities-advertisement.md)
- Q3 ([file-upload-json-fallback](../open-questions/file-upload-json-fallback.md)):
  if a simple-client request arises
- Q5 ([file-upload-spill-storage](../open-questions/file-upload-spill-storage.md)):
  if parallel uploads make RSS a problem
- Q6 ([file-upload-exif-stripping](../open-questions/file-upload-exif-stripping.md)):
  if sensitive-image operations arise
- Q8 ([file-upload-name-collision](../open-questions/file-upload-name-collision.md)):
  if the client requests disambiguation

### Layered Slices

Use the same A→B→C→D order as Stage B and add features incrementally. Proceed in
small slices, targeting one feature per PR.

## Spike Results (completed 2026-06-27)

Research completed with three parallel subagents. Reflected in the spec / ADR-0025 /
protocol.md.

### IN1: Phoenix V2 binary frame + phoenix.js ArrayBuffer push

- The V2 serializer receives the WebSocket binary opcode and passes the payload to
  `handle_in/3` as a **`{:binary, data}` tuple** (note that it is not raw binary;
  V1 requires a map, while V2 accepts any JSON value + binary tuple).
- V2 binary wire frame:
  `<<kind::8, join_ref_size::8, ref_size::8, topic_size::8, event_size::8,
  join_ref, ref, topic, event, data>>`. Since each size is one byte, join_ref /
  ref / topic / event are **at most 255 bytes each**. kaoiro's
  `wrapper:<agent_id>` / `attach_chunk`, etc. have ample room.
- phoenix.js **directly supports `ArrayBuffer` in `channel.push(event, payload)`**
  (automatically producing a binary frame). Blob must first be converted with
  `arrayBuffer()`. Phoenix 1.7 / 1.8 behave identically.
- The default `max_frame_size` is **`:infinity`**. Explicitly configure
  `max_frame_size: 8_000_000` in the `:websocket` keyword of endpoint `socket/3`
  (OOM protection). The example is reflected in protocol.md.

### IN2: Claude API content block limits

| Type | Effective limit |
|--|--|
| image (after base64) | **10 MB** (5 MB for Bedrock/Vertex) |
| Image resolution | Long edge 8000 px; above 20 images, each edge is forcibly reduced to 2000 px |
| Images / request | 100 for 200K-context models (Haiku 4.5), 600 for others |
| document (PDF) | **32 MB / 600 pages** (100 pages for 200K-context models) |
| **Request total** | **32 MB hard limit** |
| text | No byte limit (depends on the model's context window) |
| Via Files API (`file_id`) | **500 MB** per file, 500 GB for the entire organization (beta header `files-api-2025-04-14` required) |

- As of 2026, all active Claude models (Fable 5 / Mythos 5 / Opus 4.x /
  Sonnet 4.6 / Haiku 4.5) support image / document. There are no models
  without image support.
- Agent SDK `query()` content block shape:
  `{role: "user", content: [{type:"image", source:{type:"base64",
  media_type, data}}, {type:"text", text}]}`. `source.type` is
  `base64` / `url` / `file_id`.
- **Decision**: Adopt D-A1 = (α) base64 inline only; file the Files API as a
  future trigger in Q9. Explicitly state the SDK limits in the fit-to-SDK
  section of spec / ADR-0025 F10, and add a path for the wrapper to pre-validate
  the 32 MB total when an instruction arrives and reject it with
  `instruction_rejected{reason="total_request_over"}` (already added to the
  reason enum).

### IN3: fit-to-SDK library selection

| Category | Adopted (MVP) | OQ (future) |
|--|--|--|
| Image downsize | **sharp** (Apache-2.0, native libvips, 40–50x faster) + `ImageDownsizer` abstraction | Replace with sharp-wasm32 / jimp for ADR-0018 single-binary support |
| PDF page extraction | **pdf-lib** (MIT, pure JS, `copyPages`/`removePage`) | — |
| Office (docx/xlsx/pptx) → text | **officeparser** (MIT, pure JS, one library for all 3 formats) | Room for markitdown CLI fallback in Q10 |
| Text truncation | In-house + `@anthropic-ai/sdk` `countTokens` (billing-grade accuracy) | Local approximation with gpt-tokenizer (if needed) |

- Bundle increase: +35–50 MB with sharp (native dependency) / +5–7 MB
  with jimp (pure JS). Since replacement is assumed when implementing ADR-0018
  single-binary support, put the `ImageDownsizer` interface in place from the
  start.
- The markitdown path has my-markitdown skill assets, but its Python dependency
  does not fit ADR-0018, so retain it as fallback room in Q10.

### Additional OQs (derived from spike results)

- Q9: [file-upload-files-api-route](../open-questions/file-upload-files-api-route.md)
  — Files API path for handling over 32 MB
- Q10: [file-upload-markitdown-fallback](../open-questions/file-upload-markitdown-fallback.md)
  — markitdown fallback for Office conversion

### Stage A completion criteria

- [x] IN1 / IN2 / IN3 spikes completed
- [x] Numbers, wire details, and library choices reflected in spec / ADR-0025 / protocol.md
- [x] Q9 / Q10 added to open-questions
- [x] (Go signal to begin Stage B)

## Followups

Decision to file each OQ: confirm with the user when Stage C is complete, and
create individual issues only for those needed. Implementation of Stages A–C
was completed on 2026-06-27; this filing decision is the only remaining work in
this phase (non-implementation curation).
