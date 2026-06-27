// Wrapper file-upload module — pending_uploads bookkeeping, chunk header
// parsing, MIME / size validation, and SDK content-block assembly. Pure
// functions and a tiny state container — no I/O, no transport coupling, so
// host.ts can drive it deterministically and tests can hit each piece.
//
// Spec: docs/specs/file-upload.md. Decision record:
// docs/adr/0025-file-upload-wire-and-wrapper-rendering.md. Phase-0 scope
// (image only, 5 MB cap, reasons size_over / mime_denied / sdk_error /
// timeout) lives here; phase-1 extends MIME, raises the cap to 128 MB, and
// adds fit-to-SDK.

import type { FileUploadRejectReason } from "@kaoiro/protocol";

/** Allowed image MIMEs (file-upload spec). Render path: image content
 *  block (renderImageBlock). */
export const IMAGE_MIME_ALLOW: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Allowed non-`text/*` MIMEs treated as UTF-8 text by the wrapper
 *  (file-upload spec): JSON / XML / YAML / common source-code MIMEs that
 *  browsers do NOT report under `text/*`. `text/*` itself is matched by
 *  prefix in isTextMime so e.g. `text/x-python` is accepted without an
 *  exhaustive enumeration. */
export const TEXT_MIME_ALLOW: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
  "application/sql",
]);

/** True for any MIME the wrapper renders to a text content block
 *  (file-upload spec). `text/*` is matched by prefix; the remaining
 *  application/* entries are listed in TEXT_MIME_ALLOW. */
export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || TEXT_MIME_ALLOW.has(mime);
}

/** Per-file upper limit for phase-0 (5 MB). Matches Claude API image_block
 *  practical limit (~7.5 MB raw / 10 MB base64; Stage A IN2 finding). The
 *  protocol's 128 MB cap (ADR-0025 F4) lands with the image fit-to-SDK pass. */
export const PHASE_0_SIZE_LIMIT_BYTES = 5 * 1024 * 1024;

/** Cap on attachment references in one instruction (file-upload spec /
 *  ADR-0025 F6). The wrapper rejects the whole turn with reason="count_over"
 *  past this without consuming any of the staged uploads. */
export const MAX_ATTACHMENTS_PER_INSTRUCTION = 10;

/** Cap on concurrently open uploads in a wrapper (file-upload spec / ADR-0025
 *  F6). attachOpen rejects with reason="count_over" once #pendingUploads
 *  reaches this, so a misbehaving client cannot exhaust pending_uploads via
 *  a fan-out of attach_opens without ever sending matching instructions. */
export const MAX_INFLIGHT_UPLOADS = 20;

/** Metadata of an open upload (set by attach_open). */
export interface UploadMeta {
  upload_id: string;
  filename: string;
  mime: string;
  size: number;
  chunks: number;
}

/** Wrapper's pending_uploads entry — accumulating chunks for an open upload.
 *  `sealed` is set by attachClose on success and blocks further mutation
 *  (post-close chunks could silently replace already-validated bytes);
 *  `accumulatedBytes` is the running sum of stored chunk sizes so attachChunk
 *  can enforce the per-upload cap incrementally rather than at attach_close
 *  time (security: prevents unbounded buffering under a misbehaving client). */
export interface PendingUpload {
  meta: UploadMeta;
  /** chunk_index -> chunk bytes; sparse until all chunks land. */
  chunks: Map<number, Uint8Array>;
  sealed: boolean;
  accumulatedBytes: number;
}

/** Parsed `attach_chunk` binary payload (V2 frame's payload internal
 *  layout, file-upload spec). */
export interface ChunkPayload {
  upload_id: string;
  chunk_index: number;
  bytes: Uint8Array;
}

/** Coerces a wire binary payload (ArrayBuffer in browser, Buffer/Uint8Array
 *  in Node ws) to a Uint8Array view over its bytes. */
