import { createServer } from "node:http";
import { createRequire } from "node:module";
export const { WebSocket: LoopbackWebSocket, WebSocketServer } = createRequire(import.meta.url)("ws") as typeof import("ws");
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { launchDeliveryContract } from "./fixtures/launchDeliveryContract";
export const deliveryModes = { ...launchDeliveryContract.launch_delivery_policy.mechanisms } as { operator_early: string; inter_agent_early: string; inter_agent_yield: string };
export const deliveryView = { policy: "on", revision: 1, applied_revision: 1, confirmed: true, pending: false,
  wrapper_support: true, mechanisms: deliveryModes };
export const deliveryAgent = { version: "0", agent_id: "host.p", persona: { id: "p", name: "Policy", sprite_set: "p" },
  ts: "2026-10-09T00:00:00Z", type: "state_change", state: "idle", payload: {}, ext: { engine: "codex", delivery_policy: deliveryView } };
export const deliveryHosts = { host: { personas: [deliveryAgent.persona], cwd_allowlist: ["/test"], capabilities: ["codex"],
  in_flight_defaults: { ...launchDeliveryContract.in_flight_defaults }, engines: [{ id: "codex", models: [{ value: "sample", display_name: "Sample" }],
    launch_delivery_policy: { ...launchDeliveryContract.launch_delivery_policy, mechanisms: deliveryModes } }] } };
export async function deliveryLoopback(staticRoot?: string) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/session/ticket") { res.setHeader("content-type", "application/json"); res.end('{"ticket":"local-test"}'); return; }
    if (path === "/session/auth-methods") { res.setHeader("content-type", "application/json"); res.end('{"token":true,"oauth":[]}'); return; }
    if (staticRoot && (path === "/" || path.startsWith("/assets/"))) {
      try {
        const file = path === "/" ? "index.html" : path.slice(1);
        res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
        res.end(await readFile(join(staticRoot, file))); return;
      } catch { res.statusCode = 404; res.end(); return; }
    }
    res.setHeader("content-type", "application/json"); res.end('{}');
  });
  const wss = new WebSocketServer({ server });
  const frames: unknown[][] = [];
  let peer: { send: (data: string) => void; close: () => void } | undefined;
  let joinRef: unknown = null;
  const state = { operator: true, marker: "v1" as unknown, automatic: true, policy: { ...deliveryView }, hosts: deliveryHosts };
  function send(event: string, payload: unknown) { peer?.send(JSON.stringify([joinRef, null, "agents:lobby", event, payload])); }
  function reply(frame: unknown[], response: unknown, status = "ok") {
    peer?.send(JSON.stringify([frame[0], frame[1], frame[2], "phx_reply", { status, response }]));
  }
  function snapshot() {
    send("snapshot", { version: "0", agents: { "host.p": { ...deliveryAgent, ext: { engine: "codex", delivery_policy: state.policy } } } });
    if (state.operator) send("hosts", { version: "0", hosts: state.hosts });
  }
  wss.on("connection", (ws) => {
    peer = ws;
    ws!.on("message", data => {
      const frame = JSON.parse(data.toString()) as unknown[]; frames.push(frame);
      const payload = frame[4] as Record<string, unknown>;
      if (frame[3] === "phx_join") { joinRef = frame[0]; reply(frame, state.marker ? { delivery_policy_control: state.marker } : {}); snapshot(); }
      else if (frame[3] === "heartbeat" || frame[3] === "phx_leave") reply(frame, {});
      else if (frame[3] === "get_delivery_policy" && state.automatic) reply(frame, { agent_id: payload.agent_id, delivery_policy: state.policy });
      else if (frame[3] === "set_delivery_policy" && state.automatic) {
        if (payload.expected_revision !== state.policy.revision) reply(frame, { reason: "revision_conflict", current_revision: state.policy.revision, policy: state.policy.policy }, "error");
        else {
          state.policy = { ...state.policy, policy: payload.policy as string, revision: state.policy.revision + 1, confirmed: false, pending: true };
          reply(frame, { revision: state.policy.revision, status: "pending" });
          send("delivery_policy_changed", { version: "0", agent_id: payload.agent_id, delivery_policy: state.policy });
        }
      } else if (frame[3] === "launch_defaults") reply(frame, { defaults: {} });
      else if (frame[3] === "spawn") reply(frame, { agent_id: "host.new" });
      else if (state.automatic) reply(frame, {});
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}`, frames, state, send, reply, snapshot,
    closePeer: () => peer?.close(),
    close: async () => { for (const client of wss.clients) client.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); } };
}
