import { describe, expect, it } from "vitest";
import {
  IMAGE_MIME_ALLOW,
  PHASE_0_SIZE_LIMIT_BYTES,
  assembleBytes,
  parseChunkPayload,
  renderImageBlock,
  validateClose,
  validateOpen,
} from "../src/upload.js";
import type { PendingUpload, UploadMeta } from "../src/upload.js";
import { buildChunkPayload } from "./helpers.js";

function meta(overrides: Partial<UploadMeta> = {}): UploadMeta {
  return {
    upload_id: "u1",
    filename: "a.png",
    mime: "image/png",
    size: 4,
    chunks: 1,
    ...overrides,
  };
}

describe("parseChunkPayload", () => {
  it("正しいレイアウトを upload_id / chunk_index / bytes へ復元する", () => {
    const buf = buildChunkPayload("u-7a3f", 2, new Uint8Array([1, 2, 3, 4]));
    const parsed = parseChunkPayload(buf);
    expect(parsed.upload_id).toBe("u-7a3f");
    expect(parsed.chunk_index).toBe(2);
    expect(parsed.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("ArrayBufferView も受け取れる(Node ws の Buffer 互換)", () => {
    const ab = buildChunkPayload("u1", 0, new Uint8Array([9]));
    const view = new Uint8Array(ab);
    const parsed = parseChunkPayload(view);
    expect(parsed.upload_id).toBe("u1");
    expect(parsed.chunk_index).toBe(0);
    expect(parsed.bytes).toEqual(new Uint8Array([9]));
  });

  it("ヘッダ短すぎは throw", () => {
    expect(() => parseChunkPayload(new Uint8Array([0, 0, 0]))).toThrow(
      /too short/,
    );
  });

  it("upload_id_len が残バイト長を超える(truncated)は throw", () => {
    // declares 100-byte id but only 4 bytes total -> truncated
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setUint32(0, 100, false);
    expect(() => parseChunkPayload(buf)).toThrow(/truncated/);
  });

  it("UTF-8 マルチバイト upload_id を復元できる", () => {
    const buf = buildChunkPayload("う1", 0, new Uint8Array([0]));
    expect(parseChunkPayload(buf).upload_id).toBe("う1");
  });
});

describe("validateOpen — phase-0 (image only, 5 MB)", () => {
  it("許可 MIME + 上限内のサイズで ok", () => {
    expect(validateOpen(meta())).toEqual({ ok: true });
  });

  it("非画像 MIME は mime_denied", () => {
    expect(validateOpen(meta({ mime: "application/zip" }))).toMatchObject({
      ok: false,
      reason: "mime_denied",
    });
  });

  it("上限超サイズは size_over", () => {
    expect(
      validateOpen(meta({ size: PHASE_0_SIZE_LIMIT_BYTES + 1 })),
    ).toMatchObject({ ok: false, reason: "size_over" });
  });

  it("IMAGE_MIME_ALLOW は spec の 4 種", () => {
    expect([...IMAGE_MIME_ALLOW].sort()).toEqual([
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });
});

describe("validateClose / assembleBytes", () => {
  const upload = (overrides: Partial<UploadMeta> = {}): PendingUpload => ({
    meta: meta(overrides),
    chunks: new Map(),
    sealed: false,
    accumulatedBytes: 0,
  });

  it("全 chunk 揃って assembled = declared なら ok", () => {
    const u = upload({ chunks: 2, size: 5 });
    u.chunks.set(0, new Uint8Array([1, 2, 3]));
    u.chunks.set(1, new Uint8Array([4, 5]));
    expect(validateClose(u)).toEqual({ ok: true });
    expect(assembleBytes(u)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("欠損 chunk は timeout 理由", () => {
    const u = upload({ chunks: 2, size: 5 });
    u.chunks.set(0, new Uint8Array([1, 2, 3]));
    expect(validateClose(u)).toMatchObject({
      ok: false,
      reason: "timeout",
    });
  });

  it("実バイト数が宣言と不一致は size_over", () => {
    const u = upload({ chunks: 1, size: 10 });
    u.chunks.set(0, new Uint8Array([1, 2, 3]));
    expect(validateClose(u)).toMatchObject({
      ok: false,
      reason: "size_over",
    });
  });

  it("assembleBytes は欠損があれば throw(validateClose 後の前提を守る)", () => {
    const u = upload({ chunks: 2 });
    u.chunks.set(0, new Uint8Array([1]));
    expect(() => assembleBytes(u)).toThrow(/missing chunk/);
  });
});

describe("renderImageBlock", () => {
  it("base64 image content block を構築する(media_type は upload の MIME)", () => {
    const block = renderImageBlock(
      meta({ mime: "image/jpeg" }),
      new Uint8Array([0xff, 0xd8, 0xff]),
    );
    expect(block.type).toBe("image");
    expect(block.source.type).toBe("base64");
    expect(block.source.media_type).toBe("image/jpeg");
    expect(block.source.data).toBe(Buffer.from([0xff, 0xd8, 0xff]).toString("base64"));
  });
});