function asUint8Array(payload: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

/** Parses an `attach_chunk` binary payload into upload_id / chunk_index /
 *  bytes. Format (file-upload spec):
 *  `<u32 upload_id_len BE><upload_id utf8><u32 chunk_index BE><chunk_bytes>`
 *  Throws on a malformed / truncated header so the caller can drop. */
export function parseChunkPayload(
  payload: ArrayBuffer | ArrayBufferView,
): ChunkPayload {
  const buf = asUint8Array(payload);
  if (buf.byteLength < 8) {
    throw new Error("attach_chunk: header too short");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const idLen = view.getUint32(0, false);
  if (buf.byteLength < 4 + idLen + 4) {
    throw new Error("attach_chunk: header truncated");
  }
  const idBytes = buf.subarray(4, 4 + idLen);
  const upload_id = new TextDecoder("utf-8").decode(idBytes);
  const chunk_index = view.getUint32(4 + idLen, false);
  const bytes = buf.subarray(4 + idLen + 4);
  return { upload_id, chunk_index, bytes };
}

/** Outcome of a validation step. The discriminated union forces a reason
 *  whenever ok is false at compile time, so callers do not need to cast
 *  reason from an optional field. */
export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: FileUploadRejectReason; detail?: string };

/** attach_open validation: MIME allow-list (image OR text/code) + advertised
 *  size cap. PDF / Office land here when their fit-to-SDK passes ship. */
export function validateOpen(meta: UploadMeta): ValidationResult {
  if (!IMAGE_MIME_ALLOW.has(meta.mime) && !isTextMime(meta.mime)) {
    return { ok: false, reason: "mime_denied", detail: `mime=${meta.mime}` };
  }
  if (meta.size > PHASE_0_SIZE_LIMIT_BYTES) {
    return {
      ok: false,
      reason: "size_over",
      detail: `size=${meta.size} limit=${PHASE_0_SIZE_LIMIT_BYTES}`,
    };
  }
  return { ok: true };
}

/** Phase-0 attach_close validation: every advertised chunk_index is present
 *  and the assembled total matches the advertised size. */
export function validateClose(upload: PendingUpload): ValidationResult {
  const expected = upload.meta.chunks;
  let total = 0;
  for (let i = 0; i < expected; i++) {
    const chunk = upload.chunks.get(i);
    if (chunk === undefined) {
      return {
        ok: false,
        reason: "timeout",
        detail: `missing chunk ${i}/${expected}`,
      };
    }
    total += chunk.byteLength;
  }
  if (total !== upload.meta.size) {
    return {
      ok: false,
      reason: "size_over",
      detail: `assembled=${total} declared=${upload.meta.size}`,
    };
  }
  return { ok: true };
}

/** Concatenates chunks 0..N-1 in order into one contiguous buffer. Caller
 *  must have run validateClose first; missing chunks throw here. */
export function assembleBytes(upload: PendingUpload): Uint8Array {
  const total = upload.meta.chunks;
  let totalLen = 0;
  for (let i = 0; i < total; i++) {
    const chunk = upload.chunks.get(i);
    if (chunk === undefined) {
      throw new Error(`assembleBytes: missing chunk ${i}/${total}`);
    }
    totalLen += chunk.byteLength;
  }
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (let i = 0; i < total; i++) {
    const chunk = upload.chunks.get(i) as Uint8Array;
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** SDK content blocks the wrapper composes for the user message
 *  (file-upload spec / ADR-0025 F1: rendering is wrapper-internal). Phase-0
 *  uses image only; phase-1 adds document and text. */
export interface ImageContentBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface TextContentBlock {
  type: "text";
  text: string;
}

export type ContentBlock = ImageContentBlock | TextContentBlock;

/** Renders one upload's assembled bytes into a base64 image content block
 *  for the SDK user message. The caller has validated the MIME is in
 *  IMAGE_MIME_ALLOW. */
export function renderImageBlock(
  meta: UploadMeta,
  bytes: Uint8Array,
): ImageContentBlock {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: meta.mime,
      data: Buffer.from(bytes).toString("base64"),
    },
  };
}

/** Renders one upload's assembled bytes into a SDK text content block,
 *  prefixed with a filename label so the agent has source context. UTF-8
 *  decoded with the default (replacement-character) policy: a non-UTF-8
 *  byte sequence in a `text/*` upload yields U+FFFD rather than a hard
 *  reject — the spec calls for UTF-8 but real-world picks (Shift_JIS PDF
 *  text mis-MIME'd as text/plain by the OS) are common enough that
 *  failing the whole turn over them costs more UX than it gains. The
 *  caller has validated the MIME is text-rendered via isTextMime. */
export function renderTextBlock(
  meta: UploadMeta,
  bytes: Uint8Array,
): TextContentBlock {
  const body = new TextDecoder("utf-8").decode(bytes);
  return { type: "text", text: `[file: ${meta.filename}]\n${body}` };
}

/** Dispatches an assembled upload to its SDK content block by MIME
 *  (file-upload spec / ADR-0025 F1: rendering is wrapper-internal). Adds
 *  a graceful sdk_error path via the caller for an unrecognised MIME —
 *  validateOpen should have rejected it, so reaching this branch is a
 *  bug, not a user-facing error. Callers throw on null and the host
 *  surfaces it as instruction_rejected{sdk_error}. */
export function renderAttachmentBlock(
  meta: UploadMeta,
  bytes: Uint8Array,
): ContentBlock | null {
  if (IMAGE_MIME_ALLOW.has(meta.mime)) return renderImageBlock(meta, bytes);
  if (isTextMime(meta.mime)) return renderTextBlock(meta, bytes);
  return null;
}
