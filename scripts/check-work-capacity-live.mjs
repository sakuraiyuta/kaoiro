import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { ServerLink } from "../wrapper/core/dist/transport.js";
import { InterAgentTool } from "../wrapper/agent-common/dist/inter_agent.js";

// The browser, Phoenix client and wrapper connect to the same disposable release.
const requireDashboard = createRequire(resolve("dashboard/package.json"));
const { chromium } = requireDashboard("@playwright/test");
const { Socket } = requireDashboard("phoenix");
const release = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), "kogane-work-capacity-live-"));
const state = join(root, "state");
mkdirSync(state);
const token = randomBytes(24).toString("hex");
const viewerToken = randomBytes(24).toString("hex");
const wrapperToken = randomBytes(24).toString("hex");
const port = 42786;
const url = `http://127.0.0.1:${port}`;
let server;
let serverLog = "";
let browser;
const sockets = [];
const links = [];
const frames = [];
const NativeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NativeWebSocket {
  constructor(...args) {
    super(...args);
    this.addEventListener("message", event => {
      try { frames.push(JSON.parse(String(event.data))); } catch { /* Non-JSON frames are irrelevant. */ }
    });
  }
};
async function until(predicate, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`timed out: ${label}`);
}
async function start() {
  const env = { ...process.env, TMPDIR: state, PHX_SERVER: "true", PORT: String(port),
    PHX_HOST: "127.0.0.1", KAOIRO_PLAIN_HTTP: "true",
    SECRET_KEY_BASE: randomBytes(64).toString("hex"),
    KAOIRO_CLIENT_TOKENS: `${token}:operator,${viewerToken}:viewer`,
    KAOIRO_WRAPPER_TOKENS: `capacity.sender:${wrapperToken},capacity.recipient:${wrapperToken}`,
    KAOIRO_WORK_STORE_PATH: join(state, "stores", "work.dets"),
  };
  delete env.KAOIRO_WORK_NOMINATED_PER_PRINCIPAL;
  delete env.KAOIRO_WORK_ACTIVE_PER_ASSIGNEE;
  server = spawn(release, ["start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", data => { serverLog += data; });
  server.stderr.on("data", data => { serverLog += data; });
  await until(async () => {
    if (server.exitCode !== null) throw new Error(`release exited ${server.exitCode}`);
    try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; }
  }, "release health");
}
async function stop() {
  if (server && server.exitCode === null) {
    const closed = once(server, "exit");
    server.kill("SIGTERM");
    await closed;
  }
}
function push(channel, event, payload) {
  return new Promise((resolve, reject) => channel.push(event, { version: "0", ...payload }, 10000)
    .receive("ok", response => resolve({ status: "ok", response }))
    .receive("error", response => resolve({ status: "error", response }))
    .receive("timeout", () => reject(new Error(`channel timeout: ${event}`))));
}
async function client(context, credential) {
  assert.equal((await context.request.post(`${url}/session/new`, { data: { token: credential } })).status(), 204);
  const { ticket } = await (await context.request.get(`${url}/session/ticket`)).json();
  const socket = new Socket(`${url}/client`, { params: { ticket }, transport: globalThis.WebSocket });
  sockets.push(socket);
  const channel = socket.channel("agents:lobby", {});
  const settings = [];
  channel.on("work_settings", value => settings.push(value));
  socket.connect();
  await new Promise((resolve, reject) => channel.join().receive("ok", resolve).receive("error", reject));
  return { channel, settings };
}
function operation() {
  return { op: "assign", operation_id: `op_${Date.now()}_${randomBytes(16).toString("base64url")}`,
    title: "Live capacity probe", director: { kind: "agent", id: "capacity.sender" }, assignee: "capacity.recipient" };
}
try {
  await start();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const operatorContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  const operator = await client(operatorContext, token);
  const viewer = await client(viewerContext, viewerToken);
  await until(() => operator.settings.length === 1, "operator initial snapshot");
  assert.equal(viewer.settings.length, 0, "viewer receives no join-time settings");
  const page = await operatorContext.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  const section = page.getByRole("region", { name: "Work admission settings" });
  const input = section.getByLabel("指名待ちの上限（依頼者・担当者ごと）", { exact: true });
  await input.waitFor();

  for (const id of ["capacity.sender", "capacity.recipient"]) {
    const link = new ServerLink(`${url.replace("http", "ws")}/wrapper`, id, {
      personaId: "default", token: wrapperToken, workControl: "v1",
    });
    links.push(link);
    await until(() => link.workControlSupported(), `wrapper ${id} joined`);
    link.send({ version: "0", agent_id: id, persona: { id: "default", name: "Probe", sprite_set: "default" },
      ts: new Date().toISOString(), type: "state_change", state: "idle", payload: {}, ext: {} });
  }
  const sender = links[0];
  await until(async () => (await sender.requestDirectory()).agents.some(agent => agent.agent_id === "capacity.recipient"), "real peer directory");
  const tool = new InterAgentTool({
    config: { agent_id: "capacity.sender", persona: { id: "default", name: "Probe", sprite_set: "default" }, server_url: `${url}/wrapper` },
    getState: () => "idle", send: envelope => sender.send(envelope),
    sendInterAgent: envelope => sender.sendInterAgent(envelope),
    requestDirectory: () => sender.requestDirectory(),
    workTools: { workControlSupported: () => sender.workControlSupported() },
  });
  const nominate = () => tool.invoke({ to: "capacity.recipient", kind: "request", body: "Capacity probe", done: false,
    work_control: { op: "assign", title: "Live nomination" } });
  for (let index = 0; index < 16; index++) {
    const result = await nominate();
    assert.ok(!result.isError, `nomination ${index + 1}: ${JSON.stringify(result)}`);
  }
  const refusal = await nominate();
  assert.equal(refusal.isError, true, "17th real nomination must refuse");
  const text = refusal.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  console.log("MCP_NOMINATION_REFUSAL", text);
  const rawRefusal = frames.find(frame => frame[4]?.response?.reason === "work_capacity");
  console.log("RAW_NOMINATION_REFUSAL", JSON.stringify(rawRefusal?.[4]));
  assert.match(text, /work_capacity/);
  assert.match(text, /work_nominated_per_principal/, "MCP must retain the real nomination limit");
  assert.match(text, /director/, "MCP must retain the nomination scope");
  assert.match(text, /16/, "MCP must retain the nomination maximum");
  assert.deepEqual(rawRefusal?.[4].response.details.capacity,
    { limit: "work_nominated_per_principal", scope: "director", maximum: 16 });

  await input.fill("0");
  await section.getByRole("button", { name: "保存", exact: true }).click();
  await until(() => operator.settings.some(value => value.revision === 1), "operator committed settings");
  await page.waitForTimeout(150);
  assert.equal(viewer.settings.length, 0, "intercept must exclude the real viewer socket after the operator observed commit");
  const admitted = await nominate();
  assert.ok(!admitted.isError, `UI-saved zero must affect live admission: ${JSON.stringify(admitted)}`);
  const activeInput = section.getByLabel("実行中の上限（担当者ごと）", { exact: true });
  await activeInput.fill("1");
  await section.getByRole("button", { name: "保存", exact: true }).click();
  await until(() => operator.settings.some(value => value.revision === 2), "active limit commit");
  assert.equal((await push(operator.channel, "work_control", { work_control: operation() })).status, "ok");
  const activeRefusal = await push(operator.channel, "work_control", { work_control: operation() });
  console.log("RAW_OPERATOR_REFUSAL", JSON.stringify(activeRefusal));
  assert.deepEqual(activeRefusal, { status: "error", response: { reason: "work_capacity", details: {
    capacity: { limit: "work_active_per_assignee", scope: "assignee", maximum: 1 },
  } } }, "AgentsChannel must retain actual operator capacity diagnostic");

  for (const socket of sockets.splice(0)) socket.disconnect();
  for (const link of links.splice(0)) link.close();
  await stop();
  await start();
  const rejoined = await client(operatorContext, token);
  const snapshot = await push(rejoined.channel, "get_work_settings", {});
  assert.equal(snapshot.response.revision, 2);
  assert.equal(snapshot.response.effective.work_nominated_per_principal, 0);
  assert.equal(snapshot.response.effective.work_active_per_assignee, 1);
  assert.equal(snapshot.response.changes.length, 2);
  const afterRestart = await push(rejoined.channel, "work_control", { work_control: operation() });
  assert.equal(afterRestart.response.reason, "work_capacity", "saved setting must enforce admission after full release restart");
  console.log("WORK_CAPACITY_LIVE_PASS browser=save admission=live MCP=actual-channel restart=persistent viewer=excluded");
} catch (error) {
  console.error(serverLog.replaceAll(token, "[redacted]").replaceAll(viewerToken, "[redacted]").replaceAll(wrapperToken, "[redacted]"));
  throw error;
} finally {
  for (const socket of sockets) socket.disconnect();
  for (const link of links) link.close();
  await browser?.close();
  await stop();
  globalThis.WebSocket = NativeWebSocket;
  rmSync(root, { recursive: true, force: true });
}
