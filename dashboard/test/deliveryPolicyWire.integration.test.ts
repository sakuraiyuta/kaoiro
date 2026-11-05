import "./isolation.setup";
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { connectKaoiro, type KaoiroConnection } from "../src/lib/protocol";
import { deliveryPolicyLabel, DeliveryPolicyError } from "../src/lib/deliveryPolicy";
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
it("rejoin forgets a former marker and an unknown marker never enables requests", async () => {
  const { marker } = await connect();
  loop.state.marker = "v2"; loop.send("phx_error", {});
  await vi.waitFor(() => expect(loop.frames.filter(f => f[3] === "phx_join").length).toBe(2), { timeout: 3000 });
  expect(marker).toHaveBeenLastCalledWith(false);
  await expect(conn!.getDeliveryPolicy("host.p")).rejects.toMatchObject({ reason: "unavailable" });
  loop.state.marker = "v1"; loop.send("phx_error", {});
  await vi.waitFor(() => expect(marker).toHaveBeenLastCalledWith(true), { timeout: 3000 });
});

it("projects Claude mixed-generation labels from the actual client wire", async () => {
  const {changed}=await connect();
  const fold={operator_early:"fold",inter_agent_early:"fold",inter_agent_yield:"tool_boundary"};
  const none={operator_early:"none",inter_agent_early:"none",inter_agent_yield:"none"};
  for(const [name,patch,label] of [
    ["W2/S1",{mechanisms:fold},"on（確認済み）"],
    ["W2/S1 ceiling false",{mechanisms:none},"非対応・通常配送のみ"],
    ["W1/S1 enabled",{mechanisms:fold},"on（確認済み）"],
    ["W1/S1 disabled",{mechanisms:none},"非対応・通常配送のみ"],
    ["W2/S0",{policy:"unknown",confirmed:false,pending:false,wrapper_support:false},"状態不明・通常配送"],
    ["W0/S1",{mechanisms:fold,wrapper_support:false},"実行中の切替は未対応"],
    ["off",{mechanisms:none,policy:"off"},"off（新しい割込配送を停止）"],
    ["pending",{mechanisms:fold,revision:2,confirmed:false,pending:true,applied_revision:1},"確認待ち"],
  ] as const){
    changed.mockClear();
    loop.send("delivery_policy_changed",{version:"0",agent_id:"host.p",delivery_policy:{...deliveryView,...patch}});
    await vi.waitFor(()=>expect(changed).toHaveBeenCalledTimes(1));
    expect(deliveryPolicyLabel(changed.mock.calls[0]![1],true),name).toBe(label);
  }
});
