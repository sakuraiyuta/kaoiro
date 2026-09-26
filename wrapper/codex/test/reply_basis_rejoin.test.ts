import { expect, it, vi } from "vitest";
import { ServerLink } from "@kaoiro/wrapper-core";
import { InterAgentTool } from "@kaoiro/agent-common";
import type { Envelope } from "@kaoiro/agent-common";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const config = { agent_id: "self", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://localhost" };

it.each(["legacy", "v1"] as const)("reformats a queued %s send after real join/rejoin and never pushes while pending", async initial => {
  const rejoin = deferred<Record<string, unknown>>();
  const firstAck = deferred<Record<string, unknown>>();
  const wire = await phoenixLoopback(n => n === 1 ? (initial === "v1" ? { inter_agent_reply_basis: "v1" } : {}) : rejoin.promise,
    (event, payload) => event === "envelope" && (payload.payload as { body?: string })?.body === "first" ? firstAck.promise : {});
  let mode: "pending" | "legacy" | "v1" = "pending";
  const link = new ServerLink(wire.url, "self", { personaId: "p", interAgentReplyBasis: "v1", onReplyBasisMode: m => { mode = m; } });
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: e => link.send(e),
    replyBasisMode: () => mode, replyBasisGeneration: () => link.replyBasisGeneration(),
    waitReplyBasisMode: signal => link.waitForReplyBasisMode(signal),
    sendInterAgent: (e, generation) => link.sendInterAgent(e, generation),
  });
  tool.beginReplyInput("T");
  const args = { to: "peer", conversation_id: "cid", kind: "response" as const, body: "first" };
  const origin = { origin: { token: "T" } };
  const sent = () => wire.received.filter(x => x.event === "envelope" && x.payload.type === "inter_agent_message");
  try {
    await vi.waitFor(() => expect(mode).toBe(initial));
    const generation = link.replyBasisGeneration();
    const first = tool.invoke(args, origin); await vi.waitFor(() => expect(sent()).toHaveLength(1));
    const queued = tool.invoke({ ...args, body: "queued" }, origin);
    wire.drop(); await vi.waitFor(() => expect(mode).toBe("pending"));
    // The first real push has no ack. Its timeout releases the CID lock;
    // the queued call must still wait for the held rejoin response.
    expect(JSON.stringify(await first)).toContain("unknown");
    firstAck.resolve({});
    await vi.waitFor(() => expect(wire.joins).toBe(2), { timeout: 5000 });
    const raw = sent()[0]!.payload as unknown as Envelope;
    const refused = await link.sendInterAgent(raw, generation);
    expect(refused).toMatchObject({ kind: "rejected", send_not_attempted: true });
    expect(await link.sendInterAgent(raw, link.replyBasisGeneration())).toMatchObject({ kind: "rejected", send_not_attempted: true });
    expect(sent()).toHaveLength(1);
    rejoin.resolve({ inter_agent_reply_basis: "v1" });
    expect(JSON.stringify(await queued)).toContain("sent");
    expect(sent()).toHaveLength(2);
    expect((sent()[1]!.payload.payload as Record<string, unknown>).in_reply_to).toBe(0);
    expect((sent()[0]!.payload.payload as Record<string, unknown>).in_reply_to).toBe(initial === "v1" ? 0 : undefined);
    expect(await link.sendInterAgent(raw, generation)).toMatchObject({ kind: "rejected", send_not_attempted: true });
    // A round trip fences the assertion against buffered old-generation pushes.
    await link.requestDirectory(); expect(sent()).toHaveLength(2);
  } finally { firstAck.resolve({}); rejoin.resolve({}); tool.endReplyInput("T"); link.close(); await wire.close(); }
}, 25000);

it("invalidates on channel-only rejoin and rejects unbound fire-and-forget IA without buffering", async () => {
  const rejoin = deferred<Record<string, unknown>>();
  const wire = await phoenixLoopback(n => n === 1 ? { inter_agent_reply_basis: "v1" } : rejoin.promise);
  let mode = "pending";
  const link = new ServerLink(wire.url, "self", { personaId: "p", interAgentReplyBasis: "v1", onReplyBasisMode: m => { mode = m; } });
  const envelope: Envelope = { version: "0", agent_id: "self", persona: config.persona, display_name: "P",
    ts: "2026-09-26T00:00:00Z", state: "thinking", ext: {}, type: "inter_agent_message", payload: { body: "must not buffer" } };
  try {
    await vi.waitFor(() => expect(mode).toBe("v1")); const old = link.replyBasisGeneration();
    wire.push("phx_error", {}); await vi.waitFor(() => expect(mode).toBe("pending"));
    expect(await link.sendInterAgent(envelope, old)).toMatchObject({ kind: "rejected", send_not_attempted: true });
    link.send(envelope);
    await vi.waitFor(() => expect(wire.joins).toBe(2), { timeout: 5000 });
    rejoin.resolve({ inter_agent_reply_basis: "v1" }); await vi.waitFor(() => expect(mode).toBe("v1"));
    expect(await link.sendInterAgent(envelope, old)).toMatchObject({ kind: "rejected", send_not_attempted: true });
    await link.requestDirectory();
    expect(wire.received.filter(x => x.event === "envelope")).toHaveLength(0);
  } finally { rejoin.resolve({}); link.close(); await wire.close(); }
}, 15000);
