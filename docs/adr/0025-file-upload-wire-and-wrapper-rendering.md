---
title: Wire and wrapper-in  rendering of file upload
status: accepted
date: 2026-06-27
opened: 2026-06-27
supersedes: []
superseded_by: null
related_specs: [file-upload, protocol, non-goals]
related_adrs: [9, 15, 20, 21, 34]
---

# ADR-0025 — file upload wire and wrapper-in  rendering

## Status

Accepted

## Context

[ADR-0020](0020-dashboard-battery-included-client.md)(battery-included)
Adding new public protocol surfaces from the dashboard
File attachment (image / text / PDF / Office) to Claude Code
permission #52 issue The body has four decisions
14 F decisions in my-spec-elicitation.

Design Center:

1. Responsibilities for rendering (S  content block Office and Office conversion)
Which layer can I apply?
2. How to transport files bytes to client → server → wrapper?
3. Where do wrappers hold byte columns?
4. What is the limit of the file / MIME norm / where to play / reject notification path?
5. What is semantics for cancel / interrupt?

## Decision

### F1: rendering wrapper-in

client / server is type-agnostic, protocol to Anthropic API terms
(image block / document block / text block, etc.) wrapper
The only layer to know the SDK and the active model.

rejected:

| |Reason|
|--|--|
|client determines rendering type|"statederive is against wrapper, server is not agent" MUST(architecture.md). client needs model knowledge|
|server determines rendering|agent non-dependent principle violation|

### F2: Transfer wire = (c)+(d) Hy d

`attach_open` / `attach_chunk` (binary) / `attach_close` / `instruction` expansion
4  configuration (see `attachment_ids`). wire
[file-upload](../specs/file-upload.md) / [protocol](../specs/protocol.md).

rejected:

||Reason|
|--|--|
| (a) `instruction`|text-only The model gets dirty / 1 frame maximum reach / Retry grain size coarse / narrow gap to a third party client|
| (b) `instruction_with_attachments`New event included|(a) Same frame size problem, Merit small|
|(d) binary|id without reference instructionile|
|socket / HTTP POST upload|ADRHome9 erosion|

### F3: wrapper assembly buffer = full memory

`pending_uploads` is the only memory in the wrapper. Disk unattended.

rejected: spill-to-temp-FS / constant temp FS — MVP no longer required, non-disk Principles violation.
OQ5

#### #108 Supplement (2026 -23, Master approval): Codex`local_image`s

Codex SDK 0.144.1
`local_image` block codex wrapper**Image only**Note
wrapper-wrapper temp directory
directory includes `mkdtemp` (0700), file is 0600, prefix is `agent_id`,
Start only orphan at the next startup. `image/*` does not have allow-list,
If the SDK is unreceptable, it will be superficial by the existing turn error path. Maximum F4 is 128 MB
Do not apply any type of cap.

Always delete file and directory when the turn is complete, including success, failure, and interrupt.
The cleanup failure remains in the loud with the stderr warn, and is recovered with the next startup prefix-scoped failure.
This temp file cleanup is included in the F11 interrupt drop semantics. SDK
path Only accepts the input, the content of the conversation itself is already disk persisted by the SDK rollout
This is a limited acceptance decision based on that, and the master approved 2026.-23.

### F4: Maximum Individual File = 128 MB

"Resources" various inputs such as UI, design data, large articles, etc.
"Receive" to the girth. F10 (fit-to-S )
is absorbed.

rejected: maximum per type (image 5MB / PDF 32MB / text 1MB / Office 10MB) —
Unmatched with user intentions in administrative copy of the API limit.

### F5: 1 instruction Total size cap = removal

wrapper fit-to-S  and RSS are virtually the upper limit.

rejected: Inconsistent with 512 MB, etc. cap — F8 (A4-α), ignore wrapper centralization.

### F6: Point number / in-flight cap

- Attach 10 / instruction
- in-flight 20 / wrapper

rejected: unlimited — DoS defense and no valid range on UX.

### F7: MIME Permit List

See [file-upload spec](../specs/file-upload.md) for details.

rejected: zip/tar/ old Office(.doc/.xls/.ppt)
execution file system — attack surface increase / SDK non-compliant / no application.

### F8: Playing place

||Function|
|--|--|
| client |UX hint|
| server |Transport DoS Defending (frame 8 MB + in-flight cap 20 operator + authorization)|
| wrapper |Final judgment (F4-F7) + fit-to-S |

rejected: client-side pre-block(`ext.capabilities` publish)— wrapper knowledge
with overlapping, wrapper centralization. OQ2

### F9: reject route = new envelope  type 2 pieces

- `attach_rejected { upload_id, reason, detail? }`
- `instruction_rejected { attachment_ids?, reason, detail? }`

reason enum is a [file-upload spec](../specs/file-upload.md).
Both envelope s are only available
([ADR-0021](0021-role-information-disclosure-policy.md)).

rejected:

| |Reason|
|--|--|
|Existing`result.is_error`permission|Do not use it to keep the meaning of "error at completion of turns"|
|push reply with reply|current kaoiro does not match fire-and-forget   with server|

### F10: wrapper fit-to-S  responsibility

