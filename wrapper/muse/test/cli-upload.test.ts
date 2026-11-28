import "../../../scripts/test/fixtures/test-isolation.mjs";
import { createHash } from "node:crypto";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope } from "@kaoiro/agent-common";
import { UploadIntake } from "@kaoiro/agent-common/dist/upload.js";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import { runMuseCli } from "../src/cli.js";
import { MuseHost } from "../src/host.js";
import {
  PNG_BYTE_LIMIT, PROMPT_BYTE_LIMIT, TEXT_BYTE_LIMIT,
} from "../src/upload.js";

const executable = fileURLToPath(new URL("./fixtures/muse.mjs", import.meta.url));
const disposable: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of disposable.splice(0)) await close();
  vi.restoreAllMocks();
});

function chunkFrame(id: string, index: number, payload: Uint8Array) {
  const idBytes = Buffer.from(id);
  const frame = Buffer.alloc(8 + idBytes.length + payload.length);
  frame.writeUInt32BE(idBytes.length);
  idBytes.copy(frame, 4);
  frame.writeUInt32BE(index, 4 + idBytes.length);
  frame.set(payload, 8 + idBytes.length);
  return frame;
}

function png(length = 33) {
  const image = Buffer.alloc(length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.writeUInt32BE(13, 8);
  image.write("IHDR", 12);
  image.writeUInt32BE(3840, 16);
  image.writeUInt32BE(2160, 20);
  image[24] = 8;
  image[25] = 2;
  return image;
}

function started({
  caps = { image: true, embeddedContext: true },
  delayed = false,
  hangNew = false,
  watchdog = false,
}: {
  caps?: { image?: boolean; embeddedContext?: boolean };
  delayed?: boolean;
  hangNew?: boolean;
  watchdog?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "muse-upload-test-"));
  const capture = join(root, "blocks.jsonl");
  const cancel = join(root, "cancel");
  const cancelRelease = join(root, "cancel-release");
  const envelopes: Envelope[] = [];
  const methods: string[] = [];
  let callbacks!: ServerLinkOptions;
  let host: MuseHost | undefined;
  const work = runMuseCli({
    cwd: root,
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => ({
      agent_id: "muse-uploads", server_url: "ws://127.0.0.1:1/agent",
      persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
    }),
    loadWrapperBuildInfo: () => ({
      revision: "unknown", dirty: false, built_at: "unknown",
      version: "unknown", channel: "dev",
    }),
    createServerLink: (_url, _id, options) => {
      callbacks = options;
      if (!delayed) queueMicrotask(() => options.onPersonaPrompt?.("persona"));
      return {
        send: (event: Envelope) => envelopes.push(event),
        setSessionId() {}, close() {}, reportDisconnectIntent: async () => {},
        deliveryIncarnation: () => null, deliveryGeneration: () => null,
      } as unknown as ServerLink;
    },
    createHost: options => new MuseHost({
      ...options, executable,
      ...(watchdog ? { watchdogTimeoutMs: 150 } : {}),
      env: {
        ...process.env,
        ...(hangNew ? { KAOIRO_TEST_MUSE_HANG_NEW: "1" } : {}),
        KAOIRO_TEST_MUSE_PROMPT_CAPS: JSON.stringify(caps),
        KAOIRO_TEST_MUSE_BLOCKS_FILE: capture,
        ...(watchdog ? {
          KAOIRO_TEST_CANCEL_FILE: cancel,
          KAOIRO_TEST_HOLD_CANCEL_FILE: cancelRelease,
        } : {}),
      },
    }),
    onHostCreated: value => { host = value; },
    onMetadata: ({ direction, method }) => {
      if (direction === "out" && method) methods.push(method);
    },
  });
  void work.catch(() => {});
  disposable.push(async () => {
    callbacks.onPersonaPrompt?.("persona");
    if (!host) await vi.waitFor(() => expect(host).toBeDefined());
    host?.close();
    try { await work; }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  function upload(id: string, mime: string, data: Uint8Array | number) {
    const size = typeof data === "number" ? data : data.byteLength;
    const chunkSize = 64 * 1024;
    const chunks = Math.max(1, Math.ceil(size / chunkSize));
    callbacks.onAttachOpen?.({ upload_id: id, filename: id, mime, size, chunks });
    const filler = Buffer.alloc(chunkSize, "x");
    for (let index = 0; index < chunks; index += 1) {
      const start = index * chunkSize;
      const bytes = typeof data === "number"
        ? filler.subarray(0, Math.min(size - start, chunkSize))
        : data.subarray(start, start + chunkSize);
      callbacks.onAttachChunk?.(chunkFrame(id, index, bytes));
    }
    callbacks.onAttachClose?.(id);
  }

  return {
    callbacks, upload, envelopes, methods, work,
    close: () => host?.close(),
    ready: () => vi.waitFor(() => expect(host?.state).toBe("waiting_input"),
      { timeout: 5000 }),
    prompts: () => existsSync(capture)
      ? readFileSync(capture, "utf8").trim().split("\n")
        .map(line => JSON.parse(line))
      : [],
    cancelSeen: () => existsSync(cancel),
    releaseCancel: () => writeFileSync(cancelRelease, ""),
    rejections: () => envelopes.filter(e =>
      e.type === "attach_rejected" || e.type === "instruction_rejected"),
    results: (count: number) => vi.waitFor(() =>
      expect(envelopes.filter(e => e.type === "result")).toHaveLength(count),
    { timeout: 5000 }),
  };
}

describe("Muse CLI attachments", () => {
  it("advertises capabilities and writes the fitted blocks in upload order", async () => {
    const t = started();
    await t.ready();
    const ready = t.envelopes.find(e =>
      e.type === "state_change" && e.state === "waiting_input");
    expect(ready?.ext?.session_capabilities).toMatchObject({
      supports_attachments: true, attachment_types: ["image", "text"],
    });
    const image = png(PNG_BYTE_LIMIT);
    t.upload("screen.png", "image/png", image);
    t.upload("code#1.txt", "application/json", Buffer.from("本\n"));
    t.callbacks.onInstruction?.("hi", ["screen.png", "code#1.txt", "screen.png"]);
    await t.results(1);
    expect(t.prompts()).toEqual([expect.objectContaining({
      blocks: [
        { type: "text", bytes: 2 },
        { type: "image", mimeType: "image/png",
          checksum: createHash("sha256").update(image.toString("base64"))
            .digest("hex") },
        { type: "resource", resource: {
          uri: "attachment:///code%231.txt", mimeType: "text/plain", text: "本\n",
        } },
      ],
    })]);
    expect(t.rejections()).toEqual([]);
  });

  it.each([
    [{ embeddedContext: true, image: false }, ["text"], "image/png"],
    [{ image: true }, ["image"], "text/plain"],
    [{}, [], "image/png"],
  ] as const)("gates the intake by negotiated categories %#", async (caps, types, denied) => {
    const t = started({ caps });
    await t.ready();
    const ready = t.envelopes.find(e => e.state === "waiting_input");
    expect(ready?.ext?.session_capabilities).toMatchObject({
      supports_attachments: types.length > 0, attachment_types: types,
    });
    t.upload("disabled", denied, png());
    t.callbacks.onInstruction?.("refuse", ["disabled"]);
    t.callbacks.onInstruction?.("plain");
    await t.results(1);
    expect(t.rejections().map(e => e.payload.reason))
      .toEqual(["mime_denied", "timeout"]);
    expect(t.prompts()).toEqual([expect.objectContaining({
      blocks: [{ type: "text", bytes: 5 }],
    })]);
  });

  it("rejects unsupported, incomplete and unfit batches before ACP", async () => {
    const t = started();
    await t.ready();
    t.callbacks.onInstruction?.("control");
    await t.results(1);
    for (const mime of [
      "image/jpeg", "image/webp", "image/gif", "audio/wav", "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/octet-stream", "",
    ]) t.upload("denied", mime, Buffer.from("data"));
    t.callbacks.onAttachOpen?.({
      upload_id: "incomplete", filename: "incomplete", mime: "text/plain",
      size: 3, chunks: 1,
    });
    t.callbacks.onInstruction?.("incomplete", ["incomplete"]);
    t.upload("oversize.png", "image/png", png(PNG_BYTE_LIMIT + 1));
    t.callbacks.onInstruction?.("oversize", ["oversize.png"]);
    t.upload("spoof.png", "image/png", Buffer.from("not a PNG"));
    t.upload("sibling.txt", "text/plain", Buffer.from("valid"));
    t.callbacks.onInstruction?.("mixed", ["sibling.txt", "spoof.png"]);
    t.callbacks.onInstruction?.("after");
    await t.results(2);
    const reasons = t.rejections().map(e => e.payload.reason);
    expect(reasons.filter(reason => reason === "mime_denied")).toHaveLength(10);
    expect(reasons.slice(-3)).toEqual([
      "timeout", "unfittable_image", "unfittable_image",
    ]);
    expect(t.rejections().at(-1)?.payload.detail).toContain("Attachment 2");
    expect(t.prompts()).toHaveLength(2);
  });

  it("counts the escaped block-array boundary", async () => {
    const t = started();
    await t.ready();
    const resource = { type: "resource", resource: {
      uri: "attachment:///short.txt", mimeType: "text/plain", text: "ok",
    } };
    const escaped = '雪"\n\\\nsmall';
    const base = Buffer.byteLength(JSON.stringify([
      { type: "text", text: escaped }, resource,
    ]));
    const exact = "a".repeat(PROMPT_BYTE_LIMIT - base) + escaped;
    t.upload("short.txt", "text/plain", Buffer.from("ok"));
    t.callbacks.onInstruction?.(exact, ["short.txt"]);
    await t.results(1);
    t.upload("short.txt", "text/plain", Buffer.from("ok"));
    t.callbacks.onInstruction?.("a" + exact, ["short.txt"]);
    t.callbacks.onInstruction?.("after");
    await t.results(2);
    expect(t.prompts()[0].bytes).toBe(PROMPT_BYTE_LIMIT);
    expect(t.prompts()).toHaveLength(2);
    expect(t.rejections().map(e => e.payload.reason))
      .toEqual(["total_request_over"]);
  });

  it.each([134_217_727, 134_217_728])(
    "seals a %i-byte upload and refuses it as text before ACP",
    async (size) => {
      const t = started();
      await t.ready();
      t.callbacks.onInstruction?.("control");
      await t.results(1);
      t.callbacks.onAttachOpen?.({
        upload_id: "over", filename: "over", mime: "text/plain",
        size: 128 * 1024 * 1024 + 1, chunks: 1,
      });
      t.upload("full.txt", "text/plain", size);
      t.callbacks.onInstruction?.("full", ["full.txt"]);
      t.callbacks.onInstruction?.("after");
      await t.results(2);
      expect(t.rejections().map(e => e.payload.reason))
        .toEqual(["size_over", "text_too_large"]);
      expect(t.prompts()).toHaveLength(2);
    },
  );

  it("sends exactly 262,144 decoded bytes and refuses 262,145", async () => {
    const t = started();
    await t.ready();
    const text = "x".repeat(262_144);
    t.upload("exact.txt", "text/plain", Buffer.from("\ufeff" + text));
    t.callbacks.onInstruction?.("exact", ["exact.txt"]);
    await t.results(1);
    t.upload("valid.txt", "text/plain", Buffer.from("valid sibling"));
    t.upload("over.txt", "text/plain", Buffer.from(text + "y"));
    t.callbacks.onInstruction?.("over", ["valid.txt", "over.txt"]);
    t.callbacks.onInstruction?.("after");
    await t.results(2);
    expect(t.prompts()).toHaveLength(2);
    expect(t.prompts()[0].blocks[1].resource.text).toBe(text);
    expect(t.rejections()).toEqual([expect.objectContaining({
      type: "instruction_rejected",
      payload: expect.objectContaining({
        attachment_ids: ["valid.txt", "over.txt"],
        reason: "text_too_large",
        detail: expect.stringContaining("Attachment 2"),
      }),
    })]);
  });

  it("counts replacement characters toward the decoded text limit", async () => {
    const t = started();
    await t.ready();
    const raw = Buffer.concat([Buffer.from([0xff]),
      Buffer.from("あ".repeat((TEXT_BYTE_LIMIT - 3) / 3))]);
    t.upload("fits.txt", "text/plain", raw);
    t.callbacks.onInstruction?.("fits", ["fits.txt"]);
    await t.results(1);
    const text: string = t.prompts()[0].blocks[1].resource.text;
    expect(text).toMatch(/^�あ+$/);
    t.upload("decoding-expands.txt", "text/plain",
      Buffer.concat([raw, Buffer.from("xy")]));
    t.callbacks.onInstruction?.("over", ["decoding-expands.txt"]);
    t.callbacks.onInstruction?.("after");
    await t.results(2);
    expect(t.prompts()).toHaveLength(2);
    expect(t.rejections().map(e => e.payload.reason)).toEqual(["text_too_large"]);
  });

  it("drops idle staged uploads before the first queued prompt", async () => {
    const t = started();
    await t.ready();
    t.upload("idle", "text/plain", TEXT_BYTE_LIMIT + 1);
    t.callbacks.onInstruction?.("dropped", ["idle"]);
    t.callbacks.onInterrupt?.();
    t.callbacks.onInstruction?.("control");
    await t.results(1);
    expect(t.prompts()).toHaveLength(1);
    expect(t.rejections().map(e => e.payload.reason))
      .toEqual(["interrupted", "interrupted"]);
  });

  it("drops a queued upload in watchdog grace without another ACP prompt", async () => {
    const t = started({ watchdog: true });
    await t.ready();
    t.callbacks.onInstruction?.("sleep");
    t.upload("grace", "text/plain", TEXT_BYTE_LIMIT + 1);
    t.callbacks.onInstruction?.("dropped", ["grace"]);
    await vi.waitFor(() => expect(t.cancelSeen()).toBe(true));
    t.callbacks.onInterrupt?.();
    t.releaseCancel();
    t.callbacks.onInstruction?.("control");
    await t.results(2);
    expect(t.prompts()).toHaveLength(2);
    expect(t.rejections().map(e => e.payload.reason))
      .toEqual(["interrupted", "interrupted"]);
  });

  it("refuses attachments after initialize while session/new is pending", async () => {
    const t = started({ hangNew: true });
    await vi.waitFor(() => expect(t.methods).toContain("session/new"),
      { timeout: 5000 });
    t.upload("early.png", "image/png", png());
    t.upload("early.txt", "text/plain", Buffer.from("early"));
    expect(t.rejections().map(e => e.payload.reason))
      .toEqual(["mime_denied", "mime_denied"]);
    expect(t.prompts()).toEqual([]);
  });

  it("runs the interrupt intake path before creating the host", async () => {
    const drop = vi.spyOn(UploadIntake.prototype, "interrupt");
    const t = started({ delayed: true });
    t.upload("early", "text/plain", Buffer.from("early"));
    t.callbacks.onInterrupt?.();
    expect(drop).toHaveBeenCalledTimes(1);
    t.callbacks.onPersonaPrompt?.("persona");
    await t.ready();
    t.callbacks.onInstruction?.("early", ["early"]);
    t.callbacks.onInstruction?.("control");
    await t.results(1);
    expect(t.prompts()).toHaveLength(1);
    expect(t.rejections().map(e => e.payload.reason))
      .toEqual(["mime_denied", "timeout"]);
  });

  it("drops an attached instruction on close without a prompt or notice", async () => {
    const t = started();
    await t.ready();
    t.callbacks.onInstruction?.("control");
    await t.results(1);
    t.upload("closing", "text/plain", TEXT_BYTE_LIMIT + 1);
    t.callbacks.onInstruction?.("unsent", ["closing"]);
    t.close();
    await t.work;
    expect(t.prompts()).toHaveLength(1);
    expect(t.rejections().map(e => e.payload.reason))
      .toEqual(["interrupted", "interrupted"]);
  });
});
