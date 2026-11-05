import {PermissionSyncTimeoutError} from "@kaoiro/wrapper-core";
import "../../../scripts/test/fixtures/test-isolation.mjs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";
import * as events from "../src/grok/events.js";
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
      parseCliArgs: () => ({ configPath: "fixture", resume: "fixture-session" }),
      loadConfig: () => ({ ...config, resume_snapshot: snapshot }),
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
            await vi.waitFor(() => expect(envelopes.some((e) =>
              e.type === "log" && e.payload.text ===
                "grok attachment input is unsupported in work unit 1",
            )).toBe(true));
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
      blocked=false;await host.send("recovered");
    })().finally(()=>host.close());void probe.catch(()=>{});}});
  await work;await probe;
});
