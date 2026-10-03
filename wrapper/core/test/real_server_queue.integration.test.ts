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

function message(from: string, to: string, body: string): Envelope {
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
      conversation_id: `real-${Date.now()}`,
      turn_number: 1,
      kind: "inform",
      body,
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
      new_conversation: true,
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
