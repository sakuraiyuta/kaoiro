---
title: File-upload wire and wrapper-internal rendering
status: accepted
date: 2026-06-27
opened: 2026-06-27
supersedes: []
superseded_by: null
related_specs: [file-upload, protocol, non-goals]
related_adrs: [9, 15, 20, 21, 34]
---

# ADR-0025 — File-Upload Wire and Wrapper-Internal Rendering

## Status

Accepted

## Context

Under the “addition of a new public protocol surface” allowance accepted by [ADR-0020](0020-dashboard-battery-included-client.md) (battery-included), introduce a mechanism for passing file attachments (images / text / PDF / Office) from the dashboard to Claude Code. The body of issue #52 left four decision points, which were settled as 14 F decisions through my-spec-elicitation.

The central design questions:

1. Which layer owns rendering (choosing SDK content blocks and converting Office files)?
2. How should file bytes travel from client → server → wrapper?
3. Where does the wrapper retain the byte sequence?
4. What are the file limits and MIME rules, where are files rejected, and through which path are rejections notified?
5. What are the semantics of cancel / interrupt?

## Decision

### F1: Rendering is wrapper-internal

The client / server are type-agnostic; do not expose Anthropic API terms (image_block / document_block / text_block, etc.) in the protocol. The wrapper is the only layer that knows the SDK and active model, and decides the rendering type here.

Rejected:

| | Reason |
|--|--|
| Client decides the rendering type | Violates the MUST in architecture.md, “state derivation is the wrapper’s responsibility and the server is agent-independent.” The client would need model knowledge |
| Server decides the rendering | Violates the server’s agent-independent principle |

### F2: Transfer wire = hybrid of (c) + (d)

Use four operations: `attach_open` / `attach_chunk` (binary) / `attach_close` / an extension of `instruction` (referencing `attachment_ids`). Wire details are in [file-upload](../specs/file-upload.md) / [protocol](../specs/protocol.md).

Rejected:

| Option | Reason |
|--|--|
| (a) Include attachments in `instruction` | Pollutes text-only models / reaches the one-frame limit / coarse retry granularity / narrow entry point for third-party clients |
| (b) Include a new `instruction_with_attachments` event | Same frame-size problem as (a), with little benefit |
| (d) Send a standalone binary frame directly | Without an id reference, matching it with the instruction is fragile |
| Separate socket / HTTP POST upload | Erodes ADR-0009’s unification |

### F3: The wrapper’s assembly buffer is memory-only

`pending_uploads` exists only in wrapper memory. Never reach the disk.

Rejected: spill-to-temp-FS / always use temp FS—unnecessary for the MVP and violates the principle of not reaching the disk. Room for the future is left in OQ5.

#### #108 addendum (2026-07-23, maintainer approval): Codex `local_image`-only exception

Codex SDK 0.144.1 accepts image input only as a path through a `local_image` block, not as bytes / base64. Therefore, only in the Codex wrapper, materialise images into a wrapper-private temporary directory after accepting the instruction and pass them to the SDK. Create the directory with `mkdtemp` (0700), files with 0600, include `agent_id` in the prefix, and sweep only its own orphans at the next startup. Do not maintain a format-specific allow-list for `image/*`; if the SDK rejects it, surface it through the existing turn-error path. Apply F4’s uniform 128 MB limit as-is and do not introduce a type-specific cap.

Always delete the file and directory when a turn completes, including success, failure, and interrupt. Leave cleanup failures loudly as stderr warnings, and recover them with a prefix-scoped sweep at the next startup. F11’s interrupt-drop semantics include this temporary-file cleanup. This is a limited acceptance based on the fact that the SDK accepts only path input and that the conversation itself is already persisted to disk by the SDK rollout; the maintainer approved it on 2026-07-23.

### F4: Per-file limit = uniformly 128 MB

Accept diverse inputs—UI screenshots, design data, large papers, and so on—“up to the resource limit.” F10 (fit-to-SDK) absorbs the gap from the SDK’s hard limits.

