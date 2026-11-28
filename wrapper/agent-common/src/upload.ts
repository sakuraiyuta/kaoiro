import type {
  Envelope,
  FileUploadRejectReason,
  InstructionRejectedPayload,
  KaoiroState,
  WrapperConfig,
} from "@kaoiro/protocol";
import { clipUtf8Head, utf8HeadEnd } from "@kaoiro/wrapper-core";
import { makeAttachRejected, makeInstructionRejected } from "./state.js";

export const PROTOCOL_FILE_SIZE_LIMIT_BYTES = 128 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_INSTRUCTION = 10;
export const MAX_INFLIGHT_UPLOADS = 20;
export const PENDING_UPLOAD_TTL_MS = 5 * 60 * 1000;
export const PENDING_UPLOAD_GC_INTERVAL_MS = 60 * 1000;

export const TEXT_MIME_ALLOW: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
  "application/sql",
]);

export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || TEXT_MIME_ALLOW.has(mime);
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

export function validateOpen(
  meta: UploadMeta,
  acceptsMime: (mime: string) => boolean,
): ValidationResult {
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
  if (!acceptsMime(meta.mime)) {
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
  acceptsMime: (mime: string) => boolean;
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
    const result = validateOpen(meta, this.#options.acceptsMime);
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

  /** Takes the sealed uploads an instruction references, or refuses it with
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
      // attach_close validated it, and a sealed upload takes no more chunks.
      if (!upload.sealed) return refuse("timeout", `upload_id ${id} is not closed`);
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

/** The filename with path separators and control characters replaced. */
export function attachmentName(filename: string): string {
  const name = filename.replace(/[/\\\u0000-\u001f\u007f-\u009f]/g, "_");
  return name === "" ? "attachment" : name;
}

export function fitTextBody(bytes: Uint8Array, limit: number) {
  const slice = bytes.subarray(0, utf8HeadEnd(bytes, limit));
  const decoded = new TextDecoder("utf-8").decode(slice);
  // A malformed byte decodes to U+FFFD (3 bytes), so the decoded text can
  // exceed the budget although the raw slice fits it.
  const body = clipUtf8Head(decoded, limit);
  const truncated = slice.byteLength < bytes.byteLength || body.length < decoded.length;
  return { body, truncated };
}
