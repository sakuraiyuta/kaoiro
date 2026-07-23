// Codex local-image upload assembly. The wire stays memory-only until an
// instruction is accepted; the short-lived file is the ADR-0025 F3 exception
// required because Codex SDK 0.144.1 accepts image paths, not image bytes.

import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { FileUploadRejectReason } from "@kaoiro/agent-common";

export const PROTOCOL_FILE_SIZE_LIMIT_BYTES = 128 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_INSTRUCTION = 10;
export const MAX_INFLIGHT_UPLOADS = 20;
export const PENDING_UPLOAD_TTL_MS = 5 * 60 * 1000;
export const PENDING_UPLOAD_GC_INTERVAL_MS = 60 * 1000;

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

/** Hooks bind an in-flight materialization to the host lifecycle before the
 * first await after mkdtemp. This prevents interrupt/close/sweep races. */
export interface MaterializeLifecycle {
  cancelled: () => boolean;
  onDirectoryCreated: (dir: string) => void;
  onDirectoryDisposed: (dir: string) => void;
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

/** Codex supports the protocol's image capability only. Format validation is
 * deliberately delegated to the SDK: it owns the concrete local_image set. */
export function validateOpen(meta: UploadMeta): ValidationResult {
  if (
    !Number.isFinite(meta.size) ||
    !Number.isInteger(meta.size) ||
    meta.size < 0 ||
    !Number.isFinite(meta.chunks) ||
    !Number.isInteger(meta.chunks) ||
    meta.chunks <= 0
  ) {
    return {
      ok: false,
      reason: "size_over",
      detail: `invalid metadata size=${meta.size} chunks=${meta.chunks}`,
    };
  }
  if (!meta.mime.startsWith("image/")) {
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

const TEMP_PREFIX = "kaoiro-codex-local-image-";

export function tempDirPrefix(agentId: string): string {
  // Full-ID SHA-256 namespace: no sanitized-prefix or truncation collision
  // can make one agent sweep another agent's active temp directory.
  const namespace = createHash("sha256").update(agentId).digest("hex");
  return `${TEMP_PREFIX}${namespace}-`;
}

function safeExtension(filename: string): string {
  const extension = extname(basename(filename)).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".img";
}

export async function materializeLocalImages(
  agentId: string,
  uploads: PendingUpload[],
  lifecycle?: MaterializeLifecycle,
): Promise<{ dir: string; paths: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), tempDirPrefix(agentId)));
  lifecycle?.onDirectoryCreated(dir);
  const dispose = async (): Promise<void> => {
    await cleanupLocalImages(dir, () => {});
    lifecycle?.onDirectoryDisposed(dir);
  };
  try {
    if (lifecycle?.cancelled()) throw new Error("local_image materialization cancelled");
    await chmod(dir, 0o700);
    const paths: string[] = [];
    for (const [index, upload] of uploads.entries()) {
      if (lifecycle?.cancelled()) throw new Error("local_image materialization cancelled");
      const path = join(dir, `${index}-${crypto.randomUUID()}${safeExtension(upload.meta.filename)}`);
      await writeFile(path, assembleBytes(upload), { mode: 0o600 });
      await chmod(path, 0o600);
      paths.push(path);
    }
    if (lifecycle?.cancelled()) throw new Error("local_image materialization cancelled");
    return { dir, paths };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function cleanupLocalImages(
  dir: string,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    warn(`codex local_image cleanup failed for ${dir}: ${String(error)}`);
  }
}

/** Startup best-effort sweep, deliberately scoped to this agent's prefix. */
export async function sweepOrphanLocalImages(
  agentId: string,
  warn: (message: string) => void,
  preserve: () => ReadonlySet<string> = () => new Set(),
): Promise<void> {
  const prefix = tempDirPrefix(agentId);
  try {
    const names = await readdir(tmpdir());
    await Promise.all(
      names.filter((name) => name.startsWith(prefix)).map(async (name) => {
        const dir = join(tmpdir(), name);
        if (preserve().has(dir)) return;
        await cleanupLocalImages(dir, warn);
      }),
    );
  } catch (error) {
    warn(`codex local_image orphan sweep failed: ${String(error)}`);
  }
}