Rejected: type-specific limits (image 5 MB / PDF 32 MB / text 1 MB / Office 10 MB)—a mechanical copy of API limits, inconsistent with user intent.

### F5: Total cap per instruction = withdrawn

The wrapper’s fit-to-SDK behaviour and RSS are the effective limits.

Rejected: a numerical cap such as 512 MB—contradicts F8 (A4-α) and erodes wrapper unification.

### F6: Count / in-flight caps

- 10 attachments / instruction
- 20 in-flight / wrapper

Rejected: unlimited—do not omit DoS protection and a reasonable UX range.

### F7: MIME allow-list

See [file-upload spec](../specs/file-upload.md) for details.

Rejected: compressed files (zip/tar) / legacy Office (.doc/.xls/.ppt) / video and audio / executable families—larger attack surface / unsupported by the SDK / no use case.

### F8: Where to reject

| Layer | Role |
|--|--|
| client | Has no rules (may optionally provide a UX hint) |
| server | Transport DoS protection (8 MB frame + in-flight cap 20 + operator authorisation) |
| wrapper | Final rule decision (F4–F7) + fit-to-SDK |

Rejected: client-side pre-block (`ext.capabilities` publication)—duplicates wrapper knowledge and erodes wrapper unification. Room for the future is left in OQ2.

### F9: Rejection path = two new envelope types

- `attach_rejected { upload_id, reason, detail? }`
- `instruction_rejected { attachment_ids?, reason, detail? }`

The reason enum’s source of truth is the [file-upload spec](../specs/file-upload.md). Both envelopes are delivered only to operators ([ADR-0021](0021-role-information-disclosure-policy.md)).

Rejected:

| | Reason |
|--|--|
| Put it on the existing `result.is_error` | Do not reuse it, to preserve the semantics of “error at turn completion” |
| Return it in a synchronous push reply | The current kaoiro is primarily fire-and-forget, and this does not fit the server pass-through design |

### F10: The wrapper is responsible for fit-to-SDK

Absorb the gap between the 128 MB protocol limit and the SDK hard limits (image 10 MB / PDF 32 MB / **32 MB hard limit for the total request**, the phase-7 stage-A spike result) on a best-effort basis:

- Downsize images: **sharp** (through the `ImageDownsizer` abstraction; replaceable with sharp-wasm32 / jimp when addressing ADR-0018)
- Extract PDF pages: **pdf-lib** (pure JS)
- Truncate text: in-house + `countTokens` from `@anthropic-ai/sdk` to verify the context window
- Office → text: **officeparser** (pure JS, one lib for docx/xlsx/pptx); the markitdown CLI remains a fallback possibility in Q10 ([file-upload-markitdown-fallback](../open-questions/file-upload-markitdown-fallback.md))

Reject totals over 32 MB with `instruction_rejected{reason="total_request_over"}`. Reject individually impossible items with F9’s dedicated reasons (`unfittable_image` / `unfittable_pdf` / `text_too_large`). See [file-upload](../specs/file-upload.md) for the table.

Practical use of a single file over 32 MB is possible through the Files API path (reference a `file_id`, up to 500 MB per file). The adoption decision is Q9 ([file-upload-files-api-route](../open-questions/file-upload-files-api-route.md)).

Rejected: only “return the SDK rejection as-is”—the gap between the 128 MB cap and the SDK’s smaller limits would break the UX.

### F11: Extend the meaning of `interrupt`

The existing `interrupt` also does the following:

- Drop all pending_uploads for the relevant agent
- If the immediately preceding instruction is being processed inside the SDK, drop the staged attachment bytes
- Emit `attach_rejected{reason="interrupted"}` for each dropped upload_id
- Act even when a turn is not in progress, if uploads exist
- Behave as before when there are no uploads / staged items (preserve forward compatibility)

Rejected: add a separate `attach_cancel` operation—the `interrupt` extension makes it unnecessary.

### F12: UI model = deferred upload

The client rule is unchanged by the protocol. See the file-upload spec for details.

Rejected: immediate upload (picker selection = immediate transfer)—wastes bandwidth on cancellation and depends on TTL.

### F13: TTL = 5 minutes

