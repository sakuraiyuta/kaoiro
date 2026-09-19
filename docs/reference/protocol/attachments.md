---
title: Attachment wire contract
description: The attach_open/attach_chunk/attach_close wire, binary frame layout, limits, and the reject path.
status: accepted
last_updated: 2026-09-19
related: [protocol, architecture]
---

# Attachment wire contract

### File-upload wire

These incremental operations let an operator pass dashboard attachments (image, text, PDF,
or Office) to an agent. The protocol surface of record is the directional message table
above, the `attach_rejected` / `instruction_rejected` envelope types, and the binary frame
layout below. Rationale is in
[ADR-0025](../../adr/0025-file-upload-wire-and-wrapper-rendering.md).

**Transport**: Keep the existing single Channels transport
([ADR-0009](../../adr/0009-client-transport.md)); do not add another socket or HTTP POST upload.
The server neither interprets nor persists upload bytes and transparently relays them to the
`wrapper:<agent_id>` channel (no disk access, [ADR-0020](../../adr/0020-dashboard-battery-included-client.md) F3).

**Order**: `attach_open` × N → `attach_chunk*` (parallel allowed) → `attach_close` × N
→ `instruction(attachment_ids=[...])`. On instruction receipt the wrapper verifies every
`attachment_id` completed `attach_close`; incomplete uploads are rejected with
`instruction_rejected{reason="timeout"}` or a corresponding reason.

**`attach_chunk` payload format** (MVP layout inside a V2 binary-frame payload):

The Phoenix V2 binary serializer receives a WebSocket binary-opcode frame and passes the
bytes below to server `handle_in("attach_chunk", {:binary, payload}, socket)` as a
`{:binary, binary()}` tuple (V2 tuple form; do not confuse with V1). phoenix.js automatically
creates the binary frame when an `ArrayBuffer` is passed directly to
`channel.push("attach_chunk", arrayBuffer)`; a Blob must first be converted with
`arrayBuffer()`.

```text
<u32 upload_id_len><upload_id utf8><u32 chunk_index><chunk_bytes>
```

- `upload_id_len`: big-endian unsigned 32-bit UTF-8 byte length of `upload_id`.
- `upload_id`: UTF-8 string, a client-assigned ID unique within the session.
- `chunk_index`: big-endian unsigned 32-bit, zero-based.
- `chunk_bytes`: remaining bytes of the chunk.

Concurrency and chunk size are client-defined (MVP recommendation: 64 KB per chunk,
[ADR-0025](../../adr/0025-file-upload-wire-and-wrapper-rendering.md) F14).

The V2 frame header (`<<kind::8, join_ref_size::8, ref_size::8, topic_size::8,
event_size::8, ...>>`) is handled by Phoenix. Each size field is 8-bit, so join_ref, ref,
topic, and event are each at most 255 bytes (well above kaoiro's
`wrapper:<agent_id>` / `attach_chunk`).

**Transport safety**: The server enforces an 8 MB frame limit for DoS protection; the
20-in-flight-uploads cap (`MAX_INFLIGHT_UPLOADS`) is wrapper-side, not server-enforced.
Phoenix defaults `max_frame_size` to `:infinity`, so endpoint configuration sets it
explicitly:

```elixir
# server/lib/kaoiro_server_web/endpoint.ex
socket "/wrapper", KaoiroServerWeb.WrapperSocket,
  websocket: [max_frame_size: TransportLimits.max_frame_bytes()],  # 8 MB
  longpoll: false
```

Leaving `:infinity` would let one 128 MB frame allocate 128 MB in a receiving process and
risk OOM. The wrapper makes the final decision on per-file size (128 MB), allowed MIME,
count (10 per instruction), and TTL (unreferenced or incomplete chunks are GC'd after five
minutes) (ADR-0025 F4/F6/F7/F13).

**Delivery gate**: `attach_open` / `attach_chunk` / `attach_close` /
`attach_rejected` / `instruction_rejected` are all **operator-only** (allow-list,
[ADR-0021](../../adr/0021-role-information-disclosure-policy.md)); remove them entirely for viewers.

**Fit-to-SDK responsibility**: The wrapper absorbs the gap between the 128 MB protocol
limit and hard SDK limits (exact image/document block values are confirmed by a pre-
implementation spike) using image downsize, PDF page extraction, text truncation, and
Office → markitdown → text. Image and PDF fitting can fail and reject with a dedicated
reason (`unfittable_image` / `unfittable_pdf`); oversized text is always fit by
tail-truncation instead (`TEXT_SDK_BYTE_LIMIT`, 1 MB) and never rejects, so
`text_too_large` — declared in the wire enum for other producers — does not currently
fire from this wrapper.

