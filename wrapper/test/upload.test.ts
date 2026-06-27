import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { zipSync } from "fflate";
import {
  IMAGE_MIME_ALLOW,
  IMAGE_SDK_LONG_EDGE_MAX,
  IMAGE_SDK_RAW_LIMIT_BYTES,
  OFFICE_MAX_UNCOMPRESSED_BYTES,
  OFFICE_MIME_ALLOW,
  PDF_MIME,
  PDF_SDK_PAGE_LIMIT,
  PROTOCOL_FILE_SIZE_LIMIT_BYTES,
  SharpImageDownsizer,
  TEXT_MIME_ALLOW,
  TEXT_SDK_BYTE_LIMIT,
  assembleBytes,
  blockWireSize,
  DefaultOfficeTextExtractor,
  fitImageToSdk,
  fitPdfToSdk,
  isOfficeMime,
  isTextMime,
  officeWithinUncompressedBudget,
  parseChunkPayload,
  renderAttachmentBlock,
  renderDocumentBlock,
  renderImageBlock,
  renderTextBlock,
  setDefaultImageDownsizer,
  setDefaultOfficeTextExtractor,
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

describe("validateOpen (image + text/code MIMEs)", () => {
  it("許可画像 MIME + 上限内のサイズで ok", () => {
    expect(validateOpen(meta())).toEqual({ ok: true });
  });

  it("text/plain は ok (text/* prefix 経路)", () => {
    expect(
      validateOpen(meta({ mime: "text/plain", filename: "a.txt" })),
    ).toEqual({ ok: true });
  });

  it("application/json は ok (TEXT_MIME_ALLOW 経路)", () => {
    expect(
      validateOpen(meta({ mime: "application/json", filename: "a.json" })),
    ).toEqual({ ok: true });
  });

  it("application/pdf は ok (PDF 経路)", () => {
    expect(
      validateOpen(meta({ mime: PDF_MIME, filename: "a.pdf" })),
    ).toEqual({ ok: true });
  });

  it("OOXML docx/xlsx/pptx は ok (Office 経路)", () => {
    for (const mime of OFFICE_MIME_ALLOW) {
      expect(validateOpen(meta({ mime, filename: "a" }))).toEqual({ ok: true });
    }
  });

  it("非対応 MIME (application/zip) は mime_denied", () => {
    expect(validateOpen(meta({ mime: "application/zip" }))).toMatchObject({
      ok: false,
      reason: "mime_denied",
    });
  });

  it("上限超サイズは size_over (text でも image でも同じ)", () => {
    expect(
      validateOpen(meta({ size: PROTOCOL_FILE_SIZE_LIMIT_BYTES + 1 })),
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

describe("officeWithinUncompressedBudget (decompression-bomb defense)", () => {
  it("空 / 非 ZIP は通す(officeparser に format 検証を委ねる)", () => {
    expect(officeWithinUncompressedBudget(new Uint8Array([]))).toBe(true);
    expect(
      officeWithinUncompressedBudget(new Uint8Array([0x00, 0x01, 0x02])),
    ).toBe(true);
  });

  it("小さい legit ZIP は通す", () => {
    const data = new TextEncoder().encode("hello world");
    const zipped = zipSync({ "a.txt": data });
    expect(officeWithinUncompressedBudget(zipped)).toBe(true);
  });

  it("展開サイズ合計が cap 超なら false(zip-bomb 検出)", () => {
    // OFFICE_MAX_UNCOMPRESSED_BYTES + 1 MB の compressible data (zeros)。
    // 圧縮率が極端に高いので圧縮後は ~100 KB だが、 declared
    // uncompressed が cap 超になる。
    const bombSize = OFFICE_MAX_UNCOMPRESSED_BYTES + 1024 * 1024;
    const bombData = new Uint8Array(bombSize); // all zeros
    const zipped = zipSync({ "x": bombData });
    expect(officeWithinUncompressedBudget(zipped)).toBe(false);
  });
});

describe("isOfficeMime", () => {
  it("OFFICE_MIME_ALLOW (docx/xlsx/pptx) を受理", () => {
    for (const m of OFFICE_MIME_ALLOW) {
      expect(isOfficeMime(m)).toBe(true);
    }
  });

  it("レガシー Office (.doc/.xls/.ppt) や image は false", () => {
    expect(isOfficeMime("application/msword")).toBe(false);
    expect(isOfficeMime("application/vnd.ms-excel")).toBe(false);
    expect(isOfficeMime("application/vnd.ms-powerpoint")).toBe(false);
    expect(isOfficeMime("image/png")).toBe(false);
    expect(isOfficeMime("text/plain")).toBe(false);
    expect(isOfficeMime("")).toBe(false);
  });
});

describe("isTextMime", () => {
  it("text/* prefix を受理", () => {
    expect(isTextMime("text/plain")).toBe(true);
    expect(isTextMime("text/markdown")).toBe(true);
    expect(isTextMime("text/x-python")).toBe(true);
    expect(isTextMime("text/csv")).toBe(true);
  });

  it("TEXT_MIME_ALLOW を受理", () => {
    for (const m of TEXT_MIME_ALLOW) {
      expect(isTextMime(m)).toBe(true);
    }
  });

  it("image / 未知 MIME は false", () => {
    expect(isTextMime("image/png")).toBe(false);
    expect(isTextMime("application/zip")).toBe(false);
    expect(isTextMime("application/pdf")).toBe(false);
    expect(isTextMime("")).toBe(false);
  });
});

describe("renderTextBlock / renderAttachmentBlock", () => {
  // Pass-through image downsizer + restored Office extractor so dispatch
  // tests can ride synthetic bytes (the real implementations would reject
  // synthetic image / docx data); the real SharpImageDownsizer and
  // DefaultOfficeTextExtractor keep their own coverage elsewhere.
  beforeEach(() => {
    setDefaultImageDownsizer({
      fit: async (bytes, mime) => ({ bytes, mime }),
    });
  });
  afterEach(() => {
    setDefaultImageDownsizer(new SharpImageDownsizer());
    setDefaultOfficeTextExtractor(new DefaultOfficeTextExtractor());
  });

  function meta_(overrides: Partial<UploadMeta> = {}): UploadMeta {
    return {
      upload_id: "u1",
      filename: "x.txt",
      mime: "text/plain",
      size: 0,
      chunks: 0,
      ...overrides,
    };
  }

  it("renderTextBlock は UTF-8 decode + filename prefix の text block", () => {
    const bytes = new TextEncoder().encode("hello\nworld");
    const block = renderTextBlock(meta_({ filename: "hello.txt" }), bytes);
    expect(block).toEqual({
      type: "text",
      text: "[file: hello.txt]\nhello\nworld",
    });
  });

  it("renderTextBlock は TEXT_SDK_BYTE_LIMIT 超を末尾切り + 注記", () => {
    const big = "A".repeat(TEXT_SDK_BYTE_LIMIT + 100);
    const bytes = new TextEncoder().encode(big);
    const block = renderTextBlock(meta_({ filename: "big.txt" }), bytes);
    expect(block.text.startsWith("[file: big.txt]\n")).toBe(true);
    expect(block.text).toContain(
      `[...truncated, original ${bytes.byteLength} bytes]`,
    );
    expect(block.text.length).toBeLessThan(bytes.byteLength + 100);
  });

  it("blockWireSize は image/document の base64 長と text の UTF-8 バイト長", () => {
    expect(
      blockWireSize({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abcdef" },
      }),
    ).toBe(6);
    expect(
      blockWireSize({
        type: "document",
        source: { type: "base64", media_type: PDF_MIME, data: "abcdefghij" },
      }),
    ).toBe(10);
    expect(blockWireSize({ type: "text", text: "12345" })).toBe(5);
    // 非 ASCII: 「あ」は UTF-8 で 3 bytes、 UTF-16 code units は 1。
    // .length で測ると 1 になるが、 wire size は 3 でないと 32 MB cap が
    // CJK 入力で undercount される。
    expect(blockWireSize({ type: "text", text: "あ" })).toBe(3);
    expect(blockWireSize({ type: "text", text: "あいう" })).toBe(9);
  });

  it("renderTextBlock は非 UTF-8 で U+FFFD 置換(throw しない)", () => {
    // 0xFF は単独で出てきたら不正な UTF-8 先頭バイト
    const bytes = new Uint8Array([0xff, 0x68, 0x69]);
    const block = renderTextBlock(meta_({ filename: "weird.txt" }), bytes);
    expect(block.type).toBe("text");
    expect(block.text).toContain("�");
    expect(block.text).toContain("hi");
  });

  it("renderAttachmentBlock は image MIME を image block へ", async () => {
    const r = await renderAttachmentBlock(
      meta_({ mime: "image/png", filename: "a.png" }),
      new Uint8Array([1, 2, 3]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.block.type).toBe("image");
  });

  it("renderAttachmentBlock は text MIME を text block へ", async () => {
    const r = await renderAttachmentBlock(
      meta_({ mime: "text/markdown", filename: "a.md" }),
      new TextEncoder().encode("# hi"),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.type).toBe("text");
      expect((r.block as { text: string }).text).toContain("[file: a.md]");
    }
  });

  it("renderAttachmentBlock は未知 MIME を sdk_error で返す(validateOpen 漏れ)", async () => {
    const r = await renderAttachmentBlock(
      meta_({ mime: "application/octet-stream", filename: "a.bin" }),
      new Uint8Array([]),
    );
    expect(r).toEqual({ ok: false, reason: "sdk_error" });
  });

  it("renderAttachmentBlock は Office MIME を text block へ(extractor 経由、 filename prefix)", async () => {
    setDefaultOfficeTextExtractor({
      extract: async () => "abstract\nbody...",
    });
    const docxMime =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const r = await renderAttachmentBlock(
      meta_({ mime: docxMime, filename: "report.docx" }),
      new Uint8Array([1, 2, 3]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.type).toBe("text");
      expect((r.block as { text: string }).text).toBe(
        "[file: report.docx]\nabstract\nbody...",
      );
    }
  });

  it("renderAttachmentBlock は Office extractor が null なら sdk_error", async () => {
    setDefaultOfficeTextExtractor({ extract: async () => null });
    const r = await renderAttachmentBlock(
      meta_({
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "broken.docx",
      }),
      new Uint8Array([0, 0, 0]),
    );
    expect(r).toEqual({ ok: false, reason: "sdk_error" });
  });
});

describe("PDF fit-to-SDK + render", () => {
  async function makePdf(pages: number): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) {
      const page = doc.addPage([612, 792]);
      page.drawText(`page ${i + 1}`);
    }
    return await doc.save();
  }

  it("ページ数 / バイトとも上限内なら pass-through(同一参照)", async () => {
    const bytes = await makePdf(3);
    const fitted = await fitPdfToSdk(bytes);
    expect(fitted).toBe(bytes);
  });

  it("ページ数上限超は先頭 PDF_SDK_PAGE_LIMIT ページのみ", async () => {
    const total = PDF_SDK_PAGE_LIMIT + 5;
    const bytes = await makePdf(total);
    const fitted = await fitPdfToSdk(bytes);
    expect(fitted).not.toBeNull();
    // assertion: 抽出後のページ数 <= PAGE_LIMIT
    const reloaded = await PDFDocument.load(fitted as Uint8Array);
    expect(reloaded.getPageCount()).toBe(PDF_SDK_PAGE_LIMIT);
  });

  it("renderDocumentBlock は base64 document content block を構築", () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const block = renderDocumentBlock(PDF_MIME, bytes);
    expect(block.type).toBe("document");
    expect(block.source.media_type).toBe(PDF_MIME);
    expect(block.source.data).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("renderAttachmentBlock は PDF を fit → document block へ", async () => {
    const bytes = await makePdf(2);
    const r = await renderAttachmentBlock(
      {
        upload_id: "u1",
        filename: "a.pdf",
        mime: PDF_MIME,
        size: bytes.byteLength,
        chunks: 1,
      },
      bytes,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.type).toBe("document");
      expect((r.block as { source: { media_type: string } }).source.media_type)
        .toBe(PDF_MIME);
    }
  });

  it("renderAttachmentBlock は壊れた PDF を sdk_error へ(pdf-lib throw)", async () => {
    const r = await renderAttachmentBlock(
      {
        upload_id: "u1",
        filename: "broken.pdf",
        mime: PDF_MIME,
        size: 5,
        chunks: 1,
      },
      new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]), // not a PDF
    );
    expect(r).toEqual({ ok: false, reason: "sdk_error" });
  });
});

describe("SharpImageDownsizer (image fit-to-SDK)", () => {
  // Lazy import so the test does not pay sharp's metadata cost up-front;
  // sharp is fast but the test file collects many entries.
  async function makeImage(opts: {
    width: number;
    height: number;
    mime: "image/png" | "image/jpeg";
    alpha?: boolean;
  }): Promise<Uint8Array> {
    const { default: sharp } = await import("sharp");
    const channels = opts.alpha ? 4 : 3;
    const raw = Buffer.alloc(opts.width * opts.height * channels);
    // Tint to a fixed colour so deterministic compression ratios fall out.
    for (let i = 0; i < raw.byteLength; i += channels) {
      raw[i] = 200;
      raw[i + 1] = 100;
      raw[i + 2] = 50;
      if (opts.alpha) raw[i + 3] = 255;
    }
    const pipe = sharp(raw, {
      raw: { width: opts.width, height: opts.height, channels },
    });
    const buf =
      opts.mime === "image/png" ? await pipe.png().toBuffer() : await pipe.jpeg().toBuffer();
    return new Uint8Array(buf);
  }

  const downsizer = new SharpImageDownsizer();

  it("両 cap 内なら pass-through で同一参照を返す", async () => {
    const bytes = await makeImage({ width: 200, height: 200, mime: "image/jpeg" });
    const r = await downsizer.fit(bytes, "image/jpeg");
    expect(r).not.toBeNull();
    expect(r!.bytes).toBe(bytes);
    expect(r!.mime).toBe("image/jpeg");
  });

  it("超大画像は IMAGE_SDK_LONG_EDGE_MAX 以内に縮小", async () => {
    // 9000 px wide でしょっぱい JPEG → 縮小後は 8000 以下
    const bytes = await makeImage({
      width: 9000,
      height: 1000,
      mime: "image/jpeg",
    });
    const r = await downsizer.fit(bytes, "image/jpeg");
    expect(r).not.toBeNull();
    const { default: sharp } = await import("sharp");
    const meta = await sharp(r!.bytes).metadata();
    expect((meta.width ?? 0)).toBeLessThanOrEqual(IMAGE_SDK_LONG_EDGE_MAX);
    expect(r!.bytes.byteLength).toBeLessThanOrEqual(IMAGE_SDK_RAW_LIMIT_BYTES);
  });

  it("alpha-PNG は PNG のまま縮小(JPEG 化しない)", async () => {
    const bytes = await makeImage({
      width: 9000,
      height: 1000,
      mime: "image/png",
      alpha: true,
    });
    const r = await downsizer.fit(bytes, "image/png");
    expect(r).not.toBeNull();
    expect(r!.mime).toBe("image/png");
  });

  it("壊れたバイトは null(unfittable_image)", async () => {
    const r = await downsizer.fit(
      new Uint8Array([1, 2, 3, 4, 5]),
      "image/png",
    );
    expect(r).toBeNull();
  });

  it("fitImageToSdk は default downsizer 経由で同じ結果", async () => {
    const bytes = await makeImage({ width: 200, height: 200, mime: "image/jpeg" });
    const r = await fitImageToSdk(bytes, "image/jpeg");
    expect(r).not.toBeNull();
    expect(r!.bytes).toBe(bytes);
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
  it("base64 image content block を構築する(media_type は引数の MIME)", () => {
    const block = renderImageBlock(
      "image/jpeg",
      new Uint8Array([0xff, 0xd8, 0xff]),
    );
    expect(block.type).toBe("image");
    expect(block.source.type).toBe("base64");
    expect(block.source.media_type).toBe("image/jpeg");
    expect(block.source.data).toBe(Buffer.from([0xff, 0xd8, 0xff]).toString("base64"));
  });
});
