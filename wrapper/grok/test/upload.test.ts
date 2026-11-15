import "../../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { OfficeParser } from "officeparser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { imageDroppedNotes } from "../src/grok/events.js";
import {
  attachmentDirPrefix,
  attachmentName,
  buildAttachmentParts,
  DefaultOfficeTextExtractor,
  MAX_INFLIGHT_UPLOADS,
  OFFICE_MAX_UNCOMPRESSED_BYTES,
  PENDING_UPLOAD_GC_INTERVAL_MS,
  PENDING_UPLOAD_TTL_MS,
  sweepAttachmentDirs,
  TEXT_BYTE_LIMIT,
  textBody,
  UploadIntake,
  type OfficeTextExtractor,
} from "../src/upload.js";
import { chunkPayload, DOCX, ooxml, PPTX, recordingIntake, rejections, upload, XLSX } from "./upload-support.js";

const config: WrapperConfig = {
  agent_id: "grok-upload-test",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  display_name: "Grok upload test",
  server_url: "ws://127.0.0.1:1/agent",
};
const intakes: UploadIntake[] = [];
const scratch: string[] = [];
afterEach(() => {
  for (const intake of intakes.splice(0)) intake.close();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function created(now?: () => number) {
  const made = recordingIntake(config, now);
  intakes.push(made.intake);
  return made;
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe("upload intake", () => {
  it("seals a complete upload and stages it once", () => {
    const { intake, envelopes } = created();
    upload(intake, "u1", "a.txt", "text/plain", bytes("hello world"), 4);
    const record = intake.stage(["u1"]);
    expect(record?.uploads.map((u) => u.meta.upload_id)).toEqual(["u1"]);
    expect(envelopes).toEqual([]);
    // Staging moved it: a second instruction cannot take it again.
    expect(intake.stage(["u1"])).toBeUndefined();
    expect(rejections(envelopes)).toEqual([
      { type: "instruction_rejected", attachment_ids: ["u1"], reason: "timeout",
        detail: "unknown upload_id u1" },
    ]);
  });
  it.each([
    [{ mime: "application/zip", size: 1, chunks: 1 }, "mime_denied"],
    [{ mime: "text/plain", size: 128 * 1024 * 1024 + 1, chunks: 1 }, "size_over"],
    [{ mime: "text/plain", size: 1.5, chunks: 1 }, "size_over"],
    [{ mime: "text/plain", size: 1, chunks: 0 }, "size_over"],
  ])("refuses an invalid attach_open %#", (meta, reason) => {
    const { intake, envelopes } = created();
    intake.attachOpen({ upload_id: "bad", filename: "x", ...meta });
    expect(rejections(envelopes)).toEqual([
      expect.objectContaining({ type: "attach_rejected", upload_id: "bad", reason }),
    ]);
    expect(intake.stage(["bad"])).toBeUndefined();
  });
  it("refuses the 21st open upload", () => {
    const { intake, envelopes } = created();
    for (let i = 0; i <= MAX_INFLIGHT_UPLOADS; i += 1)
      intake.attachOpen({ upload_id: `u${i}`, filename: "x", mime: "text/plain", size: 1, chunks: 1 });
    expect(rejections(envelopes)).toEqual([
      expect.objectContaining({ type: "attach_rejected", upload_id: "u20", reason: "count_over" }),
    ]);
  });
  it("removes an upload whose chunks exceed the declared size", () => {
    const { intake, envelopes } = created();
    intake.attachOpen({ upload_id: "u1", filename: "x", mime: "text/plain", size: 3, chunks: 1 });
    intake.attachChunk(chunkPayload("u1", 0, bytes("four")));
    expect(rejections(envelopes)).toEqual([
      expect.objectContaining({ type: "attach_rejected", upload_id: "u1", reason: "size_over" }),
    ]);
    intake.attachClose("u1");
    expect(rejections(envelopes)).toHaveLength(1);
  });
  it.each([
    ["a missing chunk", 2, ["ab"], "timeout"],
    ["a size mismatch", 1, ["ab"], "size_over"],
  ] as const)("removes an upload closed with %s", (_name, chunks, parts, reason) => {
    const { intake, envelopes } = created();
    intake.attachOpen({ upload_id: "u1", filename: "x", mime: "text/plain", size: 3, chunks });
    parts.forEach((part, index) => intake.attachChunk(chunkPayload("u1", index, bytes(part))));
    intake.attachClose("u1");
    expect(rejections(envelopes)).toEqual([
      expect.objectContaining({ type: "attach_rejected", upload_id: "u1", reason }),
    ]);
  });
  it("times out a pending upload after five minutes, but not a staged one", () => {
    let now = 1_000;
    const { intake, envelopes } = created(() => now);
    upload(intake, "staged", "a.txt", "text/plain", bytes("a"));
    upload(intake, "pending", "b.txt", "text/plain", bytes("b"));
    const record = intake.stage(["staged"]);
    now += PENDING_UPLOAD_TTL_MS;
    intake.sweep();
    expect(rejections(envelopes)).toEqual([]);
    now += 1;
    intake.sweep();
    expect(rejections(envelopes)).toEqual([
      expect.objectContaining({ type: "attach_rejected", upload_id: "pending", reason: "timeout" }),
    ]);
    expect(record?.dropped).toBe(false);
  });
  it("sweeps every 60 s on an interval that does not keep the process alive", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    created();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), PENDING_UPLOAD_GC_INTERVAL_MS);
    const timer = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
  });
  it.each([
    ["too many ids", Array.from({ length: 11 }, () => "u1"), "count_over"],
    ["an unknown id", ["u1", "missing"], "timeout"],
    ["an incomplete upload", ["u1", "open"], "timeout"],
  ])("refuses %s at staging and consumes nothing", (_name, ids, reason) => {
    const { intake, envelopes } = created();
    upload(intake, "u1", "a.txt", "text/plain", bytes("a"));
    intake.attachOpen({ upload_id: "open", filename: "o", mime: "text/plain", size: 2, chunks: 2 });
    expect(intake.stage(ids)).toBeUndefined();
    expect(rejections(envelopes)).toEqual([
      expect.objectContaining({ type: "instruction_rejected", attachment_ids: ids, reason }),
    ]);
    // A later valid instruction can use the same upload.
    expect(intake.stage(["u1"])?.uploads).toHaveLength(1);
  });
  it("checks a repeated id before anything moves and attaches it once", () => {
    const { intake, envelopes } = created();
    upload(intake, "u1", "a.txt", "text/plain", bytes("a"));
    const record = intake.stage(["u1", "u1"]);
    expect(record?.ids).toEqual(["u1", "u1"]);
    expect(record?.uploads.map((u) => u.meta.upload_id)).toEqual(["u1"]);
    intake.interrupt();
    expect(rejections(envelopes)).toEqual([
      { type: "attach_rejected", upload_id: "u1", reason: "interrupted" },
      { type: "instruction_rejected", attachment_ids: ["u1", "u1"], reason: "interrupted" },
    ]);
  });
  it("drops pending uploads and unstarted records once, and leaves finished ones", () => {
    const { intake, envelopes } = created();
    upload(intake, "p", "p.txt", "text/plain", bytes("p"));
    upload(intake, "a", "a.txt", "text/plain", bytes("a"));
    upload(intake, "b", "b.txt", "text/plain", bytes("b"));
    upload(intake, "c", "c.txt", "text/plain", bytes("c"));
    const queued = intake.stage(["a", "b"])!;
    const started = intake.stage(["c"])!;
    const onDrop = vi.fn();
    queued.onDrop = onDrop;
    started.finish();
    intake.interrupt();
    intake.interrupt();
    expect(rejections(envelopes)).toEqual([
      { type: "attach_rejected", upload_id: "p", reason: "interrupted" },
      { type: "attach_rejected", upload_id: "a", reason: "interrupted" },
      { type: "attach_rejected", upload_id: "b", reason: "interrupted" },
      { type: "instruction_rejected", attachment_ids: ["a", "b"], reason: "interrupted" },
    ]);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(queued.dropped).toBe(true);
    expect(started.dropped).toBe(false);
  });
  it("refuses a record while it is built and discards its uploads", () => {
    const { intake, envelopes } = created();
    upload(intake, "a", "a.docx", DOCX, bytes("a"));
    const record = intake.stage(["a"])!;
    record.refuse("sdk_error", "office text extraction failed");
    intake.interrupt();
    expect(rejections(envelopes)).toEqual([
      { type: "instruction_rejected", attachment_ids: ["a"], reason: "sdk_error",
        detail: "office text extraction failed" },
    ]);
  });
  it("closes once, and refuses a later instruction as interrupted", () => {
    const { intake, envelopes } = created();
    upload(intake, "a", "a.txt", "text/plain", bytes("a"));
    const clear = vi.spyOn(globalThis, "clearInterval");
    intake.close();
    intake.close();
    expect(clear).toHaveBeenCalledTimes(1);
    upload(intake, "b", "b.txt", "text/plain", bytes("b"));
    expect(intake.stage(["b"])).toBeUndefined();
    expect(rejections(envelopes)).toEqual([
      { type: "attach_rejected", upload_id: "a", reason: "interrupted" },
      { type: "instruction_rejected", attachment_ids: ["b"], reason: "interrupted",
        detail: "the wrapper is shutting down" },
    ]);
  });
});

