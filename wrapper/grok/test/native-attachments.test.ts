import { permitHostAccess } from "../../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { ServerLinkOptions } from "@kaoiro/wrapper-core";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { attachmentDirPrefix, PROMPT_BYTE_LIMIT } from "../src/upload.js";
import { makeGrokScratch, removeGrokState } from "./grok-state.js";
import { nativeRun } from "./native-support.js";
import { chunkPayload, DOCX, ooxml } from "./upload-support.js";

permitHostAccess({
  kinds: ["network"],
  optIn: "KAOIRO_LIVE_GROK",
  reason: "live Grok run against a local model stub",
});

// issue #1143 acceptance against the real grok. Only the model API is a
// local stub (GROK_CLI_CHAT_PROXY_BASE_URL, GROK_XAI_API_BASE_URL): it can
// hold a request, then answers every request with HTTP 400, so each turn
// ends failed. Runs only with KAOIRO_LIVE_GROK=1.

const live = process.env.KAOIRO_LIVE_GROK === "1";
const JPEG = readFileSync(new URL("./fixtures/attachment-32x32.jpg", import.meta.url));
const config = (agent: string): WrapperConfig => ({
  agent_id: `native.attachments.${agent}`, display_name: "Attachments fixture",
  server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  sandbox: "workspace-write", network_access: true,
});

/** An RGB PNG of the given size, all black. */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))),
    chunk("IEND", Buffer.alloc(0))]);
}

interface Hold { marker: string; taken: boolean; arrived: (body: string) => void; release: Promise<void> }
async function modelStub() {
  const bodies: string[] = [];
  const holds: Hold[] = [];
  const decode = (request: IncomingMessage, raw: Buffer) => {
    const encoding = request.headers["content-encoding"];
    if (encoding === "gzip") return gunzipSync(raw);
    if (encoding === "deflate") return inflateSync(raw);
    if (encoding === "zstd") return zstdDecompressSync(raw);
    return raw;
  };
  const answer = (response: ServerResponse) => {
    if (response.destroyed) return;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "stub stop", type: "invalid_request_error",
      code: "invalid_value" } }));
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = decode(request, Buffer.concat(chunks)).toString("utf8");
      bodies.push(body);
      // Grok asks for a session title in a request of its own; only the turn's
      // own request is held.
      const hold = holds.find((entry) => !entry.taken && body.includes(entry.marker) &&
        !body.includes('"name":"session_title"'));
      if (!hold) return answer(response);
      hold.taken = true;
      hold.arrived(body);
      void hold.release.then(() => answer(response));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    bodies,
    env: { ...process.env, GROK_CLI_CHAT_PROXY_BASE_URL: base, GROK_XAI_API_BASE_URL: base },
    /** Holds the first turn request whose body holds `marker` until released. */
    hold(marker: string) {
      let arrived!: (body: string) => void;
      let release!: () => void;
      const body = new Promise<string>((resolve) => { arrived = resolve; });
      holds.push({ marker, taken: false, arrived, release: new Promise((resolve) => { release = resolve; }) });
      return { body, release };
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
type Stub = Awaited<ReturnType<typeof modelStub>>;

function send(callbacks: ServerLinkOptions, id: string, filename: string, mime: string, bytes: Uint8Array) {
  callbacks.onAttachOpen?.({ upload_id: id, filename, mime, size: bytes.byteLength, chunks: 1 });
  callbacks.onAttachChunk?.(chunkPayload(id, 0, bytes));
  callbacks.onAttachClose?.(id);
}
const attachmentDirs = (agent: string) => readdirSync(tmpdir())
  .filter((name) => name.startsWith(attachmentDirPrefix(config(agent).agent_id)))
  .map((name) => join(tmpdir(), name));
const results = (envelopes: Envelope[]) => envelopes.filter((e) => e.type === "result");
const ready = (host: { state: string }) =>
  vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 60_000 });

