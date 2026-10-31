import "./fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openOperator } from "../codex-backend-operator.mjs";

const { WebSocketServer } = createRequire(new URL("../../runner/package.json", import.meta.url))("ws");
async function fixture(t, reply = payload => payload) {
  const root = await mkdtemp(join(tmpdir(), "kogane564-operator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => server.once("listening", resolve));
  const frames = [], clients = new Set();
  t.after(async () => { for (const c of clients) c.terminate(); await new Promise(resolve => server.close(resolve)); });
  server.on("connection", (socket, request) => {
    clients.add(socket); socket.on("close", () => clients.delete(socket));
    assert.equal(new URL(request.url, "http://localhost").searchParams.get("token"), "synthetic-operator-token");
    socket.on("message", bytes => {
      const frame = JSON.parse(bytes); frames.push(frame);
      const [joined, ref, topic] = frame;
      const response = reply([joined, ref, topic, "phx_reply", { status: "ok", response: {} }], frame, socket);
      if (response) socket.send(JSON.stringify(response));
    });
  });
  const file = join(root, "operator.json");
  const config = { server_url: `ws://127.0.0.1:${server.address().port}/client/websocket`, token: "synthetic-operator-token" };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  return { root, file, config, frames };
}

test("operator adapter joins and sends one normal restore without a resume payload", async t => {
  const f = await fixture(t), connection = await openOperator(f.file);
  try {
    await connection.restore("maintenance.codex");
    await assert.rejects(connection.restore("maintenance.codex"), /restore-already-sent/);
    assert.deepEqual(f.frames.map(frame => frame.slice(2)), [
      ["agents:lobby", "phx_join", {}], ["agents:lobby", "restore", { version: "0", agent_id: "maintenance.codex" }],
    ]);
    assert.equal(f.frames[0][1], "1"); assert.equal(f.frames[1][1], "2");
  } finally { connection.close(); }
});

test("operator adapter refuses mode, owner, symlink and directory before parsing their content", async t => {
  const f = await fixture(t);
  await writeFile(f.file, "not json");
  await chmod(f.file, 0o644);
  await assert.rejects(openOperator(f.file), /operator-config-invalid/);
  await chmod(f.file, 0o600);
  t.mock.method(process, "geteuid", () => 2147483646);
  await assert.rejects(openOperator(f.file), /operator-config-invalid/);
  t.mock.restoreAll();
  const link = join(f.root, "link"); await symlink(f.file, link);
  await assert.rejects(openOperator(link), /operator-config-invalid/);
  await assert.rejects(openOperator(f.root), /operator-config-invalid/);
  assert.equal(f.frames.length, 0);
});

test("operator adapter checks the opened descriptor again before reading", async t => {
  const f = await fixture(t); await writeFile(f.file, "not json");
  const uid = process.geteuid(); let calls = 0;
  t.mock.method(process, "geteuid", () => ++calls === 1 ? uid : 2147483646);
  await assert.rejects(openOperator(f.file), /operator-config-invalid/);
  assert.equal(calls, 2);
});

test("operator adapter refuses URL credentials and unexpected config keys before connecting", async t => {
  const f = await fixture(t);
  for (const config of [{ ...f.config, server_url: f.config.server_url + "?token=private" },
    { ...f.config, server_url: f.config.server_url.replace("ws://", "ws://private@") }, { ...f.config, extra: true }]) {
    await writeFile(f.file, JSON.stringify(config));
    await assert.rejects(openOperator(f.file), /operator-config-invalid/);
  }
  assert.equal(f.frames.length, 0);
});

test("operator adapter ignores an unrelated reply and rejects the matching denial", async t => {
  const f = await fixture(t, (response, frame, socket) => {
    if (frame[3] === "restore") {
      socket.send(JSON.stringify([frame[0], "unrelated", frame[2], "phx_reply", { status: "ok" }]));
      response[4].status = "error";
    }
    return response;
  });
  const connection = await openOperator(f.file);
  try { await assert.rejects(connection.restore("maintenance.codex"), /operator-rejected/); }
  finally { connection.close(); }
  assert.equal(f.frames.length, 2);
});

test("operator adapter does not reconnect or resend after connection loss", async t => {
  const f = await fixture(t, (response, frame, socket) => {
    if (frame[3] === "restore") { socket.close(); return null; }
    return response;
  });
  const connection = await openOperator(f.file);
  try { await assert.rejects(connection.restore("maintenance.codex"), /operator-unavailable/); }
  finally { connection.close(); }
  assert.equal(f.frames.length, 2);
});