Discard unreferenced / incomplete entries in `pending_uploads` after 5 minutes. Explicit cancel is F11; TTL is the fail-safe.

Rejected: no TTL—risk of a memory leak.

### F14: Chunk size / parallelism = recommendations only

MVP: 1 chunk is 64 KB; parallelism is up to the client. Do not make them MUSTs, following the policy of “widening the entry point.”

## Consequences

### Positive

- Attachments from the dashboard become available for dogfooding (fulfilling ADR-0020’s intent).
- The protocol remains wire-neutral (independent of API terms), giving third-party clients a broad entry point.
- The server pass-through principle and one-Channels design are maintained ([ADR-0009](0009-client-transport.md) / ADR-0020 F3).
- Rejection on failure is explicit through new envelopes and does not pollute the existing result semantics.
- The permissive 128 MB limit supports diverse files (screenshots / designs / large papers).
- Strengthens kaoiro’s MUST that the wrapper is the per-engine translation layer (architecture.md).

### Negative

- Four operations + two envelope types are added to the public protocol surface (allowed by ADR-0020).
- The wrapper’s responsibilities grow (pending_uploads / fit-to-SDK / Office conversion).
- A spike for Phoenix V2 binary frames and the phoenix.js ArrayBuffer push API is mandatory before implementation (see plan stage A).

### Neutral

- Large-file transfer depends on the client chunker and server frame-limit tuning (8 MB default).
- Fit-to-SDK details (downsize algorithm / page-extraction strategy) are decided in implementation.

## Alternatives Considered

Details are collected in the rejected lines for each F. The main branches are:

- Distribute vs concentrate the rendering layer—F1 adopts concentration (wrapper)
- Transport design (bundled / separate / binary)—F2 adopts the hybrid
- Buffer location (memory / FS)—F3 adopts memory
- Limit policy (per type / uniform)—F4 adopts uniform, with F10 completing fit-to-SDK
- Rejection path (reuse existing result / new envelope)—F9 adopts new envelopes
- Cancel UX (separate operation / extend interrupt)—F11 adopts the extension

## Followups

| OQ | Slug |
|--|--|
| Q1 | [file-upload-fs-read-fallback](../open-questions/file-upload-fs-read-fallback.md) |
| Q2 | Resolved — [ADR-0034](0034-session-capabilities-advertisement.md) F7 |
| Q3 | [file-upload-json-fallback](../open-questions/file-upload-json-fallback.md) |
| Q5 | [file-upload-spill-storage](../open-questions/file-upload-spill-storage.md) |
| Q6 | [file-upload-exif-stripping](../open-questions/file-upload-exif-stripping.md) |
| Q8 | [file-upload-name-collision](../open-questions/file-upload-name-collision.md) |
| Q9 | [file-upload-files-api-route](../open-questions/file-upload-files-api-route.md) |
| Q10 | [file-upload-markitdown-fallback](../open-questions/file-upload-markitdown-fallback.md) |

The phase-7 stage-A spike is complete (see the plan’s “Spike results” section): Phoenix V2 binary serializer specification / confirmation of the phoenix.js ArrayBuffer push API, Claude API limits fixed (image 10 MB / PDF 32 MB / request 32 MB), and fit-to-SDK libraries selected (sharp / pdf-lib / officeparser / Anthropic SDK `countTokens`). Because `max_frame_size` defaults to `:infinity`, it must be explicitly set to approximately 8 MB in operational configuration (reflected in the spec).

## Related

- specs: [file-upload](../specs/file-upload.md) (consolidates this specification), [protocol](../specs/protocol.md) (wire details), and [non-goals](../specs/non-goals.md) (no AV scanning support).
- Related ADRs: [0009](0009-client-transport.md) (one Channels path, maintained by F2), [0015](0015-protocol-version-stamping.md) (version policy, addenda keep the version unchanged), [0020](0020-dashboard-battery-included-client.md) (the upper boundary for this decision, F2 / F3), and [0021](0021-role-information-disclosure-policy.md) (delivery policy; attach_* is operator-only).
- Origin: my-spec-elicitation (#52).
