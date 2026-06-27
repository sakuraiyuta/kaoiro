// Wrapper file-upload module — pending_uploads bookkeeping, chunk header
// parsing, MIME / size validation, and SDK content-block assembly +
// fit-to-SDK. Pure functions and a tiny state container — no I/O, no
// transport coupling, so host.ts can drive it deterministically and tests
// can hit each piece.
//
// Spec: docs/specs/file-upload.md. Decision record:
// docs/adr/0025-file-upload-wire-and-wrapper-rendering.md. Handles image
// / text / code / PDF MIMEs at the 128 MB protocol cap, with SDK-side
// fit-to-SDK (sharp for images, pdf-lib for PDFs) reducing oversize
// uploads to image_block / text_block / document_block.

import { Unzip, UnzipInflate } from "fflate";
import { OfficeParser } from "officeparser";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
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

/** Raw-bytes cap for the SDK image content block (Stage A IN2): 10 MB
 *  base64 → ~7.5 MB raw. fit-to-SDK downsizes oversize images below this. */
export const IMAGE_SDK_RAW_LIMIT_BYTES = Math.floor(7.5 * 1024 * 1024);

/** Long-edge pixel cap for SDK image content blocks (Stage A IN2). The
 *  Anthropic API hard-rejects images above this; smaller values cut visual
 *  detail unnecessarily, so the downsizer steps down (8000 → 2576 → 1568)
 *  only when the byte cap forces it. */
export const IMAGE_SDK_LONG_EDGE_MAX = 8000;

/** PDF MIME — rendered as an SDK document content block. */
export const PDF_MIME = "application/pdf";

/** Per-text-block byte budget (file-upload spec): truncate at the head's
 *  1 MB and append a notice so the agent sees the content was clipped.
 *  Anthropic's text content blocks themselves have no byte ceiling — only
 *  the model's context window — but a single attachment >1 MB is almost
 *  always operator error or a runaway file. */
export const TEXT_SDK_BYTE_LIMIT = 1024 * 1024;

/** Per-instruction total request budget (Stage A IN2): every attachment
 *  combined (image base64 + document base64 + text) must fit Claude's 32 MB
 *  hard ceiling on a single request. The wrapper checks this AFTER each
 *  block renders (post-fit-to-SDK), so an instruction with one giant fit
 *  PDF + several smaller files can still surface as total_request_over
 *  even when each file individually passed its own per-file cap. */
export const TOTAL_REQUEST_BYTE_LIMIT = 32 * 1024 * 1024;

/** Allowed Office MIMEs (OOXML only — file-upload spec rejects legacy
 *  .doc / .xls / .ppt). Rendered as text content blocks after an
 *  officeparser extraction pass. */
export const OFFICE_MIME_ALLOW: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/** True for any MIME the wrapper sends through the Office text-extraction
 *  pipeline (docx / xlsx / pptx — file-upload spec). */
export function isOfficeMime(mime: string): boolean {
  return OFFICE_MIME_ALLOW.has(mime);
}

/** Raw-bytes cap for the SDK document content block. Stage A IN2 found the
 *  full request total is 32 MB after base64 (~37% overhead), so the per-file
 *  raw budget is ~22 MB to leave room for the rest of the turn. fit-to-SDK
 *  extracts the largest prefix of pages that fits. */
export const PDF_SDK_RAW_LIMIT_BYTES = 22 * 1024 * 1024;

/** Per-PDF page cap for the SDK document content block. Stage A IN2: 200K
 *  context models (Haiku 4.5) ceiling at 100 pages; Sonnet / Opus accept
 *  600. Targeting the lower bound keeps PDFs working across the active
 *  model fleet without per-model branching. */
export const PDF_SDK_PAGE_LIMIT = 100;

/** Per-file protocol upper limit (file-upload spec / ADR-0025 F4): 128 MB.
 *  Wrapper-side fit-to-SDK reduces oversize uploads to the SDK content
 *  block caps (~7.5 MB raw image, 22 MB raw PDF). */
export const PROTOCOL_FILE_SIZE_LIMIT_BYTES = 128 * 1024 * 1024;

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

/** attach_open validation: MIME allow-list (image / text/code / PDF /
 *  OOXML Office) + advertised size cap. */