### Terminology

| Term | Meaning |
|--|--|
| upload | Transfer unit for one file, identified by `upload_id` (allocated by client; unique within a session). |
| chunk | Portion of an upload carried in one binary frame. Size and parallelism are client-defined. |
| pending_uploads | In-memory wrapper buffer retaining bytes assembled from chunks. |
| attachment | Assembled upload referenced by an instruction through `attachment_ids`. |
| fit-to-SDK | Best-effort wrapper work to downsize / extract pages / truncate / convert to meet an SDK's hard limits. |

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
wire" sections of [protocol](../../specs/protocol.md). Overview:

- `attach_open` (text/JSON, client → server → wrapper) announces an upload.
- `attach_chunk` (binary frame, same direction) transfers bytes in chunks. It
  may run in parallel.
- `attach_close` (text/JSON, same direction) signals completion of one upload.
- `instruction` is extended with `{ agent_id, text, attachment_ids? }` to
  reference IDs.

The server relays bytes transparently to the agent channel without interpreting
or persisting them (they never reach disk; [ADR-0020](../../adr/0020-dashboard-battery-included-client.md)
F3).

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
([ADR-0021](../../adr/0021-role-information-disclosure-policy.md)).

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

### TTL and fail-safe

The wrapper discards unreferenced `pending_uploads` after **five minutes**.
Explicit cancellation is issued by `interrupt` (above). TTL is a fail-safe for
client failures / instructions that never arrive.

## Constraints

- MUST: The server does not interpret or persist bytes (agent-independent;
  [ADR-0020](../../adr/0020-dashboard-battery-included-client.md) F3).
- MUST: `attach_open` / `attach_chunk` / `attach_close` / `attach_rejected`
  / `instruction_rejected` are delivered **to operators only**
  ([ADR-0021](../../adr/0021-role-information-disclosure-policy.md)).
- MUST: Transport retains [the single Phoenix Channels route](../../adr/0009-client-transport.md)
  (do not add a separate socket / HTTP POST upload).
- MUST: Add extensions without changing the protocol `version`
  ([ADR-0015](../../adr/0015-protocol-version-stamping.md)); receivers ignore
  unknown keys.
- MUST: The `interrupt` extension is forward compatible (previous behavior
  applies when uploads / staged bytes are absent).

## Open Questions

| ID | Slug | Urgency |
|--|--|--|
| Q1 | [file-upload-fs-read-fallback](../../open-questions/file-upload-fs-read-fallback.md) | low |
| Q2 | Settled — folded into [ADR-0034](../../adr/0034-session-capabilities-advertisement.md) F7 (publish accepted file types through `ext.session_capabilities`) | — |
| Q3 | [file-upload-json-fallback](../../open-questions/file-upload-json-fallback.md) | low |
| Q5 | [file-upload-spill-storage](../../open-questions/file-upload-spill-storage.md) | low |
| Q6 | [file-upload-exif-stripping](../../open-questions/file-upload-exif-stripping.md) | low |
| Q8 | [file-upload-name-collision](../../open-questions/file-upload-name-collision.md) | low |
| Q9 | [file-upload-files-api-route](../../open-questions/file-upload-files-api-route.md) | low |
| Q10 | [file-upload-markitdown-fallback](../../open-questions/file-upload-markitdown-fallback.md) | low |

## See Also

- Related specs: [protocol](../../specs/protocol.md),
  [architecture](../../architecture/system-overview.md), [non-goals](../../architecture/scope.md),
  [threat-model](../../architecture/security-threat-model.md)
- ADRs:
  [0009](../../adr/0009-client-transport.md) (single Channels route),
  [0015](../../adr/0015-protocol-version-stamping.md) (version convention),
  [0020](../../adr/0020-dashboard-battery-included-client.md)(battery-included),
  [0021](../../adr/0021-role-information-disclosure-policy.md) (delivery policy),
  [0025](../../adr/0025-file-upload-wire-and-wrapper-rendering.md) (decision
  rationale for this specification)

## Related protocol topics

- [Envelope contract](envelope.md).
- [Channels and directional messages](channels.md).
- [Attachments](../../architecture/attachments.md).
- [Attachment rendering by engine](../engines/attachment-rendering.md).
- [Runner control and launch](runner-control.md).
