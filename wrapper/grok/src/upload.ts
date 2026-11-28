// Grok's attachment policy and ACP blocks (ADR-0025).
// Measurements: docs/evidence/grok/2026-11-15-attachment-delivery-routes.md.

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { Unzip, UnzipInflate } from "fflate";
import { OfficeParser } from "officeparser";
import type { FileUploadRejectReason } from "@kaoiro/agent-common";
import {
  assembleBytes,
  attachmentName,
  fitTextBody,
  isTextMime,
  UploadIntake as SharedUploadIntake,
  validateOpen as validateSharedOpen,
  type PendingUpload,
  type UploadIntakeOptions as SharedIntakeOptions,
  type UploadMeta,
} from "@kaoiro/agent-common/dist/upload.js";
import { clipUtf16Head } from "@kaoiro/wrapper-core";

export {
  assembleBytes,
  attachmentName,
  isTextMime,
  MAX_ATTACHMENTS_PER_INSTRUCTION,
  MAX_INFLIGHT_UPLOADS,
  parseChunkPayload,
  PENDING_UPLOAD_GC_INTERVAL_MS,
  PENDING_UPLOAD_TTL_MS,
  PROTOCOL_FILE_SIZE_LIMIT_BYTES,
  TEXT_MIME_ALLOW,
  validateClose,
  type ChunkPayload,
  type PendingUpload,
  type StagedRecord,
  type UploadMeta,
  type ValidationResult,
} from "@kaoiro/agent-common/dist/upload.js";

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
export const OFFICE_MIME_ALLOW: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
export const PDF_MIME = "application/pdf";

export function isOfficeMime(mime: string): boolean {
  return OFFICE_MIME_ALLOW.has(mime);
}

function acceptsMime(mime: string): boolean {
  return IMAGE_MIME_ALLOW.has(mime) || isTextMime(mime)
    || mime === PDF_MIME || isOfficeMime(mime);
}

export function validateOpen(meta: UploadMeta) {
  return validateSharedOpen(meta, acceptsMime);
}

export type UploadIntakeOptions = Omit<SharedIntakeOptions, "acceptsMime">;

export class UploadIntake extends SharedUploadIntake {
  constructor(options: UploadIntakeOptions) {
    super({ ...options, acceptsMime });
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

export function textBody(bytes: Uint8Array): string {
  const { body, truncated } = fitTextBody(bytes, TEXT_BYTE_LIMIT);
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