describe("text rule", () => {
  it.each([
    ["exactly 1 MB of ASCII", "a".repeat(TEXT_BYTE_LIMIT), false],
    ["1 MB and one byte", "a".repeat(TEXT_BYTE_LIMIT + 1), true],
  ])("keeps %s whole only up to the limit", (_name, text, truncated) => {
    const body = textBody(bytes(text));
    expect(body.startsWith("a".repeat(TEXT_BYTE_LIMIT))).toBe(true);
    expect(body.includes("[...truncated")).toBe(truncated);
  });
  it("cuts before a multibyte character that crosses the limit", () => {
    const text = "a".repeat(TEXT_BYTE_LIMIT - 1) + "あ";
    const body = textBody(bytes(text));
    expect(body.split("\n")[0]).toBe("a".repeat(TEXT_BYTE_LIMIT - 1));
    expect(body).toContain(`original ${TEXT_BYTE_LIMIT + 2} bytes`);
  });
  it("keeps invalid UTF-8 as replacement characters within the byte budget", () => {
    const invalid = new Uint8Array(TEXT_BYTE_LIMIT).fill(0xff);
    const body = textBody(invalid);
    const kept = body.split("\n")[0]!;
    expect(kept).toMatch(/^�+$/);
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(TEXT_BYTE_LIMIT);
    expect(body).toContain("[...truncated");
  });
  it("replaces path separators and control characters in a name", () => {
    expect(attachmentName("../a\\b\u0000c\u001fd\u007fe.txt")).toBe(".._a_b_c_d_e.txt");
    expect(attachmentName("")).toBe("attachment");
  });
});

