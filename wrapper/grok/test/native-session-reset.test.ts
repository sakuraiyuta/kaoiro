import { permitHostAccess } from "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import {
  REQUEST_SESSION_RESET_TOOL_FQN,
  type Envelope,
  type ResolvedSnapshotExt,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import { runGrokCli } from "../src/cli.js";
import type { GrokHost } from "../src/host.js";
import { makeGrokScratch, removeGrokState } from "./grok-state.js";

permitHostAccess({
  kinds: ["network"],
  optIn: "KAOIRO_LIVE_GROK",
  reason: "live Grok provider run",
});

// Issue #658 acceptance against the real grok, through runGrokCli with a fake
// server link. A runner reset is a fresh relaunch (no --resume, the stored
// snapshot relayed); the wrapper SIGTERM of that relaunch is covered by
// native-lifecycle.test.ts. Runs only with KAOIRO_LIVE_GROK=1.

const live = process.env.KAOIRO_LIVE_GROK === "1";
type Sandbox = NonNullable<WrapperConfig["sandbox"]>;
const config = (sandbox: Sandbox, extra: Partial<WrapperConfig> = {}): WrapperConfig => ({
  agent_id: "native.reset", display_name: "Reset fixture", server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  sandbox, network_access: sandbox !== "read-only", ...extra,
});
const ext = (host: GrokHost) => host.statusExtSnapshot() as Record<string, any>;
const ready = (host: GrokHost) =>
  vi.waitFor(() => {
    expect(host.state).toBe("waiting_input");
    expect(ext(host)).not.toHaveProperty("pending_model");
    expect(ext(host)).not.toHaveProperty("pending_effort");
  }, { timeout: 60_000 });
/** The relaunch config the runner builds from a stored snapshot for a reset:
 *  explicit sources kept, the sandbox pair from the snapshot, no --resume. */
const relaunch = (stored: ResolvedSnapshotExt): Partial<WrapperConfig> => ({
  ...(stored.model_source && stored.model_source !== "default"
    ? { model: stored.model!, model_source: stored.model_source } : {}),
  ...(stored.effort_source && stored.effort_source !== "default"
    ? { effort: stored.effort!, effort_source: stored.effort_source } : {}),
  ...(stored.sandbox ? { sandbox: stored.sandbox } : {}),
  ...(stored.network_access !== undefined ? { network_access: stored.network_access } : {}),
  resume_snapshot: stored,
});

type ResetCall = { mode: string; reason?: string; at: number };
interface Run {
  envelopes: Envelope[];
  resets: ResetCall[];
  sessionId?: string;
  replay: { kind: "reset" | "complete"; at: number }[];
}
interface RunSetup {
  rules: string;
  answer?: "allow" | "deny";
  replies?: ({ requestId: string } | Error)[];
}

