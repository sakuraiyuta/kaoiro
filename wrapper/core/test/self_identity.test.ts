import "../../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, expect, it, vi } from "vitest";
import { createPhoenixSocket } from "../src/phoenix_socket.js";
import { ServerLink } from "../src/transport.js";
import { phoenixLoopback } from "../../grok/test/fixtures/phoenix_loopback.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(response: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  reject?: () => Record<string, unknown> | undefined, onClose?: () => void) {
  const server = await phoenixLoopback(() => ({}), (event) => event === "directory_request" ? response() : {},
    event => event === "directory_request" ? reject?.() : undefined);
  const link = new ServerLink(server.url, "self.agent", { personaId: "default" }, onClose ? (...args) => {
    const socket = createPhoenixSocket(...args); socket.onClose(onClose); return socket;
  } : undefined);
  cleanups.push(async () => { link.close(); await server.close(); });
  await vi.waitFor(() => expect(server.joins).toBe(1));
  expect(await link.waitForReplyBasisMode()).toBe("legacy");
  return { server, link };
}

it("reads the current name with default transport wiring and preserves the self request shape", async () => {
  let name = "Original";
  const { server, link } = await setup(() => ({ self: { agent_id: "self.agent", display_name: name } }));
  expect(await link.requestSelfIdentity()).toEqual({ agent_id: "self.agent", display_name: "Original" });
  name = " Renamed ";
  expect(await link.requestSelfIdentity()).toEqual({ agent_id: "self.agent", display_name: "Renamed" });
  expect(server.received.filter(x => x.event === "directory_request").map(x => x.payload))
    .toEqual([{ version: "0", scope: "self" }, { version: "0", scope: "self" }]);
});

it.each([
  {}, { agents: [{ agent_id: "self.agent", display_name: "Legacy" }], users: [] },
  { self: null }, { self: [] }, { self: { agent_id: "another.agent", display_name: "Wrong" } },
])("does not accept a legacy or mismatched self reply: %j", async reply => {
  const { server, link } = await setup(() => reply);
  expect(await link.requestSelfIdentity()).toBeNull();
  expect(server.received.filter(x => x.event === "directory_request")).toHaveLength(1);
});

it.each([undefined, null, 1, "", "bad\nname", "x".repeat(65)])("omits an unusable name: %j", async display_name => {
  const { link } = await setup(() => ({ self: { agent_id: "self.agent", display_name } }));
  expect(await link.requestSelfIdentity()).toEqual({ agent_id: "self.agent" });
});

it("does not reuse a successful name after errors or an old-server response", async () => {
  let reply: Record<string, unknown> = { self: { agent_id: "self.agent", display_name: "Original" } };
  let error: Record<string, unknown> | undefined;
  const { link } = await setup(() => reply, () => error);
  expect((await link.requestSelfIdentity())?.display_name).toBe("Original");
  error = { reason: "self_identity_too_large" };
  expect(await link.requestSelfIdentity()).toBeNull();
  error = undefined; reply = { agents: [], users: [] };
  expect(await link.requestSelfIdentity()).toBeNull();
});

it("does not queue a self read while disconnected and reads anew after reconnect", async () => {
  let name = "Original";
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const { server, link } = await setup(() => ({ self: { agent_id: "self.agent", display_name: name } }), undefined, closed);
  expect((await link.requestSelfIdentity())?.display_name).toBe(name);
  server.drop();
  await disconnected;
  const count = server.received.filter(x => x.event === "directory_request").length;
  expect(await link.requestSelfIdentity()).toBeNull();
  name = "Renamed";
  await vi.waitFor(() => expect(server.joins).toBe(2), { timeout: 5000 });
  expect(await link.waitForReplyBasisMode()).toBe("legacy");
  expect((await link.requestSelfIdentity())?.display_name).toBe(name);
  expect(server.received.filter(x => x.event === "directory_request")).toHaveLength(count + 1);
});