describe("blocks", () => {
  const extractor = (result: Promise<string | null>): OfficeTextExtractor => ({ extract: () => result });
  function staged(entries: [string, string, Uint8Array][]) {
    const { intake } = created();
    entries.forEach(([id, mime, data], index) => upload(intake, id, `f${index}`, mime, data));
    return intake.stage(entries.map(([id]) => id))!;
  }
  it("maps each kind to its block in order", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const record = staged([["i", "image/png", png], ["t", "application/json", bytes("{}")],
      ["o", DOCX, bytes("doc")], ["p", "application/pdf", bytes("%PDF")]]);
    const built = await buildAttachmentParts(record.uploads, extractor(Promise.resolve("OFFICE_TEXT")));
    expect(built).toEqual({ ok: true, parts: [
      { type: "image", mimeType: "image/png", data: Buffer.from(png).toString("base64") },
      { type: "resource", resource: { uri: "attachment:///f1", mimeType: "application/json", text: "{}" } },
      { type: "resource", resource: { uri: "attachment:///f2", mimeType: "text/plain", text: "OFFICE_TEXT" } },
      { kind: "pdf", name: "f3", file: expect.stringMatching(/^0-[0-9a-f-]{36}\.pdf$/), bytes: bytes("%PDF") },
    ] });
  });
  it.each([
    ["null", () => Promise.resolve(null)],
    ["a throw", () => Promise.reject(new Error("parser crashed"))],
  ])("refuses an Office extraction that returns %s with sdk_error", async (_name, result) => {
    const record = staged([["o", DOCX, bytes("doc")]]);
    await expect(buildAttachmentParts(record.uploads, extractor(result()))).resolves.toEqual(
      { ok: false, reason: "sdk_error", detail: "office text extraction failed" });
  });
  it.each([["docx", DOCX], ["xlsx", XLSX], ["pptx", PPTX]] as const)(
    "extracts the text of a %s", async (kind, mime) => {
      const text = await new DefaultOfficeTextExtractor().extract(ooxml(kind, `${kind.toUpperCase()}_CODE`), mime);
      expect(text).toContain(`${kind.toUpperCase()}_CODE`);
    });
  it("refuses a declared size over 64 MiB before the parser runs", async () => {
    const parse = vi.spyOn(OfficeParser, "parseOffice");
    const bomb = zipSync({ "word/document.xml": new Uint8Array(OFFICE_MAX_UNCOMPRESSED_BYTES + 1) });
    await expect(new DefaultOfficeTextExtractor().extract(bomb, DOCX)).resolves.toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });
  it("refuses corrupt OOXML", async () => {
    await expect(new DefaultOfficeTextExtractor().extract(bytes("PK\u0003\u0004 broken"), DOCX))
      .resolves.toBeNull();
  });
});