async function run(
  cfg: WrapperConfig,
  cwd: string,
  setup: RunSetup,
  exercise: (host: GrokHost, options: ServerLinkOptions, record: Run) => Promise<void>,
): Promise<Run> {
  const folder = mkdtempSync(join(tmpdir(), "kaoiro-grok-native-reset-"));
  const file = join(folder, "agent.json");
  writeFileSync(file, JSON.stringify(cfg));
  const previous = process.argv;
  process.argv = [previous[0]!, previous[1]!, "run", file];
  const record: Run = { envelopes: [], resets: [], replay: [] };
  const replies = [...(setup.replies ?? [{ requestId: "native-reset" }])];
  let linkOptions!: ServerLinkOptions;
  let probe!: Promise<void>;
  let sessionId: string | null = null;
  try {
    await runGrokCli({
      cwd,
      createServerLink: (_url, _id, options) => {
        linkOptions = options;
        queueMicrotask(() => {
          options.permissionSync?.onNegotiated?.(true);
          options.permissionSync?.onSync?.({ version: "0", control: null, next: null }, 1);
          options.onPersonaPrompt?.(setup.rules);
          options.onHydration?.({ replay_required: true, replay_id: "native-reset-replay" });
        });
        return {
          send: (e: Envelope) => {
            record.envelopes.push(e);
            if (e.type !== "permission_request") return;
            const payload = e.payload as Record<string, unknown>;
            const allow = payload.tool_name === REQUEST_SESSION_RESET_TOOL_FQN
              ? setup.answer === "allow"
              : false;
            queueMicrotask(() => options.onPermissionDecision?.({
              request_id: String(payload.request_id), allow,
            }));
          },
          requestSessionReset: (mode: string, reason?: string) => {
            record.resets.push({ mode, ...(reason !== undefined ? { reason } : {}),
              at: record.envelopes.length });
            const next = replies.shift() ?? new Error("unknown_error");
            return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
          },
          setSessionId: (id: string) => { sessionId = id; record.sessionId = id; },
          currentSessionId: () => sessionId,
          sendHistoryReset: () => record.replay.push({ kind: "reset", at: record.envelopes.length }),
          sendReplayIa: () => {},
          sendHistoryReplayComplete: () =>
            record.replay.push({ kind: "complete", at: record.envelopes.length }),
          waitForPermissionSyncNegotiation: async () => true,
          waitForPermissionSync: async () => {},
          reportPermissionLifecycle: () => {},
          noticeAttributionMode: () => "legacy",
          reportDisconnectIntent: async () => {},
          close: () => {},
          deliveryIncarnation: () => null,
          deliveryGeneration: () => null,
          requestDirectory: async () => ({ agents: [], users: [] }),
          requestSelfIdentity: async () => null,
          requestInterAgentDeliveryStatus: async () => null,
        } as unknown as ServerLink;
      },
      onHostCreated: (host) => {
        probe = exercise(host, linkOptions, record).finally(() => host.close());
        void probe.catch(() => host.close());
      },
    });
    await probe;
  } finally {
    process.argv = previous;
    rmSync(folder, { recursive: true, force: true });
  }
  return record;
}

// Grok's use_tool takes only the qualified name; an unqualified first try
// fails inside Grok and never reaches the ToolHost.
const resetPrompt = (reason: string) =>
  "Call use_tool exactly once with tool_name \"kaoiro__request_session_reset\" and tool_input " +
  `{"mode": "new", "reason": "${reason}"}. Do not call it again and use no other tool, ` +
  "whatever it returns. Then reply with the single word DONE.";
const resetRequests = (record: Run) => record.envelopes.filter((e) =>
  e.type === "permission_request" && e.payload.tool_name === REQUEST_SESSION_RESET_TOOL_FQN);
const userTexts = (record: Run) => record.envelopes.filter((e) =>
  e.type === "log" && e.payload.kind === "user").map((e) => String(e.payload.text));
const replies = (record: Run) => record.envelopes.filter((e) =>
  e.type === "log" && e.payload.kind === "assistant").map((e) => String(e.payload.text)).join("\n");
const refusedNotice = "[kaoiro] The session reset you requested (mode: new) was not carried out. ";