export function validateOpen(meta: UploadMeta): ValidationResult {
  if (
    !IMAGE_MIME_ALLOW.has(meta.mime) &&
    !isTextMime(meta.mime) &&
    meta.mime !== PDF_MIME &&
    !isOfficeMime(meta.mime)
  ) {
    return { ok: false, reason: "mime_denied", detail: `mime=${meta.mime}` };
  }
  if (meta.size > PROTOCOL_FILE_SIZE_LIMIT_BYTES) {
    return {
      ok: false,
      reason: "size_over",
      detail: `size=${meta.size} limit=${PROTOCOL_FILE_SIZE_LIMIT_BYTES}`,
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

export interface DocumentContentBlock {
  type: "document";
  source: { type: "base64"; media_type: string; data: string };
}

export type ContentBlock =
  | ImageContentBlock
  | TextContentBlock
  | DocumentContentBlock;

/** Renders fit-to-SDK image bytes into a base64 image content block for
 *  the SDK user message. The caller has validated the MIME is in
 *  IMAGE_MIME_ALLOW and run fit-to-SDK (which may have converted the
 *  MIME, e.g. PNG → JPEG to hit the byte cap). */
export function renderImageBlock(
  mime: string,
  bytes: Uint8Array,
): ImageContentBlock {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mime,
      data: Buffer.from(bytes).toString("base64"),
    },
  };
}

/** Output of a downsizer pass — bytes plus the MIME they are in (the
 *  downsizer may convert PNG → JPEG to hit the byte cap; alpha-PNG is
 *  preserved as PNG instead). */
export interface FitResult {
  bytes: Uint8Array;
  mime: string;
}

/** Pluggable image downsizer (ADR-0018 single-binary-image work expects to
 *  swap sharp's native libvips for sharp-wasm32 or jimp; the interface
 *  isolates that change to one constructor call here). null = unfittable
 *  even after the cheapest output the implementation knows. */
export interface ImageDownsizer {
  fit(bytes: Uint8Array, mime: string): Promise<FitResult | null>;
}

/** sharp-backed downsizer (file-upload spec / ADR-0025 F10). Strategy:
 *  resolution-first long-edge ladder (no change → 8000 → 2576 → 1568 →
 *  1024 → 512) at the original format (PNG with alpha stays PNG; the rest
 *  re-encode as JPEG so quality reduction is a fallback knob). Then JPEG
 *  quality fallback (70 → 50 → 30) at 1568 px for non-alpha images.
 *  Returns null when even the smallest pass overshoots the byte cap. */
export class SharpImageDownsizer implements ImageDownsizer {
  async fit(bytes: Uint8Array, mime: string): Promise<FitResult | null> {
    let meta: { width?: number; height?: number; hasAlpha?: boolean };
    try {
      meta = await sharp(bytes).metadata();
    } catch {
      // sharp throws on a malformed image; surface via null and the
      // caller's unfittable_image reason. (sdk_error vs unfittable_image
      // is fuzzy here; treat as unfittable since the bytes are unusable
      // for this upload no matter what the SDK does.)
      return null;
    }
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const longEdge = Math.max(width, height);

    // Pass-through if already inside both caps.
    if (
      bytes.byteLength <= IMAGE_SDK_RAW_LIMIT_BYTES &&
      longEdge > 0 &&
      longEdge <= IMAGE_SDK_LONG_EDGE_MAX
    ) {
      return { bytes, mime };
    }

    // Alpha-PNG stays PNG (JPEG conversion drops transparency); everything
    // else re-encodes as JPEG so the quality fallback (step 2) has a knob.
    // WebP/GIF inputs are normalised to JPEG too — keeping their formats
    // would require separate quality APIs (webp options, gif → static) and
    // the spec only requires "render to image_block", which JPEG satisfies.
    const keepPng = mime === "image/png" && meta.hasAlpha === true;
    const outFormat: "jpeg" | "png" = keepPng ? "png" : "jpeg";
    const outMime = keepPng ? "image/png" : "image/jpeg";

    async function tryResize(target: number): Promise<Uint8Array> {
      let pipeline = sharp(bytes).resize({
        width: target,
        height: target,
        fit: "inside",
        withoutEnlargement: true,
      });
      pipeline = outFormat === "jpeg" ? pipeline.jpeg() : pipeline.png();
      const buf = await pipeline.toBuffer();
      return new Uint8Array(buf);
    }

    // Step 1: resolution ladder, default encoder quality.
    const startEdge = Math.min(longEdge || IMAGE_SDK_LONG_EDGE_MAX, IMAGE_SDK_LONG_EDGE_MAX);
    for (const target of [startEdge, 2576, 1568, 1024, 512]) {
      if (target > startEdge) continue; // skip up-scales from a small input
      const buf = await tryResize(target);
      if (buf.byteLength <= IMAGE_SDK_RAW_LIMIT_BYTES) {
        return { bytes: buf, mime: outMime };
      }
    }

    // Step 2: JPEG quality fallback at 1568 px (alpha-PNG path stops at
    // step 1 — no quality knob without dropping alpha).
    if (outFormat === "jpeg") {
      for (const quality of [70, 50, 30]) {
        const buf = await sharp(bytes)
          .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer();
        if (buf.byteLength <= IMAGE_SDK_RAW_LIMIT_BYTES) {
          return { bytes: new Uint8Array(buf), mime: outMime };
        }
      }
    }

    return null;
  }
}

/** Default image downsizer instance — used by renderAttachmentBlock unless
 *  the caller passes its own (tests). */
let defaultImageDownsizer: ImageDownsizer = new SharpImageDownsizer();

/** Test seam: swap the downsizer (e.g. to a deterministic mock or a wasm
 *  variant). Production code calls renderAttachmentBlock with the default. */
export function setDefaultImageDownsizer(d: ImageDownsizer): void {
  defaultImageDownsizer = d;
}

/** Convenience function around the configured ImageDownsizer. Returns
 *  null on unfittable so the caller can emit unfittable_image. */
export function fitImageToSdk(
  bytes: Uint8Array,
  mime: string,
): Promise<FitResult | null> {
  return defaultImageDownsizer.fit(bytes, mime);
}

/** Renders one upload's assembled bytes into a SDK text content block,
 *  prefixed with a filename label so the agent has source context. UTF-8
 *  decoded with the default (replacement-character) policy: a non-UTF-8
 *  byte sequence in a `text/*` upload yields U+FFFD rather than a hard
 *  reject — the spec calls for UTF-8 but real-world picks (Shift_JIS PDF
 *  text mis-MIME'd as text/plain by the OS) are common enough that
 *  failing the whole turn over them costs more UX than it gains. Bytes
 *  past TEXT_SDK_BYTE_LIMIT are tail-truncated with a notice (file-upload
 *  spec text fit-to-SDK) so a runaway log file doesn't bloat the SDK
 *  request. The caller has validated the MIME is text-rendered via
 *  isTextMime. */
export function renderTextBlock(
  meta: UploadMeta,
  bytes: Uint8Array,
): TextContentBlock {
  let truncatedNote = "";
  let slice = bytes;
  if (bytes.byteLength > TEXT_SDK_BYTE_LIMIT) {
    slice = bytes.subarray(0, TEXT_SDK_BYTE_LIMIT);
    truncatedNote = `\n\n[...truncated, original ${bytes.byteLength} bytes]\n`;
  }
  const body = new TextDecoder("utf-8").decode(slice);
  return {
    type: "text",
    text: `[file: ${meta.filename}]\n${body}${truncatedNote}`,
  };
}

/** Estimated wire size of a content block, used for the per-instruction
 *  total request budget check (file-upload spec / Stage A IN2 — Anthropic's
 *  32 MB ceiling counts base64-encoded media plus raw UTF-8 text). image
 *  and document blocks carry their base64 payload (ASCII only, so length
 *  IS the byte count) as `source.data`. text blocks must be measured in
 *  UTF-8 bytes — `String.length` counts UTF-16 code units, which
 *  undercounts ~3x for non-ASCII content (e.g. CJK) and would silently
 *  let an over-budget request slip past the cap. */
export function blockWireSize(block: ContentBlock): number {
  if (block.type === "image" || block.type === "document") {
    return block.source.data.length;
  }
  return Buffer.byteLength(block.text, "utf8");
}

/** Renders one upload's assembled bytes (already fit) into a base64
 *  document content block. The caller has validated MIME is PDF (or other
 *  document-class types when added) and run fit-to-SDK. */
export function renderDocumentBlock(
  mime: string,
  bytes: Uint8Array,
): DocumentContentBlock {
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: mime,
      data: Buffer.from(bytes).toString("base64"),
    },
  };
}

