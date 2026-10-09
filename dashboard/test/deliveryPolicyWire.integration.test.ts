// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { connectKaoiro, type KaoiroConnection } from "../src/lib/protocol";
import { DeliveryPolicyError } from "../src/lib/deliveryPolicy";
import { deliveryLoopback, deliveryView, LoopbackWebSocket } from "./deliveryPolicyLoopback";
let loop: Awaited<ReturnType<typeof deliveryLoopback>>;
let conn: KaoiroConnection | undefined;
afterEach(async () => { conn?.disconnect(); await loop?.close(); });
async function connect() {
  loop = await deliveryLoopback();
  const changed = vi.fn(); const marker = vi.fn();
  conn = connectKaoiro(loop.url.replace("http", "ws") + "/client", { onStatus: vi.fn(), onSnapshot: vi.fn(), onEnvelope: vi.fn(),
    onDeliveryPolicyChanged: changed, onDeliveryPolicyControl: marker }, { transport: LoopbackWebSocket as unknown as typeof WebSocket });
  await vi.waitFor(() => expect(marker).toHaveBeenLastCalledWith(true));
  return { changed, marker };
}
it("uses the real Phoenix client for exact read/write, checked events and rich conflicts", async () => {
  const { changed } = await connect();
  await expect(conn!.getDeliveryPolicy("host.p")).resolves.toMatchObject(deliveryView);
  await expect(conn!.setDeliveryPolicy("host.p", "off", 1)).resolves.toEqual({ revision: 2, status: "pending" });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith("host.p", expect.objectContaining({ policy: "off", revision: 2 })));
  expect(loop.frames.find(f => f[3] === "set_delivery_policy")?.[4]).toEqual({ version: "0", agent_id: "host.p", policy: "off", expected_revision: 1 });
  expect(loop.frames.find(f => f[3] === "get_delivery_policy")?.[4]).toEqual({ version: "0", agent_id: "host.p" });
  await expect(conn!.setDeliveryPolicy("host.p", "on", 1)).rejects.toMatchObject({ reason: "revision_conflict", currentRevision: 2, policy: "off" });
  await conn!.restore("host.p"); await conn!.resumeSession("host.p", "session");
  for (const f of loop.frames.filter(f => ["restore", "resume_session"].includes(f[3] as string))) expect(f[4]).not.toHaveProperty("delivery_policy");
});
it("malformed success is uncertain; loss disables writes without buffering", async () => {
  await connect(); loop.state.automatic = false;
  const pending = conn!.setDeliveryPolicy("host.p", "off", 1);
  const outcome = expect(pending).rejects.toMatchObject({ uncertain: true });
  await vi.waitFor(() => expect(loop.frames.some(f => f[3] === "set_delivery_policy")).toBe(true));
  loop.reply(loop.frames.find(f => f[3] === "set_delivery_policy")!, { revision: 2, status: "confirmed" }); await outcome;
  loop.send("phx_error", {});
  await vi.waitFor(async () => { await expect(conn!.getDeliveryPolicy("host.p")).rejects.toBeInstanceOf(DeliveryPolicyError); });
  const count = loop.frames.filter(f => f[3] === "set_delivery_policy").length;
  await expect(conn!.setDeliveryPolicy("host.p", "off", 1)).rejects.toMatchObject({ reason: "unavailable" });
  expect(loop.frames.filter(f => f[3] === "set_delivery_policy")).toHaveLength(count);
});
it("explicit disconnect immediately cancels a pending policy request and readiness", async () => {
  const { marker } = await connect(); loop.state.automatic = false;
  const pending = conn!.setDeliveryPolicy("host.p", "off", 1);
  const outcome = expect(pending).rejects.toMatchObject({ reason: "disconnected", uncertain: true });
  conn!.disconnect(); expect(marker).toHaveBeenLastCalledWith(false); await outcome;
});
