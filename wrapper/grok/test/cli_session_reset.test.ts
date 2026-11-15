import "../../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import {
  REQUEST_SESSION_RESET_TOOL_FQN,
  type Envelope,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import { runGrokCli, type GrokCliDependencies } from "../src/cli.js";
import { GrokHost } from "../src/host.js";

// Issue #658: request_session_reset on Grok, through the real CLI and host
// against the fixture agent, which calls the tool over the ToolHost.

const baseConfig: WrapperConfig = {
  agent_id: "reset.grok",
  display_name: "Reset fixture",
  server_url: "ws://127.0.0.1:1/agent",
  sandbox: "workspace-write",
  network_access: true,
  persona: { id: "default", name: "Default", sprite_set: "default" },
};
const buildInfo = {
  revision: "unknown", dirty: false, built_at: "unknown", version: "unknown", channel: "dev" as const,
};
const executable = fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url));

type ResetCall = { kind: "reset"; mode: string; reason?: string };
type Entry = { kind: "envelope"; envelope: Envelope } | ResetCall;
interface Context {
  host: GrokHost;
  options: ServerLinkOptions;
  log: Entry[];
  envelopes: () => Envelope[];
  results: () => string[];
  resets: () => ResetCall[];
  permissionRequests: () => Envelope[];
  events: () => Record<string, unknown>[];
}
interface Setup {
  answer?: "allow" | "deny" | "none";
  config?: Partial<WrapperConfig>;
  replies?: ({ requestId: string } | Error)[];
  dependencies?: Pick<GrokCliDependencies, "resetApprovalTimeoutMs">;
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
const reservedNotice = "[kaoiro] The session reset you reserved (mode: new) was cancelled: ";
const refusedNotice = "[kaoiro] The session reset you requested (mode: new) was not carried out. ";

async function withCli(setup: Setup, exercise: (context: Context) => Promise<void>) {
  const cwd = mkdtempSync(join(tmpdir(), "kaoiro-sakura658-reset-"));
  const eventsFile = join(cwd, "events.jsonl");
  const log: Entry[] = [];
  const replies = [...(setup.replies ?? [{ requestId: "reset-1" }])];
  let linkOptions!: ServerLinkOptions;
  let probe!: Promise<void>;
  const envelopes = () => log.flatMap((entry) => entry.kind === "envelope" ? [entry.envelope] : []);
  try {
    await runGrokCli({
      parseCliArgs: () => ({ configPath: "fixture" }),
      loadConfig: () => ({ ...baseConfig, ...setup.config }),
      loadWrapperBuildInfo: () => buildInfo,
      ...setup.dependencies,
      createHost: (options) => new GrokHost({ ...options, executable,
        env: { ...(options.env ?? process.env), KAOIRO_TEST_GROK_EVENTS: eventsFile } }),
      createServerLink: (_url, _id, options) => {
        linkOptions = options;
        queueMicrotask(() => options.onPersonaPrompt?.("fixture rules"));
        const answer = setup.answer ?? "allow";
        return {
          send: (envelope: Envelope) => {
            log.push({ kind: "envelope", envelope });
            if (envelope.type !== "permission_request" || answer === "none") return;
            queueMicrotask(() => options.onPermissionDecision?.({
              request_id: String(envelope.payload.request_id), allow: answer === "allow",
            }));
          },
          requestSessionReset: (mode: string, reason?: string) => {
            log.push({ kind: "reset", mode, ...(reason !== undefined ? { reason } : {}) });
            const next = replies.shift() ?? new Error("unknown_error");
            return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
          },
          setSessionId: () => {},
          currentSessionId: () => null,
          requestDirectory: async () => ({ agents: [], users: [] }),
          requestInterAgentDeliveryStatus: async () => ({ issued_seq: 0, acked_seq: 0, lost_count: 0 }),
          noticeAttributionMode: () => "legacy",
          deliveryIncarnation: () => "fixture-incarnation",
          deliveryGeneration: () => "fixture-generation",
          reportDisconnectIntent: async () => {},
          acknowledgeInterAgentDelivery: () => {},
          sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
          setStatusLine: async () => ({ kind: "ok" }),
          readStatusLine: async () => ({ kind: "error", reason: "not_found" }),
          close: () => {},
        } as unknown as ServerLink;
      },
      cwd,
      onHostCreated: (host) => {
        probe = (async () => {
          await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5_000 });
          await exercise({
            host,
            options: linkOptions,
            log,
            envelopes,
            results: () => envelopes().filter((e) => e.type === "result")
              .map((e) => String(e.payload.text ?? "")),
            resets: () => log.filter((entry): entry is ResetCall => entry.kind === "reset"),
            permissionRequests: () => envelopes().filter((e) => e.type === "permission_request"),
            events: () => existsSync(eventsFile)
              ? readFileSync(eventsFile, "utf8").trim().split("\n")
                .map((line) => JSON.parse(line) as Record<string, unknown>)
              : [],
          });
        })().finally(() => host.close());
        void probe.catch(() => {});
      },
    });
    await probe;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("grok request_session_reset (issue #658)", () => {
  it("advertises session reset with both modes from the first state_change", async () => {
    await withCli({}, async ({ host, envelopes }) => {
      const advertised = { supports_session_reset: true, session_reset_modes: ["new", "clear"] };
      expect(host.statusExtSnapshot().session_capabilities).toMatchObject(advertised);
      const first = envelopes().find((e) => e.type === "state_change");
      expect(first?.ext?.session_capabilities).toMatchObject(advertised);
    });
  });

  it("sends an approved reservation after the turn's ready state_change", async () => {
    await withCli({}, async ({ host, log, resets, permissionRequests, results }) => {
      await host.send("reset:new:end");
      await vi.waitFor(() => expect(resets()).toHaveLength(1));
      expect(resets()[0]).toEqual({ kind: "reset", mode: "new", reason: "fixture reset" });
      expect(permissionRequests()).toHaveLength(1);
      expect(permissionRequests()[0]!.payload.tool_name).toBe(REQUEST_SESSION_RESET_TOOL_FQN);
      expect(results().at(-1)).not.toContain('"isError":true');
      const at = log.findIndex((entry) => entry.kind === "reset");
      const before = log.slice(0, at).flatMap((entry) => entry.kind === "envelope" ? [entry.envelope] : []);
      expect(before.filter((e) => e.type === "state_change").at(-1)?.state).toBe("waiting_input");
      expect(before.some((e) => e.type === "result")).toBe(true);
      await settle();
      expect(results().some((text) => text.startsWith("[kaoiro]"))).toBe(false);
    });
  });

  it("reserves nothing when the operator denies", async () => {
    await withCli({ answer: "deny" }, async ({ host, resets, results }) => {
      await host.send("reset:new:end");
      expect(results().at(-1)).toContain("was not approved by the operator");
      await settle();
      expect(resets()).toEqual([]);
      expect(results().some((text) => text.startsWith("[kaoiro]"))).toBe(false);
    });
  });

  it.each([
    ["cancel", "the turn was interrupted"],
    ["fail", "the turn failed"],
  ])("drops the reservation of a turn that ends %s, with a notice", async (end, why) => {
    await withCli({}, async ({ host, resets, results }) => {
      await host.send(`reset:new:${end}`).catch(() => {});
      await vi.waitFor(() => expect(results().some((text) => text.startsWith(reservedNotice + why)))
        .toBe(true), { timeout: 5_000 });
      expect(resets()).toEqual([]);
    });
  });

  it("refuses a call made after its turn ended before asking the operator", async () => {
    await withCli({}, async ({ host, events, permissionRequests, resets }) => {
      await host.send("reset-late");
      await vi.waitFor(() => expect(events().some((e) => e.event === "late-reset")).toBe(true),
        { timeout: 5_000 });
      const late = events().find((e) => e.event === "late-reset")!;
      expect(late.isError).toBe(true);
      expect(String(late.text)).toContain("is no longer live. Nothing was reserved");
      expect(permissionRequests()).toEqual([]);
      await settle();
      expect(resets()).toEqual([]);
    });
  });

  it("reserves nothing for an operator answer that arrives after an interrupt", async () => {
    await withCli({ answer: "none" }, async ({ host, options, permissionRequests, resets, results }) => {
      const turn = host.send("reset:new:end").catch(() => {});
      await vi.waitFor(() => expect(permissionRequests()).toHaveLength(1), { timeout: 5_000 });
      await host.interrupt();
      await turn;
      options.onPermissionDecision?.({
        request_id: String(permissionRequests()[0]!.payload.request_id), allow: true,
      });
      await settle();
      expect(resets()).toEqual([]);
      expect(host.statusExtSnapshot()).not.toHaveProperty("pending_permission");
      expect(results().some((text) => text.startsWith("[kaoiro]"))).toBe(false);
    });
  });

  it("denies an unanswered approval at the cap when no timeout is configured", async () => {
    await withCli({ answer: "none", dependencies: { resetApprovalTimeoutMs: 200 } },
      async ({ host, resets, results }) => {
        await host.send("reset:new:end");
        expect(results().at(-1)).toContain("permission request timed out");
        await settle();
        expect(resets()).toEqual([]);
      });
  });

  it("lets a shorter permission_timeout_ms win over the cap", async () => {
    await withCli({ answer: "none", config: { permission_timeout_ms: 200 },
      dependencies: { resetApprovalTimeoutMs: 60_000 } }, async ({ host, resets, results }) => {
      await host.send("reset:new:end");
      expect(results().at(-1)).toContain("permission request timed out");
      await settle();
      expect(resets()).toEqual([]);
    });
  });

  it("tells the agent about a lifecycle failure of its own request, behind earlier input", async () => {
    await withCli({}, async ({ host, options, resets, results }) => {
      await host.send("reset:new:end");
      await vi.waitFor(() => expect(resets()).toHaveLength(1));
      await settle(50);
      options.onSessionResetFailed?.({ requestId: "another-request", reason: "spawn_failed" });
      options.onInstruction?.("queued-first");
      options.onSessionResetFailed?.({ requestId: "reset-1", reason: "spawn_failed" });
      await vi.waitFor(() => expect(results().some((text) => text.startsWith(refusedNotice)))
        .toBe(true), { timeout: 5_000 });
      const texts = results();
      const notices = texts.filter((text) => text.startsWith(refusedNotice));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("The server refused it: spawn_failed");
      expect(texts.indexOf("queued-first")).toBeGreaterThan(-1);
      expect(texts.indexOf("queued-first")).toBeLessThan(texts.indexOf(notices[0]!));
    });
  });

  it("retries agent_busy once, then tells the agent it was not carried out", async () => {
    await withCli({ replies: [new Error("agent_busy"), new Error("agent_busy")] },
      async ({ host, resets, results }) => {
        await host.send("reset:new:end");
        await vi.waitFor(() => expect(results().some((text) => text.startsWith(refusedNotice)))
          .toBe(true), { timeout: 10_000 });
        expect(resets()).toHaveLength(2);
        expect(results().find((text) => text.startsWith(refusedNotice)))
          .toContain("The server refused it: agent_busy");
      });
  }, 15_000);
});
