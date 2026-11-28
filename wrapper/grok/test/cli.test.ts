import "../../../scripts/test/fixtures/test-isolation.mjs";
import {PermissionSyncTimeoutError} from "@kaoiro/wrapper-core";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import { InterAgentTool, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";
import * as events from "../src/grok/events.js";
import { chunkPayload, DOCX, ooxml, PPTX, XLSX } from "./upload-support.js";
const config: WrapperConfig = {
  agent_id: "test.grok",
  server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  display_name: "Default",
};
const buildInfo = {
  revision: "unknown",
  dirty: false,
  built_at: "unknown",
  version: "unknown",
  channel: "dev" as const,
};
export function recordingLink(
  options: ServerLinkOptions,
  envelopes: Envelope[],
  acknowledgements: number[],
  outbound: Envelope[],
) {
  queueMicrotask(() => {
    options.onPersonaPrompt?.("COMPOSED_PERSONA_AND_FOOTER");
    options.onNoticeAttributionMode?.("legacy");
    options.onInterAgentDeliveryStatus?.({ issued_seq: 1, acked_seq: 0 });
  });
  return {
    send: (e: Envelope) => envelopes.push(e),
    setSessionId: () => {},
    deliveryIncarnation: () => "fixture-incarnation",
    deliveryGeneration: () => "fixture-generation",
    acknowledgeInterAgentDelivery: (seq: number) => acknowledgements.push(seq),
    noticeAttributionMode: () => "legacy",
    reportDisconnectIntent: async () => {},
    close: () => {},
    requestDirectory: async () => ({ agents: [], users: [] }),
    requestInterAgentDeliveryStatus: async () => ({
      issued_seq: 1,
      acked_seq: 1,
      lost_count: 0,
    }),
    sendInterAgent: async (e: Envelope) => {
      outbound.push(e);
      return { kind: "accepted", stamp: null };
    },
    setStatusLine: async () => ({ kind: "ok" }),
    readStatusLine: async () => ({ kind: "error", reason: "not_found" }),
  } as unknown as ServerLink;
}
describe("runGrokCli composition", () => {
  it("logs an operator instruction received before readiness only at turn start", async () => {
    const envelopes: Envelope[] = [];
    let probe!: Promise<void>;
    let beforeReadyLogs: number | undefined;
    const work = runGrokCli({
      parseCliArgs: () => ({ configPath: "fixture" }),
      loadConfig: () => ({ ...config }),
      loadWrapperBuildInfo: () => buildInfo,
      createHost: options => new GrokHost({ ...options,
        executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)),
      }),
      createServerLink: (_url, _id, callbacks) => {
        const link = recordingLink(callbacks, envelopes, [], []);
        queueMicrotask(() => {
          callbacks.onInstruction?.("BEFORE_READY");
          beforeReadyLogs = envelopes.filter(e => e.type === "log").length;
        });
        return link;
      },
      onHostCreated: host => {
        probe = (async () => {
          expect(beforeReadyLogs).toBe(0);
          await vi.waitFor(() => expect(envelopes.filter(e => e.type === "result"))
            .toHaveLength(1), { timeout: 5000 });
          expect(envelopes.filter(e => e.type === "log").map(e => e.payload)).toEqual([
            { kind: "user", text: "BEFORE_READY" },
            { kind: "assistant", text: "BEFORE_READY" },
          ]);
          expect(envelopes.find(e => e.type === "log" && e.payload.kind === "user")?.state)
            .toBe("sending");
        })().finally(() => host.close());
        void probe.catch(() => {});
      },
    });
    await work;
    await probe;
  });
  it("resumes the session named by --resume with the relayed snapshot", async () => {
    let seen: { resumeSessionId?: string; resumeSnapshot?: unknown } | undefined;
    const snapshot = { model: "grok-4.6", model_source: "launch" as const };
    let probe!: Promise<void>;
    await runGrokCli({
      parseCliArgs: () => ({ configPath: "fixture" }),
      loadConfig: () => ({ resume_session_id: "fixture-session", ...config, resume_snapshot: snapshot }),
      loadWrapperBuildInfo: () => buildInfo,
      createHost: (options) => {
        seen = options;
        return new GrokHost({ ...options,
          executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)) });
      },
      createServerLink: (_url, _id, callbacks) => recordingLink(callbacks, [], [], []),
      onHostCreated: (host) => {
        probe = vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5000 })
          .finally(() => host.close());
        void probe.catch(() => {});
      },
    });
    await probe;
    expect(seen).toMatchObject({ resumeSessionId: "fixture-session", resumeSnapshot: snapshot });
  });
  it("keeps a queued operator bubble after the running turn's assistant log", async () => {
    const envelopes: Envelope[] = [];
    const received = vi.spyOn(events, "updateEvents");
    let callbacks!: ServerLinkOptions;
    let probe!: Promise<void>;
    try {
      const work = runGrokCli({
        parseCliArgs: () => ({ configPath: "fixture" }),
        loadConfig: () => ({ ...config }),
        loadWrapperBuildInfo: () => buildInfo,
        createHost: options => new GrokHost({ ...options,
          executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)),
        }),
        createServerLink: (_url, _id, options) => {
          callbacks = options;
          return recordingLink(options, envelopes, [], []);
        },
        onHostCreated: host => {
          probe = (async () => {
            await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5000 });
            callbacks.onInstruction?.("hold-chunks");
            await vi.waitFor(() => expect(received.mock.calls.filter(([notification]) =>
              notification.update.sessionUpdate === "agent_message_chunk")).toHaveLength(3));
            callbacks.onInstruction?.("NEXT_OPERATOR");
            expect(envelopes.filter(e => e.type === "log" && e.payload.kind === "user")
              .map(e => e.payload.text)).toEqual(["hold-chunks"]);
            await host.interrupt();
            await vi.waitFor(() => expect(envelopes.filter(e => e.type === "result"))
              .toHaveLength(2), { timeout: 5000 });
            expect(envelopes.filter(e => e.type === "log").map(e => e.payload)).toEqual([
              { kind: "user", text: "hold-chunks" },
              { kind: "assistant", text: "Hello world" },
              { kind: "user", text: "NEXT_OPERATOR" },
              { kind: "assistant", text: "NEXT_OPERATOR" },
            ]);
          })().finally(() => host.close());
          void probe.catch(() => {});
        },
      });
      await work;
      await probe;
    } finally { received.mockRestore(); }
  });
  it("reports settings and classifies instruction failures", async () => {
    const envelopes: Envelope[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk)); return true;
    });
    let callbacks!: ServerLinkOptions;
    let probe!: Promise<void>;
    try {
      await runGrokCli({
        parseCliArgs: () => ({ configPath: "fixture" }),
        loadConfig: () => ({ ...config,
          turn_watchdog_inactivity_ms: 120_000,
          turn_watchdog_abort_grace_ms: 1_000,
        }),
        loadWrapperBuildInfo: () => buildInfo,
        createHost: (values) => new GrokHost({ ...values,
          executable: fileURLToPath(
            new URL("./fixtures/grok.mjs", import.meta.url),
          ),
        }),
        createServerLink: (_url, _id, options) => {
          callbacks = options;
          return recordingLink(options, envelopes, [], []);
        },
        onHostCreated: (host) => {
          probe = (async () => {
            await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
              timeout: 5_000,
            });
            callbacks.onInstruction?.("fail-turn");
            await vi.waitFor(() => expect(envelopes.some((e) =>
              e.type === "log" && e.payload.text === "grok turn failed",
            )).toBe(true));
            expect(JSON.stringify(envelopes)).not.toContain("unsupported");
            expect(JSON.stringify(envelopes))
              .not.toContain("TURN_FAILURE_BODY_MARKER");
            callbacks.onInstruction?.("attachment", ["attachment-id"]);
            expect(envelopes.filter((e) => e.type === "instruction_rejected").map((e) => e.payload))
              .toEqual([{ attachment_ids: ["attachment-id"], reason: "timeout",
                detail: "unknown upload_id attachment-id" }]);
            expect(envelopes.filter(e => e.type === "log" && e.payload.kind === "user")
              .map(e => e.payload.text)).toEqual(["fail-turn"]);
            const output = stderr.join("");
            expect(output).toContain(
              `[kaoiro] grok behaviour: pid=${process.pid} `,
            );
            expect(output).toContain("120000(config)");
            expect(output).toContain("1000(config)");
            expect(output).toContain("below the 30-minute default");
            host.close();
          })();
          void probe.catch(() => host.close());
        },
      });
      await probe;
    } finally { vi.restoreAllMocks(); }
  });

  it("injects, replies and acknowledges a normal peer turn", async () => {
    const envelopes: Envelope[] = [];
    const ack: number[] = [];
    const outbound: Envelope[] = [];
    let options!: ServerLinkOptions;
    let probe!: Promise<void>;
    const work = runGrokCli({
      parseCliArgs: () => ({ configPath: "fixture" }),
      loadConfig: () => ({ ...config }),
      loadWrapperBuildInfo: () => buildInfo,
      createHost: (values) =>
        new GrokHost({
          ...values,
          executable: fileURLToPath(
            new URL("./fixtures/grok.mjs", import.meta.url),
          ),
        }),
      createServerLink: (_url, _id, o) => {
        options = o;
        return recordingLink(o, envelopes, ack, outbound);
      },
      onHostCreated: (host) => {
        probe = (async () => {
          try {
            await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
              timeout: 5000,
            });
            options.onInterAgentMessage?.({
              ...config,
              version: "0",
              agent_id: "peer",
              ts: new Date().toISOString(),
              type: "inter_agent_message",
              state: "idle",
              delivery_seq: 1,
              payload: {
                conversation_id: "fixture-conversation",
                turn_number: 1,
                kind: "request",
                body: "Reply through send_to_agent",
                meta: { done: false, propose_next: "" },
              },
              ext: {},
            } as Envelope);
            await vi.waitFor(() => expect(outbound).toHaveLength(1), {
              timeout: 5000,
            });
            await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
              timeout: 5000,
            });
            expect(ack).toEqual([1]);
            expect(envelopes.filter(e => e.type === "log" && e.payload.kind === "user"))
              .toHaveLength(0);
            expect(outbound[0]?.payload).toMatchObject({
              to: "peer",
              conversation_id: "fixture-conversation",
              kind: "response",
            });
            expect(options.interAgentReplyBasis).toBeUndefined();
            expect(options.interAgentDeliveryModes).toMatchObject({
              early: "none",
              yield: "none",
            });
          } finally {
            host.close();
          }
        })();
        void probe.catch(() => host.close());
      },
    });
    await work;
    await probe;
  }, 15_000);
  it("notifies the sender when an injected peer turn fails", async () => {
    const envelopes: Envelope[] = [];
    const ack: number[] = [];
    let callbacks!: ServerLinkOptions;
    let probe!: Promise<void>;
    const work = runGrokCli({
      parseCliArgs: () => ({ configPath: "fixture" }),
      loadConfig: () => ({ ...config }),
      loadWrapperBuildInfo: () => buildInfo,
      createHost: (values) =>
        new GrokHost({
          ...values,
          executable: fileURLToPath(
            new URL("./fixtures/grok.mjs", import.meta.url),
          ),
          env: { ...process.env, KAOIRO_TEST_GROK_FAIL_PEER: "1" },
        }),
      createServerLink: (_url, _id, options) => {
        callbacks = options;
        return recordingLink(options, envelopes, ack, []);
      },
      onHostCreated: (host) => {
        probe = (async () => {
          await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
            timeout: 5_000,
          });
          callbacks.onInterAgentMessage?.({
            ...config,
            version: "0",
            agent_id: "peer",
            ts: new Date().toISOString(),
            type: "inter_agent_message",
            state: "idle",
            delivery_seq: 1,
            payload: {
              conversation_id: "failed-peer",
              turn_number: 1,
              kind: "request",
              body: "Reply",
              meta: { done: false, propose_next: "" },
            },
            ext: {},
          } as Envelope);
          await vi.waitFor(() =>
            expect(
              envelopes.some(
                (e) =>
                  e.type === "inter_agent_message" &&
                  e.payload.conversation_id === "failed-peer" &&
                  e.payload.to === "peer" &&
                  e.payload.error !== undefined,
              ),
            ).toBe(true),
          );
          expect(ack).toEqual([1]);
        })();
        void probe.catch(() => host.close());
      },
    });
    await expect(work).rejects.toThrow(
      /(?:exited|connection closed) unexpectedly/,
    );
    await probe;
  });
  it("keeps all diagnostic outputs content-free through the CLI", async () => {
    const diagnostics: unknown[] = [];
    const envelopes: Envelope[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        diagnostics.push(String(chunk));
        return true;
      });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => {
        diagnostics.push(args);
      });
    let probe!: Promise<void>;
    try {
      const work = runGrokCli({
        parseCliArgs: () => ({ configPath: "fixture" }),
        loadConfig: () => ({ ...config }),
        loadWrapperBuildInfo: () => buildInfo,
        onMetadata: (metadata) => diagnostics.push(metadata),
        additionalTools: [
          {
            name: "probe",
            description: "Probe",
            inputSchema: { type: "object" },
            handler: async () => ({
              content: [{ type: "text", text: "NORMAL_TOOL_MARKER" }],
            }),
          },
        ],
        createHost: (values) =>
          new GrokHost({
            ...values,
            executable: fileURLToPath(
              new URL("./fixtures/grok.mjs", import.meta.url),
            ),
          }),
        createServerLink: (_url, _id, options) =>
          recordingLink(options, envelopes, [], []),
        onHostCreated: (host) => {
          probe = (async () => {
            await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
              timeout: 5_000,
            });
            await host.send("unknown");
            await host.send("NORMAL_PROMPT_MARKER");
            await host.send("tool");
            const diagnostic = JSON.stringify(diagnostics);
            for (const marker of [
              "UNKNOWN_BODY_MARKER",
              "NORMAL_PROMPT_MARKER",
              "NORMAL_TOOL_MARKER",
            ])
              expect(diagnostic).not.toContain(marker);
            expect(JSON.stringify(envelopes)).not.toContain(
              "UNKNOWN_BODY_MARKER",
            );
            // Display logs and results intentionally carry normal content.
            expect(JSON.stringify(envelopes)).toContain("NORMAL_PROMPT_MARKER");
            expect(JSON.stringify(envelopes)).toContain("NORMAL_TOOL_MARKER");
            expect(diagnostic).toContain("future_variant");
            expect(diagnostic).toContain("sdk_diagnostic");
            expect(consoleError).not.toHaveBeenCalled();
          })().finally(() => host.close());
          void probe.catch(() => host.close());
        },
      });
      await work;
      await probe;
    } finally {
      stderr.mockRestore();
      consoleError.mockRestore();
    }
  });
});

