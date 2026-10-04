// Runs only with KAOIRO_REAL_SERVER=1: it boots the real Phoenix server
// (server/, MIX_ENV=test) and drives the real ServerLink and QueueLease
// against it. The rest of the suite never needs Elixir.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Envelope } from "@kaoiro/protocol";
import { ServerLink } from "../src/transport.js";
import type { QueueOffer } from "../src/queue_lease.js";
import { startRealServer, type RealServer } from "./support/real_server.js";

const enabled = process.env.KAOIRO_REAL_SERVER === "1";
const policy = { batch_max_items: 10, backlog_max_items: 100, backlog_max_bytes: 524_288 };
const ROUTING_ON =
  "Application.put_env(:kaoiro_server, :inter_agent_queue, " +
  "Keyword.put(Application.fetch_env!(:kaoiro_server, :inter_agent_queue), :route_accepted, true))";

function state(agentId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: "default", name: "default", sprite_set: "default" },
    display_name: agentId,
    ts: new Date().toISOString(),
    type: "state_change",
    state: "idle",
    payload: {},
    ext: {},
  } as unknown as Envelope;
}

function message(from: string, to: string, body: string, conversationId?: string, turn = 1): Envelope {
  return {
    version: "0",
    agent_id: from,
    persona: { id: "default", name: "default", sprite_set: "default" },
    display_name: from,
    ts: new Date().toISOString(),
    type: "inter_agent_message",
    state: "tool_running",
    payload: {
      to,
      conversation_id: conversationId ?? `real-${Date.now()}`,
      turn_number: turn,
      kind: "inform",
      body,
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
      new_conversation: turn === 1,
    },
    ext: {},
  } as unknown as Envelope;
}