async function withStub(run: (stub: Stub, cwd: string) => Promise<void>) {
  const stub = await modelStub();
  const cwd = makeGrokScratch("attachments");
  try {
    await run(stub, cwd);
  } finally {
    await stub.close();
    removeGrokState(cwd);
  }
}

describe.skipIf(!live)("native attachments", () => {
  it("(a) sends every kind and keeps the PDF private only while the turn runs", async () => {
    await withStub(async (stub, cwd) => {
      await nativeRun(config("a"), cwd, async (host, callbacks, envelopes) => {
        await ready(host);
        const held = stub.hold("NATIVE_1143_A");
        const pdf = new TextEncoder().encode("%PDF-1.4\n% NATIVE_PDF\n");
        send(callbacks, "j", "photo.jpg", "image/jpeg", JPEG);
        send(callbacks, "t", "notes.txt", "text/plain", new TextEncoder().encode("NATIVE_TEXT_CODE"));
        send(callbacks, "d", "report.docx", DOCX, ooxml("docx", "NATIVE_DOCX_CODE"));
        send(callbacks, "p", "paper.pdf", "application/pdf", pdf);
        callbacks.onInstruction?.("NATIVE_1143_A", ["j", "t", "d", "p"]);
        const body = await held.body;
        const [dir] = attachmentDirs("a");
        expect(statSync(dir!).mode & 0o777).toBe(0o700);
        const [file] = readdirSync(dir!);
        expect(statSync(join(dir!, file!)).mode & 0o777).toBe(0o600);
        expect(body).toContain("input_image");
        expect(body).toContain(JPEG.toString("base64"));
        expect(body).toContain("NATIVE_TEXT_CODE");
        expect(body).toContain("NATIVE_DOCX_CODE");
        expect(body).toContain(join(dir!, file!));
        held.release();
        await vi.waitFor(() => expect(results(envelopes)).toHaveLength(1), { timeout: 60_000 });
        expect(attachmentDirs("a")).toEqual([]);
        if (process.env.KAOIRO_LIVE_GROK_1143_REPORT) {
          const at = body.indexOf(join(dir!, file!));
          process.stderr.write(`[1143] pdf reference: ${JSON.stringify(body.slice(Math.max(0, at - 160), at + 200))}\n`);
        }
      }, stub.env);
    });
  }, 180_000);

  it("(b) ends a held turn on interrupt, removes the PDF and runs the next turn", async () => {
    await withStub(async (stub, cwd) => {
      await nativeRun(config("b"), cwd, async (host, callbacks, envelopes) => {
        await ready(host);
        const held = stub.hold("NATIVE_1143_B");
        send(callbacks, "p", "paper.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.4\n"));
        callbacks.onInstruction?.("NATIVE_1143_B", ["p"]);
        await held.body;
        expect(attachmentDirs("b")).toHaveLength(1);
        callbacks.onInterrupt?.();
        await vi.waitFor(() => expect(results(envelopes)).toHaveLength(1), { timeout: 60_000 });
        expect(results(envelopes)[0]!.ext).toMatchObject({ interrupted: true });
        expect(attachmentDirs("b")).toEqual([]);
        expect(envelopes.filter((e) => e.type === "attach_rejected" || e.type === "instruction_rejected"))
          .toEqual([]);
        held.release();
        callbacks.onInstruction?.("NATIVE_1143_B_AFTER");
        await vi.waitFor(() => expect(results(envelopes)).toHaveLength(2), { timeout: 60_000 });
        expect(stub.bodies.some((body) => body.includes("NATIVE_1143_B_AFTER"))).toBe(true);
      }, stub.env);
    });
  }, 180_000);

  it("(c) logs Grok's image_dropped for a 7×7 PNG", async () => {
    await withStub(async (stub, cwd) => {
      await nativeRun(config("c"), cwd, async (host, callbacks, envelopes) => {
        await ready(host);
        send(callbacks, "s", "small.png", "image/png", png(7, 7));
        callbacks.onInstruction?.("NATIVE_1143_C", ["s"]);
        await vi.waitFor(() => expect(results(envelopes)).toHaveLength(1), { timeout: 60_000 });
        expect(envelopes.filter((e) => e.type === "log" && e.payload.kind === "system" &&
          String(e.payload.text).startsWith("Grok: ")).map((e) => e.payload.text)).toEqual([
          "Grok: Image 1 was dropped before send: too small (7×7); images must be at least 8×8 pixels.",
        ]);
      }, stub.env);
    });
  }, 180_000);

  it("(d) keeps the connection at the size limit and refuses one byte more", async () => {
    // JSON.stringify([{type:"text",text}]) is 27 bytes plus the escaped text.
    const textAt = (size: number) => {
      const head = "NATIVE_1143_D あ\n\"";
      const used = Buffer.byteLength(JSON.stringify([{ type: "text", text: head }]));
      return head + "x".repeat(size - used);
    };
    await withStub(async (stub, cwd) => {
      await nativeRun(config("d"), cwd, async (host, _callbacks, envelopes, metadata) => {
        await ready(host);
        const pid = host.processId;
        await host.send(textAt(PROMPT_BYTE_LIMIT)).catch(() => {});
        expect(results(envelopes)).toHaveLength(1);
        // Grok sent the prompt's text back (_x.ai/queue/changed) as a line
        // over the tee's 4 MiB, and the connection took it.
        expect(metadata.filter((m) => m.direction === "in" && m.oversized_lines).length)
          .toBeGreaterThan(0);
        // The connection stayed open: the same Grok takes the next turn to its
        // result. Grok may end it without a model request, because the
        // session's history now holds the large prompt.
        await host.send("NATIVE_1143_D_NEXT").catch(() => {});
        expect(results(envelopes)).toHaveLength(2);
        expect(host.processId).toBe(pid);
        expect(host.state).not.toBe("error");
        await expect(host.send(textAt(PROMPT_BYTE_LIMIT + 1))).rejects.toThrow("size limit");
        expect(envelopes.filter((e) => e.type === "instruction_rejected").map((e) => e.payload.reason))
          .toEqual(["total_request_over"]);
        expect(host.processId).toBe(pid);
        await host.send("NATIVE_1143_D_LAST").catch(() => {});
        expect(results(envelopes)).toHaveLength(3);
      }, stub.env);
    });
  }, 240_000);

  it("(e) sweeps its own leftover at start and leaves another agent's directory", async () => {
    await withStub(async (stub, cwd) => {
      await nativeRun(config("e-b"), cwd, async (hostB, callbacksB, envelopesB) => {
        await ready(hostB);
        const held = stub.hold("NATIVE_1143_E_B");
        send(callbacksB, "p", "b.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.4\n"));
        callbacksB.onInstruction?.("NATIVE_1143_E_B", ["p"]);
        await held.body;
        const [dirB] = attachmentDirs("e-b");
        const planted = join(tmpdir(), `${attachmentDirPrefix(config("e-a").agent_id)}planted`);
        mkdirSync(planted);
        try {
          const cwdA = makeGrokScratch("attachments");
          try {
            await nativeRun(config("e-a"), cwdA, async (hostA, callbacksA, envelopesA) => {
              await ready(hostA);
              expect(existsSync(planted)).toBe(false);
              expect(existsSync(dirB!)).toBe(true);
              send(callbacksA, "p", "a.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.4\n"));
              callbacksA.onInstruction?.("NATIVE_1143_E_A", ["p"]);
              await vi.waitFor(() => expect(results(envelopesA)).toHaveLength(1), { timeout: 60_000 });
              expect(attachmentDirs("e-a")).toEqual([]);
              expect(existsSync(dirB!)).toBe(true);
            }, stub.env);
          } finally {
            removeGrokState(cwdA);
          }
        } finally {
          rmSync(planted, { recursive: true, force: true });
        }
        held.release();
        await vi.waitFor(() => expect(results(envelopesB)).toHaveLength(1), { timeout: 60_000 });
        expect(attachmentDirs("e-b")).toEqual([]);
      }, stub.env);
    });
  }, 300_000);
});