it("retires a real Grok CLI sync failure once without the generic duplicate failure log",async()=>{
  const envelopes:Envelope[]=[],acks:number[]=[],outbound:Envelope[]=[],retired:Envelope[]=[];let callbacks!:ServerLinkOptions,blocked=true,probe!:Promise<void>;
  const work=runGrokCli({parseCliArgs:()=>({configPath:"fixture"}),loadConfig:()=>({...config,sandbox:"danger-full-access",network_access:true}),loadWrapperBuildInfo:()=>buildInfo,
    createServerLink:(_u,_id,opts)=>{callbacks=opts;const link=recordingLink(opts,envelopes,acks,outbound);return {...link,retireInterAgentDeliveries:(items:Envelope[])=>{retired.push(...items);callbacks.onInterAgentDeliveryStatus?.({issued_seq:1,acked_seq:1});return true;}} as ServerLink;},
    createHost:opts=>new GrokHost({...opts,executable:fileURLToPath(new URL("./fixtures/grok.mjs",import.meta.url)),waitForPermissionSync:()=>blocked?Promise.reject(new PermissionSyncTimeoutError()):Promise.resolve()}),
    onHostCreated:host=>{probe=(async()=>{
      await vi.waitFor(()=>expect(host.state).toBe("waiting_input"),{timeout:5000});
      callbacks.onInterAgentMessage?.({version:"0",agent_id:"peer",persona:config.persona,ts:"2026-11-06T00:00:00Z",type:"inter_agent_message",state:"thinking",delivery_seq:1,payload:{to:config.agent_id,conversation_id:"sync-timeout",turn_number:1,kind:"request",body:"input",meta:{done:false,propose_next:""},owner:{kind:"user",id:"operator"}}} as unknown as Envelope);
      await vi.waitFor(()=>expect(retired).toHaveLength(1));expect(acks).toEqual([]);expect(outbound).toEqual([]);
      expect(envelopes.filter(e=>e.type==="log"&&e.payload.text==="grok turn failed")).toEqual([]);
      callbacks.onInstruction?.("operator input");
      await vi.waitFor(()=>expect(envelopes.filter(e=>e.type==="result"&&e.payload.is_error)).toHaveLength(2));
      await new Promise<void>(resolve=>setImmediate(resolve));
      expect(envelopes.filter(e=>e.type==="log"&&e.payload.text==="grok turn failed")).toEqual([]);
      expect(retired).toHaveLength(1);
      blocked=false;await host.send("recovered");
    })().finally(()=>host.close());void probe.catch(()=>{});}});
  await work;await probe;
});