describe("attachment directories", () => {
  it("removes this agent's leftovers only", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-grok-sweep-test-"));
    scratch.push(root);
    const own = join(root, `${attachmentDirPrefix("agent-a")}leftover`);
    const other = join(root, `${attachmentDirPrefix("agent-b")}active`);
    const unrelated = join(root, "kaoiro-grok-attach-unrelated");
    for (const dir of [own, other, unrelated]) mkdirSync(dir);
    const warnings: string[] = [];
    sweepAttachmentDirs(root, "agent-a", (line) => warnings.push(line));
    expect([existsSync(own), existsSync(other), existsSync(unrelated)]).toEqual([false, true, true]);
    expect(warnings).toEqual([]);
  });
  it("names the prefix after the full SHA-256 of the agent id", () => {
    expect(attachmentDirPrefix("a")).toMatch(/^kaoiro-grok-attach-[0-9a-f]{64}-$/);
    expect(attachmentDirPrefix("a")).not.toBe(attachmentDirPrefix("b"));
  });
});

describe("image_dropped", () => {
  const recorded = {
    sessionId: "s1",
    update: { sessionUpdate: "image_dropped",
      notes: ["Image 1 was dropped before send: too small (7×7); images must be at least 8×8 pixels."] },
    _meta: { eventId: "s1-5", agentTimestampMs: 1 },
  };
  it("reads the notes of the current session's message", () => {
    expect(imageDroppedNotes(recorded, "s1")).toEqual(recorded.update.notes);
  });
  it.each([
    ["another session", { ...recorded, sessionId: "s2" }, "s1"],
    ["a missing session id", { update: recorded.update }, "s1"],
    ["no session yet", { update: recorded.update }, undefined],
    ["another update", { ...recorded, update: { sessionUpdate: "turn_completed" } }, "s1"],
  ])("ignores %s", (_name, params, session) => {
    expect(imageDroppedNotes(params as Record<string, unknown>, session)).toEqual([]);
  });
});
