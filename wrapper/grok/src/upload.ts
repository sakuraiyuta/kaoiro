// Attachment intake and prompt blocks for the Grok adapter (ADR-0025). The
// wire helpers are copies of the Claude Code and Codex adapters'; the
// blocks are ACP content blocks. Measurements behind the limits:
// docs/evidence/grok/2026-11-15-attachment-delivery-routes.md.

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { Unzip, UnzipInflate } from "fflate";
import { OfficeParser } from "officeparser";
import {
  makeAttachRejected,
  makeInstructionRejected,
  type Envelope,
  type FileUploadRejectReason,
  type InstructionRejectedPayload,
  type KaoiroState,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import { clipUtf16Head, clipUtf8Head, utf8HeadEnd } from "@kaoiro/wrapper-core";

export const PROTOCOL_FILE_SIZE_LIMIT_BYTES = 128 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_INSTRUCTION = 10;
export const MAX_INFLIGHT_UPLOADS = 20;
export const PENDING_UPLOAD_TTL_MS = 5 * 60 * 1000;
export const PENDING_UPLOAD_GC_INTERVAL_MS = 60 * 1000;
export const TEXT_BYTE_LIMIT = 1024 * 1024;
export const OFFICE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const OFFICE_MAX_OUTPUT_CHARS = 8 * 1024 * 1024;
/** ADR-0025 F10 for Grok: 32 MiB less 64 KiB. Grok repeats a prompt's text
 *  blocks in `_x.ai/queue/changed`, and the ACP SDK closes the connection on
 *  an incoming message over 32 MiB; the 64 KiB covers that envelope. */
export const PROMPT_BYTE_LIMIT = 32 * 1024 * 1024 - 64 * 1024;

export const IMAGE_MIME_ALLOW: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export const TEXT_MIME_ALLOW: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
  "application/sql",
]);
export const OFFICE_MIME_ALLOW: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
export const PDF_MIME = "application/pdf";

export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || TEXT_MIME_ALLOW.has(mime);
}
export function isOfficeMime(mime: string): boolean {
  return OFFICE_MIME_ALLOW.has(mime);
}

export interface UploadMeta {
  upload_id: string;
  filename: string;
  mime: string;
  size: number;
  chunks: number;
}

export interface PendingUpload {
  meta: UploadMeta;
  chunks: Map<number, Uint8Array>;
  sealed: boolean;
  accumulatedBytes: number;
  addedAt: number;
}

export interface ChunkPayload {
  upload_id: string;
  chunk_index: number;
  bytes: Uint8Array;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: FileUploadRejectReason; detail?: string };