describe("runGrokCli shutdown releases reply waiters (issue #1130)", () => {
  it("closes this invocation's InterAgentTool when the CLI stops", async () => {
    const close = vi.spyOn(InterAgentTool.prototype, "close");
    let probe!: Promise<void>;
    try {
      await runGrokCli({
        parseCliArgs: () => ({ configPath: "fixture" }),
        loadConfig: () => ({ ...config }),
        loadWrapperBuildInfo: () => buildInfo,
        createHost: options => new GrokHost({ ...options,
          executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)) }),
        createServerLink: (_url, _id, callbacks) => recordingLink(callbacks, [], [], []),
        onHostCreated: host => {
          probe = vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5000 })
            .finally(() => host.close());
          void probe.catch(() => {});
        },
      });
      await probe;
      expect(close).toHaveBeenCalledTimes(1);
      expect(close.mock.contexts[0]).toBeInstanceOf(InterAgentTool);
    } finally {
      close.mockRestore();
    }
  });
});

describe("runGrokCli attachments", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const open = (callbacks: ServerLinkOptions, id: string) => {
    callbacks.onAttachOpen?.({ upload_id: id, filename: `${id}.png`, mime: "image/png", size: 4, chunks: 1 });
    callbacks.onAttachChunk?.(chunkPayload(id, 0, png));
    callbacks.onAttachClose?.(id);
  };
  const rejected = (envelopes: Envelope[]) => envelopes
    .filter((e) => e.type === "attach_rejected" || e.type === "instruction_rejected")
    .map((e) => ({ type: e.type, ...e.payload }));
  it("T5: drops an instruction that arrived during a turn at the interrupt", async () => {
    const envelopes: Envelope[] = [];
    let callbacks!: ServerLinkOptions;
    let probe!: Promise<void>;
    await runGrokCli({
      parseCliArgs: () => ({ configPath: "fixture" }),
      loadConfig: () => ({ ...config }),
      loadWrapperBuildInfo: () => buildInfo,
      createHost: options => new GrokHost({ ...options,
        executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)) }),
      createServerLink: (_url, _id, options) => {
        callbacks = options;
        return recordingLink(options, envelopes, [], []);
      },
      onHostCreated: host => {
        probe = (async () => {
          await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5000 });
          callbacks.onInstruction?.("hold-chunks");
          await vi.waitFor(() => expect(envelopes.some(e => e.type === "log" &&
            e.payload.kind === "user")).toBe(true), { timeout: 5000 });
          open(callbacks, "u1");
          open(callbacks, "u2");
          callbacks.onInstruction?.("SECOND_WITH_ATTACHMENTS", ["u1", "u2"]);
          callbacks.onInterrupt?.();
          expect(rejected(envelopes)).toEqual([
            { type: "attach_rejected", upload_id: "u1", reason: "interrupted" },
            { type: "attach_rejected", upload_id: "u2", reason: "interrupted" },
            { type: "instruction_rejected", attachment_ids: ["u1", "u2"], reason: "interrupted" },
          ]);
          // A later instruction runs only after the chain has passed the second.
          callbacks.onInstruction?.("AFTER");
          await vi.waitFor(() => expect(envelopes.filter(e => e.type === "result")).toHaveLength(2),
            { timeout: 5000 });
          expect(rejected(envelopes)).toHaveLength(3);
          expect(envelopes.filter(e => e.type === "log" && e.payload.kind === "user")
            .map(e => e.payload.text)).toEqual(["hold-chunks", "AFTER"]);
        })().finally(() => host.close());
        void probe.catch(() => {});
      },
    });
    await probe;
  });
  it("preserves Grok MIME and text-fit policy through the CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-attachments-"));
    const eventsPath = join(root, "events.jsonl");
    const envelopes: Envelope[] = [];
    let callbacks!: ServerLinkOptions;
    let probe!: Promise<void>;

    function uploadFile(
      id: string,
      mime: string,
      bytes: Uint8Array,
    ) {
      const chunkSize = 64 * 1024;
      const chunks = Math.ceil(bytes.byteLength / chunkSize);
      callbacks.onAttachOpen?.({
        upload_id: id, filename: id, mime, size: bytes.byteLength, chunks,
      });
      for (let index = 0; index < chunks; index += 1) {
        const start = index * chunkSize;
        callbacks.onAttachChunk?.(chunkPayload(id, index,
          bytes.subarray(start, start + chunkSize)));
      }
      callbacks.onAttachClose?.(id);
    }

    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const pdf = Buffer.from("%PDF-1.4 fixture");
    const exact = "Y".repeat(1024 * 1024);
    const sha = (value: string | Uint8Array) =>
      createHash("sha256").update(value).digest("hex");
    try {
      await runGrokCli({
        cwd: root,
        parseCliArgs: () => ({ configPath: "fixture" }),
        loadConfig: () => ({ ...config }),
        loadWrapperBuildInfo: () => buildInfo,
        createHost: options => new GrokHost({ ...options,
          executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)),
          env: { ...process.env, KAOIRO_TEST_GROK_EVENTS: eventsPath },
        }),
        createServerLink: (_url, _id, options) => {
          callbacks = options;
          return recordingLink(options, envelopes, [], []);
        },
        onHostCreated: host => {
          probe = (async () => {
            await vi.waitFor(() => expect(host.state).toBe("waiting_input"),
              { timeout: 5000 });
            uploadFile("picture.jpg", "image/jpeg", jpeg);
            uploadFile("paper.pdf", "application/pdf", pdf);
            uploadFile("doc.docx", DOCX, ooxml("docx", "DOC_MARK"));
            uploadFile("book.xlsx", XLSX, ooxml("xlsx", "BOOK_MARK"));
            uploadFile("slide.pptx", PPTX, ooxml("pptx", "SLIDE_MARK"));
            uploadFile("exact.txt", "text/plain", Buffer.from(exact));
            uploadFile("over.txt", "text/plain", Buffer.from(exact + "Z"));
            callbacks.onInstruction?.("attachment policy", [
              "picture.jpg", "paper.pdf", "doc.docx", "book.xlsx",
              "slide.pptx", "exact.txt", "over.txt",
            ]);
            await vi.waitFor(() => expect(envelopes.some(e =>
              e.type === "result" || e.type === "instruction_rejected",
            )).toBe(true), { timeout: 5000 });
            expect(rejected(envelopes)).toEqual([]);
            const prompts = readFileSync(eventsPath, "utf8").trim().split("\n")
              .map(line => JSON.parse(line))
              .filter(event => event.event === "prompt_blocks");
            expect(prompts).toHaveLength(1);
            const [, image, link, doc, book, slide, atLimit, overLimit] =
              prompts[0].blocks;
            expect(image).toMatchObject({
              type: "image", mimeType: "image/jpeg",
              dataSha: sha(Buffer.from(jpeg).toString("base64")),
            });
            expect(link).toMatchObject({
              type: "resource_link", mimeType: "application/pdf",
              fileSha: sha(pdf),
            });
            for (const [block, mark] of [
              [doc, "DOC_MARK"], [book, "BOOK_MARK"], [slide, "SLIDE_MARK"],
            ]) {
              expect(block).toMatchObject({
                type: "resource", mimeType: "text/plain",
                text: expect.stringContaining(mark),
              });
            }
            expect(atLimit.text.length).toBe(1048576);
            expect(sha(atLimit.text)).toBe(sha(exact));
            expect(sha(overLimit.text)).toBe(sha(
              exact + "\n\n[...truncated, original 1048577 bytes]\n",
            ));
          })().finally(() => host.close());
          void probe.catch(() => {});
        },
      });
      await probe;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("drops pending uploads when the start fails before the host exists (R3-S3)", async () => {
    const envelopes: Envelope[] = [];
    await expect(runGrokCli({
      parseCliArgs: () => ({ configPath: "fixture" }),
      loadConfig: () => ({ ...config }),
      loadWrapperBuildInfo: () => buildInfo,
      createHost: () => { throw new Error("START_FAILURE"); },
      createServerLink: (_url, _id, options) => {
        const link = recordingLink(options, envelopes, [], []);
        open(options, "u1");
        return link;
      },
    })).rejects.toThrow("START_FAILURE");
    expect(rejected(envelopes)).toEqual([
      { type: "attach_rejected", upload_id: "u1", reason: "interrupted" },
    ]);
  });
});
