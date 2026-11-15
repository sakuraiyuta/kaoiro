import "../../../scripts/test/fixtures/test-isolation.mjs";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import type { PermissionSelection } from "@kaoiro/protocol";
import { AcpSession } from "../src/acp/session.js";
import { GrokHost, type GrokHostOptions } from "../src/host.js";
import { attachmentDirPrefix, PROMPT_BYTE_LIMIT, UploadIntake, type OfficeTextExtractor } from "../src/upload.js";
import { DOCX, ooxml, rejections, upload } from "./upload-support.js";

const executable = fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url));
const hosts: GrokHost[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.close();
    await host.closed;
  }
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const choose = (revision: number, sandbox: PermissionSelection["requested"]["sandbox"], network_access: boolean) =>
  ({ revision, requested: { sandbox, network_access } });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
/** "resolved", "rejected", or "pending" when it has not settled in time. */
function settledWithin(promise: Promise<unknown>, ms = 1_000) {
  return Promise.race([
    promise.then(() => "resolved", () => "rejected"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

async function started(extra: Partial<GrokHostOptions> = {}, configExtra: Partial<WrapperConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-grok-attach-test-"));
  scratch.push(root);
  const attachmentRoot = join(root, "tmp");
  mkdirSync(attachmentRoot);
  const events = join(root, "events.jsonl");
  const config: WrapperConfig = {
    agent_id: `grok-attach-${randomUUID()}`,
    persona: { id: "default", name: "Default", sprite_set: "default" },
    display_name: "Grok attachments",
    server_url: "ws://127.0.0.1:1/agent",
    ...configExtra,
  };
  const envelopes: Envelope[] = [];
  const ends: string[] = [];
  let host!: GrokHost;
  const intake = new UploadIntake({ config, send: (e) => envelopes.push(e), state: () => host.state });
  host = new GrokHost({
    config, cwd: root, personaPrompt: "fixture", executable, intake, attachmentRoot,
    env: { ...process.env, KAOIRO_TEST_GROK_EVENTS: events },
    send: (e) => envelopes.push(e),
    decidePermission: async () => ({ allow: false }),
    onTurnEnd: (turn) => ends.push(turn.turnToken),
    ...extra,
  });
  hosts.push(host);
  void host.run().catch(() => {});
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5_000 });
  const records = (): Record<string, unknown>[] => existsSync(events)
    ? readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const prompts = () => records().filter((r) => r.event === "prompt_blocks")
    .map((r) => r.blocks as Record<string, unknown>[]);
  const dirs = () => readdirSync(attachmentRoot);
  const userLogs = () => envelopes.filter((e) => e.type === "log" && e.payload.kind === "user")
    .map((e) => e.payload.text);
  return { host, intake, envelopes, ends, prompts, dirs, userLogs, attachmentRoot, config };
}
type Started = Awaited<ReturnType<typeof started>>;
function imageRecord(t: Started, id: string) {
  upload(t.intake, id, `${id}.png`, "image/png", PNG);
  return t.intake.stage([id])!;
}
function pdfRecord(t: Started, id: string, pdf = bytes("%PDF-1.4 fixture")) {
  upload(t.intake, id, `${id}.pdf`, "application/pdf", pdf);
  return t.intake.stage([id])!;
}
const interrupted = (ids: string[]) => [
  ...ids.map((id) => ({ type: "attach_rejected", upload_id: id, reason: "interrupted" })),
  { type: "instruction_rejected", attachment_ids: ids, reason: "interrupted" },
];

describe("prompt blocks", () => {
  it("sends each kind as its block and removes the PDF after the turn", async () => {
    const t = await started();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const pdf = bytes("%PDF-1.4 PDF_CODE");
    upload(t.intake, "j", "photo.jpg", "image/jpeg", jpeg);
    upload(t.intake, "t", "notes.txt", "text/plain", bytes("TEXT_CODE"));
    upload(t.intake, "d", "report.docx", DOCX, ooxml("docx", "DOCX_CODE"));
    upload(t.intake, "p", "paper.pdf", "application/pdf", pdf);
    await t.host.send("kinds", t.intake.stage(["j", "t", "d", "p"]));
    const [blocks] = t.prompts();
    expect(blocks).toEqual([
      { type: "text", textLength: 5, textSha: sha("kinds") },
      { type: "image", mimeType: "image/jpeg", dataSha: sha(Buffer.from(jpeg).toString("base64")) },
      { type: "resource", uri: "attachment:///notes.txt", mimeType: "text/plain", text: "TEXT_CODE" },
      { type: "resource", uri: "attachment:///report.docx", mimeType: "text/plain",
        text: expect.stringContaining("DOCX_CODE") },
      { type: "resource_link", uri: expect.stringMatching(/^file:\/\//), name: "paper.pdf",
        mimeType: "application/pdf", fileSha: sha(pdf), fileMode: 0o600 },
    ]);
    const link = fileURLToPath(blocks![4]!.uri as string);
    expect(link.startsWith(join(t.attachmentRoot, attachmentDirPrefix(t.config.agent_id)))).toBe(true);
    expect(t.dirs()).toEqual([]);
    expect(t.userLogs()).toEqual(["kinds"]);
  });
  it("still sends a text-only instruction as one text block", async () => {
    const t = await started();
    await t.host.send("plain");
    expect(t.prompts()).toEqual([[{ type: "text", textLength: 5, textSha: sha("plain") }]]);
  });
  it("removes the PDF directory after a failed turn", async () => {
    const t = await started();
    await expect(t.host.send("fail-turn", pdfRecord(t, "p"))).rejects.toThrow();
    expect(t.prompts()).toHaveLength(1);
    expect(t.dirs()).toEqual([]);
  });
});

describe("the size limit (F10)", () => {
  // JSON.stringify([{type:"text",text}]) is 27 bytes plus the escaped text.
  function textAt(bytesWanted: number) {
    const head = "cap:あ\n\"\\\u0001";
    const used = Buffer.byteLength(JSON.stringify([{ type: "text", text: head }]));
    return head + "x".repeat(bytesWanted - used);
  }
  it("accepts blocks of exactly 33,488,896 bytes", async () => {
    const t = await started();
    const text = textAt(PROMPT_BYTE_LIMIT);
    expect(Buffer.byteLength(JSON.stringify([{ type: "text", text }]))).toBe(33_488_896);
    await t.host.send(text);
    expect(t.prompts()).toEqual([[{ type: "text", textLength: text.length, textSha: sha(text) }]]);
    expect(rejections(t.envelopes)).toEqual([]);
  });
  it("refuses one byte more and keeps running", async () => {
    const t = await started();
    await expect(t.host.send(textAt(PROMPT_BYTE_LIMIT + 1))).rejects.toThrow("size limit");
    expect(rejections(t.envelopes)).toEqual([{ type: "instruction_rejected", reason: "total_request_over",
      detail: `bytes=${PROMPT_BYTE_LIMIT + 1} limit=${PROMPT_BYTE_LIMIT}` }]);
    await t.host.send("after");
    expect(t.prompts()).toHaveLength(1);
  });
  it("refuses an instruction whose attachments exceed it and resolves", async () => {
    const t = await started();
    upload(t.intake, "big", "big.png", "image/png", new Uint8Array(25_200_000), 4 * 1024 * 1024);
    await expect(t.host.send("too big", t.intake.stage(["big"]))).resolves.toBeUndefined();
    expect(rejections(t.envelopes)).toEqual([expect.objectContaining({ type: "instruction_rejected",
      attachment_ids: ["big"], reason: "total_request_over" })]);
    expect(t.prompts()).toEqual([]);
  });
});

describe("Office extraction failure", () => {
  it("refuses the instruction with sdk_error and keeps the host working", async () => {
    const t = await started();
    upload(t.intake, "d", "broken.docx", DOCX, bytes("PK\u0003\u0004 broken"));
    await expect(t.host.send("broken", t.intake.stage(["d"]))).resolves.toBeUndefined();
    expect(rejections(t.envelopes)).toEqual([{ type: "instruction_rejected", attachment_ids: ["d"],
      reason: "sdk_error", detail: "office text extraction failed" }]);
    await t.host.send("after");
    expect(t.userLogs()).toEqual(["after"]);
  });
});

describe("G1: a dropped instruction is never queued", () => {
  function heldExtractor() {
    const entered = deferred();
    const release = deferred<string | null>();
    const extractor: OfficeTextExtractor = { extract: () => { entered.resolve(); return release.promise; } };
    return { extractor, entered, release };
  }
  it("resolves an instruction interrupted while it is built", async () => {
    const held = heldExtractor();
    const t = await started({ officeExtractor: held.extractor });
    upload(t.intake, "d", "a.docx", DOCX, bytes("doc"));
    const sent = t.host.send("office", t.intake.stage(["d"]));
    await held.entered.promise;
    await t.host.interrupt();
    expect(rejections(t.envelopes)).toEqual(interrupted(["d"]));
    held.release.resolve("TEXT");
    expect(await settledWithin(sent)).toBe("resolved");
    expect(t.prompts()).toEqual([]);
  });
  it("resolves an instruction dropped before it reached the host", async () => {
    const t = await started();
    const record = imageRecord(t, "i");
    await t.host.interrupt();
    expect(await settledWithin(t.host.send("late", record))).toBe("resolved");
    expect(rejections(t.envelopes)).toEqual(interrupted(["i"]));
    expect(t.prompts()).toEqual([]);
  });
  it("resolves an instruction built while the host closes", async () => {
    const held = heldExtractor();
    const t = await started({ officeExtractor: held.extractor });
    upload(t.intake, "d", "a.docx", DOCX, bytes("doc"));
    const sent = t.host.send("office", t.intake.stage(["d"]));
    await held.entered.promise;
    t.host.close();
    held.release.resolve("TEXT");
    expect(await settledWithin(sent)).toBe("resolved");
    expect(rejections(t.envelopes)).toEqual(interrupted(["d"]));
  });
});

describe("G2: a dropped queued turn never runs; T4: a text-only turn behind it does", () => {
  async function queueBehindHold(t: Started, entered: Promise<void>, withText: boolean) {
    const sentA = t.host.send("attachment-a", imageRecord(t, "a"), [], "token-a");
    await entered;
    const sentT = withText ? t.host.send("text-t") : undefined;
    await t.host.interrupt();
    expect(rejections(t.envelopes)).toEqual(interrupted(["a"]));
    expect(await settledWithin(sentA, 100)).toBe("resolved");
    return { sentT };
  }
  async function expectOnlyText(t: Started, sentT: Promise<void> | undefined) {
    await sentT;
    expect(t.userLogs()).toEqual(["text-t"]);
    expect(t.prompts()).toEqual([[{ type: "text", textLength: 6, textSha: sha("text-t") }]]);
    expect(t.ends.filter((token) => token === "token-a")).toHaveLength(1);
    expect(t.host.state).toBe("waiting_input");
  }
  it("while the head waits for permission sync (row 6)", async () => {
    let hold = true;
    const entered = deferred();
    const release = deferred();
    const t = await started({ waitForPermissionSync: () => {
      if (!hold) return Promise.resolve();
      entered.resolve();
      return release.promise;
    } });
    const { sentT } = await queueBehindHold(t, entered.promise, true);
    hold = false;
    release.resolve();
    await expectOnlyText(t, sentT);
  });
  it("while the head waits for a permission restart (row 7)", async () => {
    let hold = false;
    const entered = deferred();
    const release = deferred();
    const t = await started({
      permissionSyncSupported: true, platform: "linux",
      onLaneStep: async (step) => {
        if (!hold || step !== "inspect") return;
        hold = false;
        entered.resolve();
        await release.promise;
      },
    }, { sandbox: "danger-full-access", network_access: true });
    await t.host.setPermission(choose(1, "workspace-write", true));
    hold = true;
    const { sentT } = await queueBehindHold(t, entered.promise, true);
    release.resolve();
    await expectOnlyText(t, sentT);
  });
  it("while the head waits for a model switch (row 8)", async () => {
    let holdSync = true;
    const syncEntered = deferred();
    const syncRelease = deferred();
    const switchEntered = deferred();
    const switchRelease = deferred();
    const original = AcpSession.prototype.setConfigOption;
    vi.spyOn(AcpSession.prototype, "setConfigOption").mockImplementation(async function (
      this: AcpSession, ...args: Parameters<AcpSession["setConfigOption"]>) {
      switchEntered.resolve();
      await switchRelease.promise;
      return original.apply(this, args);
    });
    const t = await started({ waitForPermissionSync: () => {
      if (!holdSync) return Promise.resolve();
      syncEntered.resolve();
      return syncRelease.promise;
    } });
    const sentA = t.host.send("attachment-a", imageRecord(t, "a"), [], "token-a");
    await syncEntered.promise;
    const sentT = t.host.send("text-t");
    await t.host.setModel("grok-4.6");
    holdSync = false;
    syncRelease.resolve();
    await switchEntered.promise;
    await t.host.interrupt();
    expect(rejections(t.envelopes)).toEqual(interrupted(["a"]));
    expect(await settledWithin(sentA, 100)).toBe("resolved");
    switchRelease.resolve();
    await expectOnlyText(t, sentT);
  });
  it("returns to waiting_input when the dropped head was the last turn (R3-S2)", async () => {
    const t = await started({ permissionSyncSupported: true, platform: "linux",
      permissionGateTimeoutMs: 10_000 });
    await t.host.send("no-prompt-id");
    expect(t.host.statusExtSnapshot().permission_gate).toMatchObject({ reason: "observation_unavailable" });
    const sentA = t.host.send("attachment-a", imageRecord(t, "a"), [], "token-a");
    await vi.waitFor(() => expect(t.host.state).toBe("waiting_permission"));
    await t.host.interrupt();
    expect(await settledWithin(sentA, 100)).toBe("resolved");
    await t.host.setPermission(choose(1, "workspace-write", true));
    await vi.waitFor(() => expect(t.host.state).toBe("waiting_input"));
    expect(t.prompts()).toHaveLength(1);
  });
});

describe("G3: a dropped turn is not reported or settled again", () => {
  it("after the permission gate times out", async () => {
    const t = await started({ permissionSyncSupported: true, platform: "linux",
      permissionGateTimeoutMs: 300 });
    await t.host.send("no-prompt-id");
    const sentA = t.host.send("attachment-a", imageRecord(t, "a"), [], "token-a");
    await vi.waitFor(() => expect(t.host.state).toBe("waiting_permission"));
    await t.host.interrupt();
    expect(await settledWithin(sentA, 100)).toBe("resolved");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(t.envelopes.filter((e) => e.type === "result" && e.payload.error_code === "permission_gate_blocked"))
      .toEqual([]);
    expect(t.ends.filter((token) => token === "token-a")).toHaveLength(1);
    expect(t.host.state).toBe("waiting_input");
  });
  it("when the host closes", async () => {
    const entered = deferred();
    const t = await started({ waitForPermissionSync: () => {
      entered.resolve();
      return new Promise(() => {});
    } });
    const sentA = t.host.send("attachment-a", imageRecord(t, "a"), [], "token-a");
    await entered.promise;
    t.host.close();
    expect(await settledWithin(sentA, 100)).toBe("resolved");
    expect(t.ends.filter((token) => token === "token-a")).toHaveLength(1);
    expect(rejections(t.envelopes)).toEqual(interrupted(["a"]));
  });
});

describe("a running attachment turn", () => {
  async function holding(t: Started) {
    const sent = t.host.send("hold-chunks", pdfRecord(t, "p"));
    void sent.catch(() => {});
    await vi.waitFor(() => expect(t.prompts()).toHaveLength(1), { timeout: 5_000 });
    const [dir] = t.dirs();
    expect(dir?.startsWith(attachmentDirPrefix(t.config.agent_id))).toBe(true);
    const path = join(t.attachmentRoot, dir!);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(readdirSync(path).map((name) => statSync(join(path, name)).mode & 0o777)).toEqual([0o600]);
    return { sent };
  }
  it("T6: an interrupt sends no rejection for its uploads and ends it interrupted", async () => {
    const t = await started();
    const { sent } = await holding(t);
    await t.host.interrupt();
    await sent;
    expect(rejections(t.envelopes)).toEqual([]);
    expect(t.envelopes.find((e) => e.type === "result")?.ext).toMatchObject({ interrupted: true });
  });
  it("T7: the directory is removed when the turn ends", async () => {
    const t = await started();
    const { sent } = await holding(t);
    await t.host.interrupt();
    await sent;
    expect(t.dirs()).toEqual([]);
  });
  it("T8: close removes the directory at once", async () => {
    const t = await started();
    await holding(t);
    t.host.close();
    expect(t.dirs()).toEqual([]);
  });
});

describe("image_dropped", () => {
  it("logs one line for the current session's note only", async () => {
    const t = await started();
    await t.host.send("image-dropped");
    const lines = t.envelopes.filter((e) => e.type === "log" && e.payload.kind === "system")
      .map((e) => String(e.payload.text));
    expect(lines.filter((line) => line.includes("dropped") || line.includes("NOTE"))).toEqual([
      "Grok: Image 1 was dropped before send: too small (7×7); images must be at least 8×8 pixels.",
    ]);
  });
});

describe("the startup sweep", () => {
  it("removes this agent's leftover and keeps another agent's directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-grok-attach-sweep-"));
    scratch.push(root);
    const agent = `grok-sweep-${randomUUID()}`;
    const own = join(root, `${attachmentDirPrefix(agent)}crashed`);
    const other = join(root, `${attachmentDirPrefix(`${agent}-other`)}active`);
    mkdirSync(own);
    mkdirSync(other);
    await started({ attachmentRoot: root }, { agent_id: agent });
    expect([existsSync(own), existsSync(other)]).toEqual([false, true]);
  });
});
