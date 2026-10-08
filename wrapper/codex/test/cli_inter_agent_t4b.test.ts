import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, it, vi } from "vitest";
import { handoffToolResult, type Envelope, type InterAgentMessagePayload, type WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";
import { CodexHost, type CodexHostOptions } from "../src/host.js";
import { AppServerSession } from "../src/app_server_session.js";
import type { RpcObject } from "../src/app_server_rpc.js";

const config: WrapperConfig = {
  agent_id: "self", persona: { id: "fixture", name: "Fixture", sprite_set: "fixture" },
  display_name: "Fixture", server_url: "ws://unused", model: "gpt-5.6-sol", effort: "low",
  codex_auth_mode: "chatgpt", codex_chatgpt_plan: "plus",
};

function inbound(turn: number, seq: number, early = false, cid = "X", peer = "peer"): Envelope {
  return { version: "0", agent_id: peer, persona: config.persona, display_name: "Peer",
    ts: "2026-10-09T00:00:00Z", type: "inter_agent_message", state: "thinking", ext: {}, delivery_seq: seq,
    payload: { to: "self", conversation_id: cid, turn_number: turn, kind: "request", body: `BODY-${turn}`,
      meta: { done: false, propose_next: "" }, owner: { kind: "user", id: "operator" }, notice_attribution: "v1", new_conversation: false,
      delivery_authority: { requested: early ? "early" : "normal", granted: early ? "early" : "normal" },
    } satisfies InterAgentMessagePayload } as Envelope;
}

it.each([{ spend: false, cid: "X", late: false, peer: "peer" }, { spend: true, cid: "X", late: false, peer: "peer" },
  { spend: false, cid: "Y", late: false, peer: "peer" }, { spend: false, cid: "X", late: true, peer: "peer" },
  { spend: false, cid: "Y", late: true, peer: "other" }])(
  "T1/T4b/T8d: real CLI and host preserve k+1 while k+2 steers; $cid, $peer, spent=$spend, late=$late", async ({ spend, cid, late, peer }) => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough(), requests: RpcObject[] = [];
  let turn = 0;
  let releaseSteer: (() => void) | undefined;
  const notify = (message: unknown) => stdout.write(JSON.stringify(message) + "\n");
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(String(chunk)) as RpcObject;
    requests.push(request);
    const reply = (result: unknown) => notify({ id: request.id, result });
    switch (request.method) {
      case "initialize": reply({ userAgent: "fixture/0.159.3" }); break;
      case "thread/start": reply({ thread: { id: "thread" }, model: config.model, reasoningEffort: "low" }); break;
      case "config/read": reply({ config: { model_reasoning_effort: "low" } }); break;
      case "account/rateLimits/read": notify({ id: request.id, error: { code: -32600, message: "fixture has no account" } }); break;
      case "turn/start":
        turn += 1; reply({ turn: { id: `turn-${turn}` } });
        notify({ method: "turn/started", params: { threadId: "thread", turn: { id: `turn-${turn}` } } }); break;
      case "turn/steer":
        releaseSteer = () => reply({ turnId: (request.params as { expectedTurnId: string }).expectedTurnId });
        if (!late) releaseSteer(); break;
      case "turn/interrupt":
        reply({}); notify({ method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${turn}`, status: "interrupted" } } }); break;
    }
    callback();
  } });
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
  const exit = () => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 }); child.emit("exit", 0, null);
    stdout.end(); stderr.end(); queueMicrotask(() => child.emit("close", 0, null));
  };
  stdin.on("finish", exit); child.kill = vi.fn(() => { exit(); return true; });
  let callbacks!: Record<string, any>, host!: CodexHost, options!: CodexHostOptions;
  const reports: Record<string, unknown>[] = [], sent: Envelope[] = [];
  const staleRecovery = !spend && cid === "X" && !late;
  const link = { close: () => {}, send: () => {}, currentSessionId: () => null, setSessionId: () => {},
    permissionSyncPending: () => false,
    deliveryModes: () => ({ version: "v1", early: "steer", yield: "none", stage_reports: true }),
    noticeAttributionMode: () => "v1", deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
    reportDeliveryStage: (report: Record<string, unknown>) => reports.push(report), acknowledgeInterAgentDelivery: () => {},
    // The stale rejection is scripted; ConversationStates separately pins the server's admission rule.
    sendInterAgent: async (envelope: Envelope) => {
      sent.push(envelope);
      if (staleRecovery && envelope.payload.in_reply_to !== 6) return { kind: "rejected", reason: "stale_reply_basis",
        details: { conversation_id: "X", expected_peer_turn: 6, supplied_basis: envelope.payload.in_reply_to } };
      return { kind: "accepted", stamp: null };
    },
  };
  const scratch = mkdtempSync(join(tmpdir(), "fuji548-t4b-"));
  vi.stubEnv("HOME", scratch);
  vi.stubEnv("CODEX_HOME", join(scratch, "codex"));
  const beforeSignals = process.listeners("SIGINT");
  const running = runCodexCli({ backend: "app-server",
    parseCliArgs: () => ({ configPath: "fixture", prompt: undefined, resume: undefined }), loadConfig: () => ({ ...config }),
    prepareStartup: async () => {},
    createServerLink: (_url, _id, incoming) => {
      callbacks = incoming as unknown as Record<string, any>;
      queueMicrotask(() => incoming.onPersonaPrompt?.("PERSONA")); return link as never;
    },
    createHost: (loaded, incoming) => {
      options = incoming;
      host = new CodexHost(loaded, { ...incoming,
        appServerSessionFactory: sessionOptions => AppServerSession.create({ ...sessionOptions,
          transport: { spawnChild: () => child, shutdownTimeoutMs: 100 } }),
      }); return host;
    },
  });
  const byMethod = (method: string) => requests.filter(request => request.method === method);
  try {
    await vi.waitFor(() => expect(host).toBeDefined());
    callbacks.onReplyBasisMode("v1"); callbacks.onInterAgentDeliveryStatus({ acked_seq: 0 });
    await callbacks.onInterAgentMessage(inbound(4, 60));
    await vi.waitFor(() => expect(byMethod("turn/start")).toHaveLength(1));
    const owner = host.activeInterAgentTurnToken(); expect(owner).not.toBeNull();
    await callbacks.onInterAgentMessage(inbound(5, 63));
    await callbacks.onInterAgentMessage(inbound(6, 64, true, cid, peer));
    await vi.waitFor(() => expect(byMethod("turn/steer")).toHaveLength(1));
    expect(byMethod("turn/start")).toHaveLength(1);
    const params = byMethod("turn/steer")[0]!.params as { input: { text: string }[]; clientUserMessageId: string };
    const text = params.input[0]!.text;
    expect(text).toContain("BODY-6"); expect(text).not.toContain("BODY-5");
    const auth = JSON.parse(text.split("\n").find(line => line.startsWith("reply_authorization: "))!.slice("reply_authorization: ".length));
    expect(auth.in_reply_to).toBe(6);
    notify({ method: "item/completed", params: { threadId: "thread", turnId: "turn-1",
      item: { type: "userMessage", id: "early", clientId: params.clientUserMessageId, content: [{ type: "text", text }] } } });
    await vi.waitFor(() => expect(reports.some(report => report.stage === "submitted")).toBe(true));
    await new Promise(resolve => setImmediate(resolve));
    const sendTool = options.toolDescriptors!.find(tool => tool.name === "send_to_agent")!;
    if (spend) {
      const result = await sendTool.handler({ to: "peer", conversation_id: "X", kind: "response", body: "EARLY ANSWER",
        in_reply_to: auth.in_reply_to, reply_ticket: auth.reply_ticket }, { origin: { token: owner! } });
      expect(result.isError).toBeFalsy(); expect(sent.at(-1)!.payload.in_reply_to).toBe(6);
    }
    notify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1", status: late ? "failed" : "completed" } } });
    if (late) {
      await vi.waitFor(() => expect(host.activeInterAgentTurnToken()).toBeNull());
      expect(byMethod("turn/start")).toHaveLength(1);
      expect(sent).toEqual([]);
      releaseSteer!();
    }
    await vi.waitFor(() => expect(byMethod("turn/start")).toHaveLength(2));
    if (late) {
      const failures = sent.map(notice => notice.payload as unknown as InterAgentMessagePayload);
      expect(failures.flatMap(notice => notice.error?.affected_deliveries ?? []).map(entry => entry.delivery_seq).sort((a, b) => a - b)).toEqual([60, 64]);
      expect(failures).toHaveLength(peer === "peer" ? 1 : 2);
      expect(failures.every(notice => notice.error!.code === "api_error")).toBe(true);
    }
    expect((byMethod("turn/start")[1]!.params as { input: { text: string }[] }).input[0]!.text).toContain("BODY-5");
    const result = await sendTool.handler({ to: "peer", conversation_id: "X", kind: "response", body: "NEXT ANSWER" },
      { origin: { token: host.activeInterAgentTurnToken()! } });
    expect(sent.at(-1)!.payload.in_reply_to).toBe(spend ? 6 : 5);
    if (staleRecovery) {
      expect(result.isError).toBe(true);
      const recovery = JSON.parse(result.content[0]!.text);
      expect(recovery.error).toBe("stale_reply_basis");
      expect(recovery.recovery).toHaveLength(1);
      expect(recovery.recovery[0]).toMatchObject({ agent_id: "peer",
        payload: { conversation_id: "X", turn_number: 6, body: "BODY-6" } });
      expect(recovery.folded_earlier).toBe(true);
      expect(recovery.reply_authorization.in_reply_to).toBe(6);
      expect(handoffToolResult(result, () => {})).toBe(true);
      const retry = await sendTool.handler({ to: "peer", conversation_id: "X", kind: "response", body: "NEXT ANSWER",
        ...recovery.reply_authorization }, { origin: { token: host.activeInterAgentTurnToken()! } });
      expect(retry.isError).toBeFalsy();
      expect(sent.at(-1)!.payload).toMatchObject({ conversation_id: "X", in_reply_to: 6, body: "NEXT ANSWER" });
      expect(byMethod("turn/start")).toHaveLength(2);
    } else expect(result.isError).toBeFalsy();
  } finally {
    host?.close(); await running;
    for (const listener of process.listeners("SIGINT")) if (!beforeSignals.includes(listener)) process.removeListener("SIGINT", listener);
    vi.unstubAllEnvs(); rmSync(scratch, { recursive: true, force: true });
  }
}, 15_000);
