import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { FileUploadRejectReason } from "@kaoiro/agent-common";
import {
  assembleBytes,
  attachmentName,
  fitTextBody,
  type PendingUpload,
} from "@kaoiro/agent-common/dist/upload.js";

export const PNG_BYTE_LIMIT = 3_583_490;
export const TEXT_BYTE_LIMIT = 262_144;
export const PROMPT_BYTE_LIMIT = 5_045_354;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function hasPngHeader(bytes: Buffer): boolean {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR"
  ) return false;
  const width = bytes.readInt32BE(16);
  const height = bytes.readInt32BE(20);
  return width > 0 && height > 0;
}

type Prompt = {
  ok: true;
  blocks: ContentBlock[];
  shortened: string[];
} | {
  ok: false;
  reason: FileUploadRejectReason;
  detail: string;
};

export function attachmentPrompt(
  text: string,
  uploads: readonly PendingUpload[],
): Prompt {
  const blocks: ContentBlock[] = [{ type: "text", text }];
  const shortened: string[] = [];
  for (const upload of uploads) {
    const { mime, size, filename } = upload.meta;
    const position = blocks.length;
    if (mime === "image/png") {
      if (size > PNG_BYTE_LIMIT) {
        return { ok: false, reason: "unfittable_image",
          detail: "Attachment " + position + ": PNG exceeds " +
            PNG_BYTE_LIMIT + " bytes" };
      }
      const bytes = assembleBytes(upload);
      const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (!hasPngHeader(png)) {
        return { ok: false, reason: "unfittable_image",
          detail: "Attachment " + position + ": invalid PNG header" };
      }
      blocks.push({
        type: "image", mimeType: mime, data: png.toString("base64"),
      });
      continue;
    }
    const bytes = assembleBytes(upload);
    const fitted = fitTextBody(bytes, TEXT_BYTE_LIMIT);
    let body = fitted.body;
    if (fitted.truncated) {
      const note = "\n\n[...truncated, original " + size + " bytes]\n";
      body = fitTextBody(bytes, TEXT_BYTE_LIMIT - Buffer.byteLength(note)).body;
      if (body.length === 0) {
        return { ok: false, reason: "text_too_large",
          detail: "Attachment " + position + ": no text fits within the limit" };
      }
      shortened.push(position + " (" + Buffer.byteLength(body) +
        " UTF-8 bytes sent, " + size + " original bytes)");
      body += note;
    }
    const safeName = Buffer.from(attachmentName(filename)).toString("utf8");
    const name = encodeURIComponent(safeName);
    blocks.push({
      type: "resource",
      resource: { uri: "attachment:///" + name, mimeType: "text/plain", text: body },
    });
  }
  const size = Buffer.byteLength(JSON.stringify(blocks));
  if (size > PROMPT_BYTE_LIMIT) {
    return { ok: false, reason: "total_request_over",
      detail: "ACP prompt is " + size + " bytes (limit " + PROMPT_BYTE_LIMIT + ")" };
  }
  return { ok: true, blocks, shortened };
}