/** Best-effort fit of a PDF to the SDK document content block (file-upload
 *  spec / ADR-0025 F10). Strategy: pass-through when already within both
 *  caps; otherwise load via pdf-lib and emit the largest prefix of pages
 *  whose serialised output stays under the raw-bytes cap, bounded by the
 *  page cap. Returns null when even one page does not fit — caller emits
 *  unfittable_pdf. */
export async function fitPdfToSdk(
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  const src = await PDFDocument.load(bytes, { updateMetadata: false });
  const totalPages = src.getPageCount();
  if (
    bytes.byteLength <= PDF_SDK_RAW_LIMIT_BYTES &&
    totalPages <= PDF_SDK_PAGE_LIMIT
  ) {
    return bytes;
  }
  const targetPages = Math.min(totalPages, PDF_SDK_PAGE_LIMIT);

  async function buildPrefix(n: number): Promise<Uint8Array> {
    const out = await PDFDocument.create();
    const indices = Array.from({ length: n }, (_, i) => i);
    const copied = await out.copyPages(src, indices);
    for (const p of copied) out.addPage(p);
    return await out.save();
  }

  // Try the largest acceptable prefix first; if it already fits the byte
  // cap, return immediately to avoid the binary-search round-trips.
  const first = await buildPrefix(targetPages);
  if (first.byteLength <= PDF_SDK_RAW_LIMIT_BYTES) return first;

  // Binary search down for the largest fitting prefix. Each probe rebuilds
  // a PDF (O(N) work); log2(N) probes is acceptable for the page-cap range.
  let lo = 1;
  let hi = targetPages - 1;
  let best: Uint8Array | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const buf = await buildPrefix(mid);
    if (buf.byteLength <= PDF_SDK_RAW_LIMIT_BYTES) {
      best = buf;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Cap on the total uncompressed bytes an OOXML upload may declare in its
 *  ZIP central directory. Defends DefaultOfficeTextExtractor against a
 *  decompression-bomb crafted .docx / .xlsx / .pptx (a small compressed
 *  blob whose entries claim multi-GB expansion can OOM the long-lived
 *  wrapper process before officeparser's try/catch fires). 64 MB covers
 *  legitimate enterprise documents while well under V8's default heap. */
export const OFFICE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

/** Cap on the extracted text length the wrapper hands to the SDK after a
 *  successful Office parse. Even legit huge spreadsheets can serialise to
 *  >10 MB of text; truncation here keeps memory and the eventual SDK
 *  payload bounded. Truncated output is suffixed with a notice so the
 *  agent (and the operator reading the log) sees the cap was hit. */
export const OFFICE_MAX_OUTPUT_CHARS = 8 * 1024 * 1024;

/** Pre-flight check: enumerate the OOXML's ZIP entries via fflate's Unzip
 *  stream (metadata only — we do NOT call file.start(), so no decompression
 *  happens here) and sum the declared uncompressed sizes. Returns false
 *  when the total exceeds OFFICE_MAX_UNCOMPRESSED_BYTES so the caller can
 *  reject before officeparser allocates the bomb. A malformed / non-ZIP
 *  input passes this check (returns true) — officeparser will report its
 *  own format error, and falsely-OOXML text files are not the threat. */
export function officeWithinUncompressedBudget(bytes: Uint8Array): boolean {
  let total = 0;
  let bombed = false;
  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    // file.originalSize is the DECLARED uncompressed size from the local
    // header (the bomb signal); file.size is COMPRESSED size and would let
    // a 100x-ratio bomb slip through. Both are optional on streaming
    // archives that omit the local-header values; fall back to 0 in that
    // case rather than rejecting outright (officeparser then surfaces its
    // own parse error).
    total += file.originalSize ?? 0;
    if (!bombed && total > OFFICE_MAX_UNCOMPRESSED_BYTES) bombed = true;
  };
  try {
    unzipper.push(bytes, true);
  } catch {
    return true;
  }
  return !bombed;
}

/** Pluggable Office text extractor (file-upload spec / ADR-0025 F10).
 *  The interface lets tests swap officeparser for a deterministic stub and
 *  leaves room to fall back to markitdown (Q10) without touching dispatch.
 *  null = unparseable (corrupt / encrypted / format-mismatch / decompression
 *  bomb); caller emits sdk_error. */
export interface OfficeTextExtractor {
  extract(bytes: Uint8Array, mime: string): Promise<string | null>;
}

/** officeparser-backed extractor (pure JS, MIT). Accepts docx / xlsx /
 *  pptx via OOXML magic-byte detection and returns the AST's plain-text
 *  output. Defends against decompression bombs via a fflate-driven
 *  central-directory pre-flight (officeparser exposes no size guard of
 *  its own, v7.2.2) and truncates the output to keep the eventual SDK
 *  payload bounded. Any parse failure becomes null. */
export class DefaultOfficeTextExtractor implements OfficeTextExtractor {
  async extract(bytes: Uint8Array, _mime: string): Promise<string | null> {
    if (!officeWithinUncompressedBudget(bytes)) return null;
    try {
      const buffer = Buffer.from(bytes);
      const ast = await OfficeParser.parseOffice(buffer);
      const text = ast.toText();
      if (text.length > OFFICE_MAX_OUTPUT_CHARS) {
        return (
          text.slice(0, OFFICE_MAX_OUTPUT_CHARS) +
          `\n\n[...truncated at ${OFFICE_MAX_OUTPUT_CHARS} chars]\n`
        );
      }
      return text;
    } catch {
      return null;
    }
  }
}

let defaultOfficeTextExtractor: OfficeTextExtractor =
  new DefaultOfficeTextExtractor();

/** Test seam: swap the Office extractor (e.g. to a deterministic mock).
 *  Production code calls renderAttachmentBlock with the default. */
export function setDefaultOfficeTextExtractor(e: OfficeTextExtractor): void {
  defaultOfficeTextExtractor = e;
}

/** Discriminated render outcome (file-upload spec / ADR-0025 F1). `ok=false`
 *  carries the reason the caller emits on the upload's `attach_rejected`
 *  and / or the instruction's `instruction_rejected`. */
export type RenderResult =
  | { ok: true; block: ContentBlock }
  | { ok: false; reason: FileUploadRejectReason };

/** Dispatches an assembled upload to its SDK content block by MIME
 *  (file-upload spec / ADR-0025 F1: rendering is wrapper-internal). Async
 *  because the PDF path runs an pdf-lib fit-to-SDK pass; image / text are
 *  synchronous internally and the wrapper still pays only one microtask. */
export async function renderAttachmentBlock(
  meta: UploadMeta,
  bytes: Uint8Array,
): Promise<RenderResult> {
  if (IMAGE_MIME_ALLOW.has(meta.mime)) {
    let fitted: FitResult | null;
    try {
      fitted = await fitImageToSdk(bytes, meta.mime);
    } catch {
      return { ok: false, reason: "sdk_error" };
    }
    if (fitted === null) return { ok: false, reason: "unfittable_image" };
    return { ok: true, block: renderImageBlock(fitted.mime, fitted.bytes) };
  }
  if (isTextMime(meta.mime)) {
    return { ok: true, block: renderTextBlock(meta, bytes) };
  }
  if (isOfficeMime(meta.mime)) {
    let text: string | null;
    try {
      text = await defaultOfficeTextExtractor.extract(bytes, meta.mime);
    } catch {
      return { ok: false, reason: "sdk_error" };
    }
    if (text === null) return { ok: false, reason: "sdk_error" };
    // Reuse the text-block render path so the filename prefix and UTF-8
    // policy stay in one place (officeparser already returns a JS string,
    // so re-encoding through TextDecoder would be a no-op — the meta path
    // synthesises bytes via TextEncoder to share the helper).
    return {
      ok: true,
      block: renderTextBlock(meta, new TextEncoder().encode(text)),
    };
  }
  if (meta.mime === PDF_MIME) {
    let fitted: Uint8Array | null;
    try {
      fitted = await fitPdfToSdk(bytes);
    } catch {
      // pdf-lib throws on a malformed PDF (corrupt header / encrypted).
      // Surface it as sdk_error rather than crashing the wrapper.
      return { ok: false, reason: "sdk_error" };
    }
    if (fitted === null) return { ok: false, reason: "unfittable_pdf" };
    return { ok: true, block: renderDocumentBlock(meta.mime, fitted) };
  }
  // validateOpen should have caught this; reaching here means a wrapper
  // bug / type drift, not a user error.
  return { ok: false, reason: "sdk_error" };
}