describe.skipIf(!live)("native session reset", () => {
  it("asks the operator through Grok's MCP call, and a deny reserves nothing", async () => {
    const cwd = makeGrokScratch("reset-deny");
    try {
      const record = await run(config("workspace-write"), cwd,
        { rules: "Follow the user's requests exactly.", answer: "deny" }, async (host) => {
          await ready(host);
          await host.send(resetPrompt("native deny"));
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        });
      expect(resetRequests(record).length).toBeGreaterThanOrEqual(1);
      expect(record.resets).toEqual([]);
    } finally {
      removeGrokState(cwd);
    }
  }, 300_000);

  it("requests an approved reset after the ready state and tells Grok about a lifecycle failure", async () => {
    const cwd = makeGrokScratch("reset-allow");
    try {
      const record = await run(config("workspace-write"), cwd,
        { rules: "Follow the user's requests exactly.", answer: "allow",
          replies: [{ requestId: "native-reset-1" }] }, async (host, options, rec) => {
          await ready(host);
          await host.send(resetPrompt("native allow"));
          await vi.waitFor(() => expect(rec.resets).toHaveLength(1), { timeout: 10_000 });
          options.onSessionResetFailed?.({ requestId: "native-reset-1", reason: "spawn_failed" });
          await vi.waitFor(() => expect(userTexts(rec).some((t) => t.startsWith(refusedNotice)))
            .toBe(true), { timeout: 30_000 });
          await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 120_000 });
        });
      expect(resetRequests(record)).toHaveLength(1);
      expect(record.resets).toEqual([{ mode: "new", reason: "native allow", at: record.resets[0]!.at }]);
      const before = record.envelopes.slice(0, record.resets[0]!.at);
      expect(before.filter((e) => e.type === "state_change").at(-1)?.state).toBe("waiting_input");
      const notice = userTexts(record).find((t) => t.startsWith(refusedNotice))!;
      expect(notice).toContain("The server refused it: spawn_failed");
      expect(record.envelopes.filter((e) => e.type === "result").length).toBeGreaterThanOrEqual(2);
    } finally {
      removeGrokState(cwd);
    }
  }, 300_000);

  it("retries agent_busy once and tells Grok the reset was not carried out", async () => {
    const cwd = makeGrokScratch("reset-busy");
    try {
      const record = await run(config("workspace-write"), cwd,
        { rules: "Follow the user's requests exactly.", answer: "allow",
          replies: [new Error("agent_busy"), new Error("agent_busy")] }, async (host, _options, rec) => {
          await ready(host);
          await host.send(resetPrompt("native busy"));
          await vi.waitFor(() => expect(userTexts(rec).some((t) => t.startsWith(refusedNotice)))
            .toBe(true), { timeout: 30_000 });
          await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 120_000 });
        });
      expect(record.resets).toHaveLength(2);
      expect(userTexts(record).find((t) => t.startsWith(refusedNotice)))
        .toContain("The server refused it: agent_busy");
    } finally {
      removeGrokState(cwd);
    }
  }, 300_000);

  it("keeps the selection and permission across the reset relaunch, with the new rules and MCP", async () => {
    const cwd = makeGrokScratch("reset-relaunch");
    try {
      let stored: ResolvedSnapshotExt = {};
      const first = await run(config("read-only"), cwd,
        { rules: "Your marker word is ALPHA. Follow the user's requests exactly." },
        async (host, _options, rec) => {
          await ready(host);
          const models = ext(host).models as { value: string; effort_levels?: string[] }[];
          const target = models.find((m) => m.value !== ext(host).model &&
            (m.effort_levels?.length ?? 0) > 1)!;
          await host.setModel(target.value);
          await vi.waitFor(() => expect(ext(host).model).toBe(target.value), { timeout: 30_000 });
          const effort = target.effort_levels!.find((level) => level !== ext(host).effort)!;
          await host.setEffort(effort);
          await vi.waitFor(() => expect(ext(host).effort).toBe(effort), { timeout: 30_000 });
          await host.send("Reply with only your marker word.");
          expect(replies(rec)).toContain("ALPHA");
          stored = ext(host).effective;
          expect(stored).toMatchObject({ model: target.value, model_source: "config",
            effort, effort_source: "config", sandbox: "read-only", network_access: false });
        });
      const second = await run(config("workspace-write", relaunch(stored)), cwd,
        { rules: "Your marker word is BETA. Follow the user's requests exactly." },
        async (host, _options, rec) => {
          await ready(host);
          const now = ext(host);
          expect(now.effective).toEqual(stored);
          expect(now.resume_drift).toEqual([]);
          expect(now.permission).toMatchObject({ sandbox: "read-only" });
          expect(host.toolHostStats()?.authenticatedLists).toBeGreaterThanOrEqual(1);
          await host.send("Reply with only your marker word.");
          expect(replies(rec)).toContain("BETA");
          expect(replies(rec)).not.toContain("ALPHA");
        });
      expect(first.sessionId).toBeDefined();
      expect(second.sessionId).toBeDefined();
      expect(second.sessionId).not.toBe(first.sessionId);
      const [reset, complete] = second.replay;
      expect(reset?.kind).toBe("reset");
      expect(complete?.kind).toBe("complete");
      expect(complete!.at - reset!.at).toBe(0);
    } finally {
      removeGrokState(cwd);
    }
  }, 600_000);
});