async function until<T>(read: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!enabled)("real server: credit-v1 queue round trip", () => {
  let server: RealServer;
  const links: ServerLink[] = [];

  beforeAll(async () => {
    server = await startRealServer(ROUTING_ON);
  }, 120_000);

  afterAll(async () => {
    for (const link of links) link.close();
    await server?.stop();
  }, 30_000);

  /** A queue-declaring link that records its offers, joined and announced. */
  async function queueLink(agentId: string): Promise<{ link: ServerLink; offers: QueueOffer[] }> {
    const offers: QueueOffer[] = [];
    let joined = false;
    const link = new ServerLink(server.url, agentId, {
      personaId: "default",
      interAgentQueuePolicy: policy,
      onQueueOffer: (offer) => offers.push(offer),
      onHydration: () => { joined = true; },
    });
    links.push(link);
    await until(() => (joined ? true : undefined));
    link.send(state(agentId));
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { link, offers };
  }

  it("offers a waiting sender's reply at once as W, without credit", async () => {
    const suffix = Date.now().toString(36);
    const waiting = await queueLink(`real.waiting${suffix}`);
    const peer = await queueLink(`real.peer${suffix}`);
    const cid = `real-wait-${suffix}`;

    const ask = {
      ...message(`real.waiting${suffix}`, `real.peer${suffix}`, "question", cid),
      waiter_registration: { token: "token-1", call_token: "call-1", expires_in_ms: 60_000 },
    } as unknown as Envelope;
    expect(await waiting.link.sendInterAgent(ask)).toMatchObject({ kind: "accepted" });

    const answer = message(`real.peer${suffix}`, `real.waiting${suffix}`, "answer", cid, 2);
    expect(await peer.link.sendInterAgent(answer)).toMatchObject({ kind: "accepted" });

    const offer = await until(() => waiting.offers[0]);
    expect(offer.kind).toBe("waiter");
    expect(offer.items[0]).toMatchObject({ class: "waiter" });
    expect(offer.items[0]!.envelope.payload).toMatchObject({ body: "answer" });

    const permit = await offer.begin([offer.items[0]!.queueId], "tool-turn");
    expect(permit?.invoke(() => {})).toBe(true);
    const disposed = await offer.dispose([
      { queue_id: offer.items[0]!.queueId, outcome: "observed", witness: "tool_result" },
    ]);
    expect(disposed).toMatchObject({ ok: true, reply: { queue: { waiter: 0 } } });
  }, 60_000);

  it("a replacement process gets the item its predecessor was offered but never submitted", async () => {
    const suffix = Date.now().toString(36);
    const recipientId = `real.replaced${suffix}`;
    const first = await queueLink(recipientId);
    const sender = new ServerLink(server.url, `real.sender2${suffix}`, { personaId: "default" });
    links.push(sender);
    sender.send(state(`real.sender2${suffix}`));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await sender.sendInterAgent(message(`real.sender2${suffix}`, recipientId, "kept"))).toMatchObject({ kind: "accepted" });
    await first.link.queueLease()!.credit("root", "turn-1");
    const lost = await until(() => first.offers[0]);
    first.link.close();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const second = await queueLink(recipientId);
    await second.link.queueLease()!.credit("root", "turn-1");
    const again = await until(() => second.offers[0]);
    expect(again.items[0]!.queueId).toBe(lost.items[0]!.queueId);
    expect(again.items[0]!.deliverySeq).toBeGreaterThan(lost.items[0]!.deliverySeq);
    expect(again.items[0]!.envelope.payload).toMatchObject({ body: "kept" });
  }, 60_000);

  it("a server notice reaches a queue recipient through credit, not a push", async () => {
    const suffix = Date.now().toString(36);
    const recipientId = `real.noticed${suffix}`;
    const peerId = `real.leaving${suffix}`;
    const recipient = await queueLink(recipientId);
    const peer = new ServerLink(server.url, peerId, { personaId: "default" });
    links.push(peer);
    peer.send(state(peerId));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await peer.sendInterAgent(message(peerId, recipientId, "before leaving"))).toMatchObject({ kind: "accepted" });
    expect(await peer.reportDisconnectIntent("stop")).toBe(true);
    peer.close();

    const lease = recipient.link.queueLease()!;
    const notice = async (): Promise<Envelope> => {
      for (;;) {
        const before = recipient.offers.length;
        expect(await lease.credit("root", `turn-${before}`)).toMatchObject({ ok: true });
        const offer = await until(() => recipient.offers[before]);
        const [item] = offer.items;
        const disposed = await offer.dispose([
          { queue_id: item!.queueId, outcome: "intentional_non_injection", reason: "terminal_skip" },
        ]);
        expect(disposed.ok).toBe(true);
        if (item!.envelope.agent_id === "server") return item!.envelope;
      }
    };

    const envelope = await notice();
    expect(envelope.payload).toMatchObject({
      to: recipientId,
      turn_number: 0,
      error: { code: "disconnected" },
    });
  }, 60_000);

  it("returns the peer's queued input inline with a stale reply basis refusal (r8 §6.3)", async () => {
    const suffix = Date.now().toString(36);
    const recipientId = `real.stale${suffix}`;
    const senderId = `real.newer${suffix}`;
    const cid = `real-stale-${suffix}`;
    let joined = false;
    const recipient = new ServerLink(server.url, recipientId, {
      personaId: "default",
      interAgentQueuePolicy: policy,
      interAgentReplyBasis: "v1",
      interAgentInlineRecovery: true,
      onQueueOffer: () => {},
      onHydration: () => { joined = true; },
      onInterAgentQueueRefused: (reason) => { throw new Error(`refused: ${JSON.stringify(reason)}`); },
    });
    links.push(recipient);
    await until(() => (joined ? true : undefined));
    recipient.send(state(recipientId));
    const sender = new ServerLink(server.url, senderId, { personaId: "default" });
    links.push(sender);
    sender.send(state(senderId));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The peer's input waits in the recipient's queue, unseen.
    expect(await sender.sendInterAgent(message(senderId, recipientId, "newer input", cid))).toMatchObject({ kind: "accepted" });

    // The recipient replies on a basis that predates it.
    const reply = message(recipientId, senderId, "late reply", cid, 2);
    (reply.payload as Record<string, unknown>).in_reply_to = 0;
    (reply.payload as Record<string, unknown>).new_conversation = false;
    const refused = await recipient.sendInterAgent(reply, recipient.replyBasisGeneration());
    expect(refused).toMatchObject({ kind: "rejected", reason: "stale_reply_basis", details: { expected_peer_turn: 1, supplied_basis: 0 } });
    const recovery = (refused as { queue_recovery?: QueueOffer }).queue_recovery!;
    expect(recovery.kind).toBe("recovery");
    expect(recovery.items).toHaveLength(1);
    expect(recovery.items[0]!.envelope.payload).toMatchObject({ body: "newer input", turn_number: 1 });
    expect(recipient.queueLease()!.heldLeaseIds()).toEqual([recovery.leaseId]);

    const permit = await recovery.begin([recovery.items[0]!.queueId], "tool-turn");
    expect(permit).not.toBeNull();
    const disposed = await recovery.dispose([{ queue_id: recovery.items[0]!.queueId, outcome: "observed", witness: "tool_result" }]);
    expect(disposed).toMatchObject({ ok: true, reply: { queue: { queued: 0, offered: 0, native_pending: 0 } } });
    expect(recipient.queueLease()!.heldLeaseIds()).toEqual([]);
  }, 60_000);

  it("delivers a routed message through credit, permit and disposition", async () => {
    const suffix = Date.now().toString(36);
    const recipientId = `real.recipient${suffix}`;
    const senderId = `real.sender${suffix}`;
    const offers: QueueOffer[] = [];
    let joined = false;

    const recipient = new ServerLink(server.url, recipientId, {
      personaId: "default",
      interAgentQueuePolicy: policy,
      onQueueOffer: (offer) => offers.push(offer),
      onHydration: () => { joined = true; },
      onInterAgentQueueRefused: (reason) => { throw new Error(`refused: ${JSON.stringify(reason)}`); },
    });
    links.push(recipient);
    await until(() => (joined ? true : undefined));
    recipient.send(state(recipientId));

    const sender = new ServerLink(server.url, senderId, { personaId: "default" });
    links.push(sender);
    sender.send(state(senderId));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const accepted = await sender.sendInterAgent(message(senderId, recipientId, "héllo over the queue"));
    expect(accepted).toMatchObject({ kind: "accepted" });
    expect(offers).toHaveLength(0);

    const lease = recipient.queueLease()!;
    const credit = await lease.credit("root", "turn-1");
    expect(credit).toMatchObject({ ok: true, reply: { op: "credit", credit_revision: "1" } });

    const offer = await until(() => offers[0]);
    expect(offer.kind).toBe("root");
    expect(offer.items).toHaveLength(1);
    const [item] = offer.items;
    expect(item!.envelope.payload).toMatchObject({ body: "héllo over the queue" });
    expect(item!.deliverySeq).toBe(1);

    const permit = await offer.begin([item!.queueId], "turn-1");
    expect(permit).not.toBeNull();
    let submitted = false;
    expect(permit!.invoke(() => { submitted = true; })).toBe(true);
    expect(submitted).toBe(true);

    const disposed = await offer.dispose([{ queue_id: item!.queueId, outcome: "observed", witness: "prompt_hook" }]);
    expect(disposed).toMatchObject({
      ok: true,
      reply: {
        op: "dispose",
        disposed: [item!.queueId],
        resolved_ranges: [[1, 1]],
        queue: { queued: 0, offered: 0, native_pending: 0, charged_bytes: 0, policy },
      },
    });
  }, 60_000);
});