function asUint8Array(payload: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

/** `<u32 upload_id_len BE><upload_id utf8><u32 chunk_index BE><bytes>`. */
export function parseChunkPayload(
  payload: ArrayBuffer | ArrayBufferView,
): ChunkPayload {
  const buf = asUint8Array(payload);
  if (buf.byteLength < 8) throw new Error("attach_chunk: header too short");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const idLen = view.getUint32(0, false);
  if (buf.byteLength < 4 + idLen + 4) {
    throw new Error("attach_chunk: header truncated");
  }
  return {
    upload_id: new TextDecoder().decode(buf.subarray(4, 4 + idLen)),
    chunk_index: view.getUint32(4 + idLen, false),
    bytes: buf.subarray(4 + idLen + 4),
  };
}

export function validateOpen(meta: UploadMeta): ValidationResult {
  if (
    !Number.isInteger(meta.size) || meta.size < 0 ||
    !Number.isInteger(meta.chunks) || meta.chunks <= 0
  ) {
    return {
      ok: false,
      reason: "size_over",
      detail: `invalid metadata size=${meta.size} chunks=${meta.chunks}`,
    };
  }
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

export function validateClose(upload: PendingUpload): ValidationResult {
  let total = 0;
  for (let index = 0; index < upload.meta.chunks; index += 1) {
    const chunk = upload.chunks.get(index);
    if (chunk === undefined) {
      return { ok: false, reason: "timeout", detail: `missing chunk ${index}/${upload.meta.chunks}` };
    }
    total += chunk.byteLength;
  }
  if (total !== upload.meta.size) {
    return { ok: false, reason: "size_over", detail: `assembled=${total} declared=${upload.meta.size}` };
  }
  return { ok: true };
}

export function assembleBytes(upload: PendingUpload): Uint8Array {
  const out = new Uint8Array(upload.meta.size);
  let offset = 0;
  for (let index = 0; index < upload.meta.chunks; index += 1) {
    const chunk = upload.chunks.get(index);
    if (chunk === undefined) throw new Error(`missing chunk ${index}`);
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** An instruction's uploads, moved out of the pending set when the
 *  instruction arrived. Until its turn starts an interrupt can drop it. */
export interface StagedRecord {
  readonly ids: readonly string[];
  readonly uploads: readonly PendingUpload[];
  readonly dropped: boolean;
  /** Set while the record's turn is queued; the drop step calls it. */
  onDrop: (() => void) | undefined;
  /** The record leaves the intake: its turn starts or is settled otherwise. */
  finish(): void;
  /** Refuses the instruction while it is built; its uploads are discarded. */
  refuse(reason: FileUploadRejectReason, detail?: string): void;
}

interface RecordOwner {
  leave(record: Staged): void;
  rejectInstruction(payload: InstructionRejectedPayload): void;
}

class Staged implements StagedRecord {
  dropped = false;
  onDrop: (() => void) | undefined;
  readonly #owner: RecordOwner;
  constructor(
    readonly ids: readonly string[],
    readonly uploads: readonly PendingUpload[],
    owner: RecordOwner,
  ) {
    this.#owner = owner;
  }
  finish() {
    this.#owner.leave(this);
  }
  refuse(reason: FileUploadRejectReason, detail?: string) {
    this.#owner.leave(this);
    this.#owner.rejectInstruction({
      attachment_ids: [...this.ids],
      reason,
      ...(detail === undefined ? {} : { detail }),
    });
  }
}

export interface UploadIntakeOptions {
  config: WrapperConfig;
  send: (envelope: Envelope) => void;
  state: () => KaoiroState;
  now?: () => number;
}

/** The pending uploads and the staged records of one wrapper. It exists from
 *  start, before the host, because attach_* can arrive before it. */
export class UploadIntake {
  readonly #pending = new Map<string, PendingUpload>();
  readonly #staged = new Set<Staged>();
  readonly #options: UploadIntakeOptions;
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #owner: RecordOwner = {
    leave: (record) => {
      this.#staged.delete(record);
    },
    rejectInstruction: (payload) => this.#rejectInstruction(payload),
  };
  #closed = false;

  constructor(options: UploadIntakeOptions) {
    this.#options = options;
    this.#timer = setInterval(() => this.sweep(), PENDING_UPLOAD_GC_INTERVAL_MS);
    this.#timer.unref();
  }

  attachOpen(meta: UploadMeta): void {
    if (this.#pending.size >= MAX_INFLIGHT_UPLOADS) {
      this.#rejectUpload(meta.upload_id, "count_over",
        `in-flight=${this.#pending.size} cap=${MAX_INFLIGHT_UPLOADS}`);
      return;
    }
    const result = validateOpen(meta);
    if (!result.ok) {
      this.#rejectUpload(meta.upload_id, result.reason, result.detail);
      return;
    }
    this.#pending.set(meta.upload_id, { meta, chunks: new Map(), sealed: false,
      accumulatedBytes: 0, addedAt: this.#now() });
  }

  attachChunk(payload: ArrayBuffer | ArrayBufferView): void {
    let parsed: ChunkPayload;
    try { parsed = parseChunkPayload(payload); } catch { return; }
    const upload = this.#pending.get(parsed.upload_id);
    if (!upload || upload.sealed || parsed.chunk_index >= upload.meta.chunks) return;
    const total = upload.accumulatedBytes -
      (upload.chunks.get(parsed.chunk_index)?.byteLength ?? 0) + parsed.bytes.byteLength;
    if (total > upload.meta.size || total > PROTOCOL_FILE_SIZE_LIMIT_BYTES) {
      this.#pending.delete(parsed.upload_id);
      this.#rejectUpload(parsed.upload_id, "size_over",
        `accumulated=${total} declared=${upload.meta.size} cap=${PROTOCOL_FILE_SIZE_LIMIT_BYTES}`);
      return;
    }
    upload.chunks.set(parsed.chunk_index, parsed.bytes);
    upload.accumulatedBytes = total;
  }

  attachClose(uploadId: string): void {
    const upload = this.#pending.get(uploadId);
    if (!upload) return;
    const result = validateClose(upload);
    if (!result.ok) {
      this.#pending.delete(uploadId);
      this.#rejectUpload(uploadId, result.reason, result.detail);
      return;
    }
    upload.sealed = true;
  }

  /** Drops pending uploads older than the TTL; staged ones are exempt. */
  sweep(): void {
    const cutoff = this.#now() - PENDING_UPLOAD_TTL_MS;
    for (const [uploadId, upload] of this.#pending) {
      if (upload.addedAt >= cutoff) continue;
      this.#pending.delete(uploadId);
      this.#rejectUpload(uploadId, "timeout",
        `ttl exceeded (added_at=${upload.addedAt} cutoff=${cutoff})`);
    }
  }

  /** Takes the uploads an instruction references, or refuses it with
   *  `instruction_rejected` and consumes nothing. Every id is checked before
   *  any upload moves; a repeated id is attached once. */
  stage(ids: readonly string[]): StagedRecord | undefined {
    const refuse = (reason: FileUploadRejectReason, detail?: string) => {
      this.#rejectInstruction({ attachment_ids: [...ids], reason,
        ...(detail === undefined ? {} : { detail }) });
      return undefined;
    };
    if (this.#closed) return refuse("interrupted", "the wrapper is shutting down");
    if (ids.length > MAX_ATTACHMENTS_PER_INSTRUCTION)
      return refuse("count_over", `attachments=${ids.length} cap=${MAX_ATTACHMENTS_PER_INSTRUCTION}`);
    const unique = [...new Set(ids)];
    const uploads: PendingUpload[] = [];
    for (const id of unique) {
      const upload = this.#pending.get(id);
      if (!upload) return refuse("timeout", `unknown upload_id ${id}`);
      const result = validateClose(upload);
      if (!result.ok) return refuse(result.reason, result.detail);
      uploads.push(upload);
    }
    for (const id of unique) this.#pending.delete(id);
    const record = new Staged([...ids], uploads, this.#owner);
    this.#staged.add(record);
    return record;
  }

  /** ADR-0025 F11: drops every pending upload and every staged record whose
   *  turn has not started. Synchronous, so it runs before any await of the
   *  caller. */
  interrupt(): void {
    for (const uploadId of this.#pending.keys()) this.#rejectUpload(uploadId, "interrupted");
    this.#pending.clear();
    for (const record of [...this.#staged]) {
      this.#staged.delete(record);
      record.dropped = true;
      for (const upload of record.uploads)
        this.#rejectUpload(upload.meta.upload_id, "interrupted");
      this.#rejectInstruction({ attachment_ids: [...record.ids], reason: "interrupted" });
      record.onDrop?.();
    }
  }

  /** Idempotent; both the host and the CLI call it on shutdown. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.interrupt();
  }

  #now() {
    return (this.#options.now ?? Date.now)();
  }
  #rejectUpload(uploadId: string, reason: FileUploadRejectReason, detail?: string) {
    this.#options.send(makeAttachRejected(this.#options.config, this.#options.state(),
      new Date().toISOString(),
      { upload_id: uploadId, reason, ...(detail === undefined ? {} : { detail }) }));
  }
  #rejectInstruction(payload: InstructionRejectedPayload) {
    this.#options.send(makeInstructionRejected(this.#options.config, this.#options.state(),
      new Date().toISOString(), payload));
  }
}

/** Sums the uncompressed sizes an OOXML archive declares, without
 *  inflating anything, so a decompression bomb is refused before the parser
 *  allocates it. A non-ZIP input passes; the parser reports it. */
export function officeWithinUncompressedBudget(bytes: Uint8Array): boolean {
  let total = 0;
  let bombed = false;
  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    // originalSize is the declared uncompressed size; size is compressed.
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

/** null when the document cannot be read (corrupt, encrypted, a bomb). */
export interface OfficeTextExtractor {
  extract(bytes: Uint8Array, mime: string): Promise<string | null>;
}

export class DefaultOfficeTextExtractor implements OfficeTextExtractor {
  async extract(bytes: Uint8Array, _mime: string): Promise<string | null> {
    if (!officeWithinUncompressedBudget(bytes)) return null;
    try {
      const ast = await OfficeParser.parseOffice(Buffer.from(bytes));
      const text = ast.toText();
      if (text.length > OFFICE_MAX_OUTPUT_CHARS) {
        return clipUtf16Head(text, OFFICE_MAX_OUTPUT_CHARS) +
          `\n\n[...truncated at ${OFFICE_MAX_OUTPUT_CHARS} chars]\n`;
      }
      return text;
    } catch {
      return null;
    }
  }
}

/** The filename with path separators and control characters replaced. */
export function attachmentName(filename: string): string {
  const name = filename.replace(/[/\\\u0000-\u001f\u007f-\u009f]/g, "_");
  return name === "" ? "attachment" : name;
}

/** The Claude Code text rule: UTF-8 with replacement characters, the first
 *  1 MB, and a note when anything was cut. */
export function textBody(bytes: Uint8Array): string {
  const slice = bytes.subarray(0, utf8HeadEnd(bytes, TEXT_BYTE_LIMIT));
  const decoded = new TextDecoder("utf-8").decode(slice);
  // A malformed byte decodes to U+FFFD (3 bytes), so the decoded text can
  // exceed the budget although the raw slice fits it.
  const body = clipUtf8Head(decoded, TEXT_BYTE_LIMIT);
  const truncated = slice.byteLength < bytes.byteLength || body.length < decoded.length;
  return truncated ? `${body}\n\n[...truncated, original ${bytes.byteLength} bytes]\n` : body;
}

function textResource(filename: string, mimeType: string, bytes: Uint8Array): acp.ContentBlock {
  return {
    type: "resource",
    resource: { uri: `attachment:///${attachmentName(filename)}`, mimeType, text: textBody(bytes) },
  };
}

/** A PDF waits in memory until its turn starts; then it is written to
 *  `file` and sent as a `resource_link`. */
export interface PdfPart {
  kind: "pdf";
  name: string;
  file: string;
  bytes: Uint8Array;
}
export type PromptPart = acp.ContentBlock | PdfPart;
export type BuildResult =
  | { ok: true; parts: PromptPart[] }
  | { ok: false; reason: FileUploadRejectReason; detail: string };

export function isPdfPart(part: PromptPart): part is PdfPart {
  return "kind" in part && part.kind === "pdf";
}

export function pdfLink(path: string, name: string): acp.ContentBlock {
  return { type: "resource_link", uri: pathToFileURL(path).href, name, mimeType: PDF_MIME };
}

/** One block per upload, in order. */
export async function buildAttachmentParts(
  uploads: readonly PendingUpload[],
  extractor: OfficeTextExtractor,
): Promise<BuildResult> {
  const parts: PromptPart[] = [];
  let pdfs = 0;
  for (const upload of uploads) {
    const { mime, filename } = upload.meta;
    const bytes = assembleBytes(upload);
    if (IMAGE_MIME_ALLOW.has(mime)) {
      parts.push({ type: "image", mimeType: mime, data: Buffer.from(bytes).toString("base64") });
    } else if (isTextMime(mime)) {
      parts.push(textResource(filename, mime, bytes));
    } else if (isOfficeMime(mime)) {
      let text: string | null;
      try { text = await extractor.extract(bytes, mime); } catch { text = null; }
      if (text === null) return { ok: false, reason: "sdk_error", detail: "office text extraction failed" };
      parts.push(textResource(filename, "text/plain", new TextEncoder().encode(text)));
    } else if (mime === PDF_MIME) {
      parts.push({ kind: "pdf", name: filename, file: `${pdfs++}-${randomUUID()}.pdf`, bytes });
    } else {
      return { ok: false, reason: "sdk_error", detail: `unsupported mime ${mime}` };
    }
  }
  return { ok: true, parts };
}

const TEMP_PREFIX = "kaoiro-grok-attach-";

/** The full SHA-256 of the agent id keeps agents' prefixes apart, so one
 *  agent's sweep never reaches another agent's directory. */
export function attachmentDirPrefix(agentId: string): string {
  return `${TEMP_PREFIX}${createHash("sha256").update(agentId).digest("hex")}-`;
}

export function removeAttachmentDir(dir: string, warn: (line: string) => void): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    warn(`[kaoiro] grok attachment cleanup failed: ${String(error)}\n`);
  }
}

/** Removes what an earlier run of this agent left behind. */
export function sweepAttachmentDirs(root: string, agentId: string, warn: (line: string) => void): void {
  const prefix = attachmentDirPrefix(agentId);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    warn(`[kaoiro] grok attachment sweep failed: ${String(error)}\n`);
    return;
  }
  for (const name of names)
    if (name.startsWith(prefix)) removeAttachmentDir(join(root, name), warn);
}