128 MB protocol upper and hard upper limit of the SDK (image 10 MB / PDF 32 MB /
**32 MB hard limit**Phase 7
best-effort to absorb gaps:

- Image downsize:**sharp**ADR-0018
sharp-wasm32
- PDF page-extract: **pdf-lib**(pure JS)
- text truncate: `countTokens`
window validation
- Office → text: **officeparser**(pure JS, docx/xlsx/pptx 1 lib),
markitdown CLI is Q10 ([file-upload-markitdown-fallback](../open-questions/file-upload-markitdown-fallback.md))
fallback room

Total 32 MB in `instruction_rejected{reason="total_request_over"}`
Rejected. F9(`unfittable_image` / `unfittable_pdf` /
`text_too_large`) Details
[file-upload](../specs/file-upload.md)

>32 MB single file can be used with the Files API path (see `file_id`)
(1 file up to 500 MB). Adopt Judge Q9
([file-upload-files-api-route](../open-questions/file-upload-files-api-route.md)).

rejected: "If S  is rejected, it will be returned as it is" — 128 MB cap and SDK
UX collapse with a small-end gap.

### F11: `interrupt`Meaning extension

`interrupt`

- pending uploads of the agent
- Last minute instruction is in the SDK.
- `attach_rejected{reason="interrupted"}` is fired per drop upload id
- turn If the uploads are not in progress
- uploads / staged

rejected: Add `attach_cancel` to `interrupt`.

### F12: UI model = delay upload

protocol Unchanged client norm. See file-upload  for details.

rejected: instant upload(picker upload = instant transfer)—band wasting on cancellation,
TTL dependency.

### F13: TTL = 5 minutes

`pending_uploads` is destroyed in 5 minutes. Close
F11, TTL fail-safe.

rejected: TTL None — memory leak risk.

### F14: Chunk size/parallelity = Recommended value only

MVP: 1 chunk 64 KB, Parallelity client optional. To MUST on a route that extends the mouth
not.

## Consequences

### Positive

- Dashboard attachments can be dogfooding (ADR-0020).
- protocol is wire neutral (API terminology non-dependent) and the third-party client implementation is wide.
- Server Basic Principles and Channels
  ([ADR-0009](0009-client-transport.md) / ADR-0020 F3).
- The rejection at failure is expressed in the new envelope  and does not stain the semantics of the existing result.
- Supports a wide variety of files (sthe relevant entry / design / large paper) with a tolerance of 128 MB.
- Enhanced "kaoiro MUST" as per-arch translation layer.

### Negative

- Two types of public protocols (ADR-0020 is acceptable)
- More wrapper responsibilities (pending uploads / fit-to-S Office / Office conversion).
- binary V2 binary frame and phoenix.js Array push push API
spike (see Plan Stage A).

### Neutral

- Large file transmission depends on client chunker and server frame upper limit adjustment (8 MB default).
- The details of fit-to-S  (downsize algorithm / page-extract strategy) will be implemented.

## Alternatives Considered

Details are aggregated in each F rejected line. Main Features:

- Rendering Layer Dispersion vs Concentration — adopt wrapper
- transport design (containing / separation / binary) — hybrid Adopt in F2
- buffer place (memory / FS) — memory adopt with F3
- High-end policy (per type / one unit) — A flat adopt in F4, fit-to-S  completion in F10
- refusal route (existing result flow / new envelope ) — new envelope  Adopt in F9
- cancel UX (ex  op / interrupt extension) — extended adopt with F11

## Followups

| OQ |Slag|
|--|--|
| Q1 | [file-upload-fs-read-fallback](../open-questions/file-upload-fs-read-fallback.md) |
| Q2 |—ed — [ADR-0034](0034-session-capabilities-advertisement.md) F7|
| Q3 | [file-upload-json-fallback](../open-questions/file-upload-json-fallback.md) |
| Q5 | [file-upload-spill-storage](../open-questions/file-upload-spill-storage.md) |
| Q6 | [file-upload-exif-stripping](../open-questions/file-upload-exif-stripping.md) |
| Q8 | [file-upload-name-collision](../open-questions/file-upload-name-collision.md) |
| Q9 | [file-upload-files-api-route](../open-questions/file-upload-files-api-route.md) |
| Q10 | [file-upload-markitdown-fallback](../open-questions/file-upload-markitdown-fallback.md) |

Phase 7 Stage A spike completed (see “Resultike Result” section in plan): Phase
V2 binary serializer specification / phoenix.js Array push push API
API limit (image 10 MB / PDF 32 MB / request 32 MB), fit-to-S
pdf-lib / officeparser / Anthropic SDK
`countTokens`. `max_frame_size` is the default `:infinity`.
8 MB required (spec reflected).

## Related

-COs: [file-upload](../specs/file-upload.md)
[protocol](../specs/protocol.md)(wire details),
[non-goals](../specs/non-goals.md)
- ADR
[0009](0009-client-transport.md)
[0015](0015-protocol-version-stamping.md)
[0020](0020-dashboard-battery-included-client.md)
[0021](0021-role-information-disclosure-policy.md)
- Origin: my-spec-elicitation(#52)
