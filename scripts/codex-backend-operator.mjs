import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export async function openOperator(file) {
  let config;
  const valid = (s) => s.isFile() && !s.isSymbolicLink() && s.uid === process.geteuid?.() && (s.mode & 0o7777) === 0o600;
  const before = await lstat(file);
  if (!valid(before)) throw new Error("operator-config-invalid");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!valid(current) || current.ino !== before.ino || current.dev !== before.dev) throw new Error("operator-config-invalid");
    config = JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  if (!config || typeof config.token !== "string" || !config.token || typeof config.server_url !== "string"
    || Object.keys(config).some(key => !["server_url", "token"].includes(key))) throw new Error("operator-config-invalid");
  const url = new URL(config.server_url);
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== "/client/websocket") throw new Error("operator-config-invalid");
  url.searchParams.set("token", config.token);
  url.searchParams.set("vsn", "2.0.0");
  const socket = new WebSocket(url);
  const pending = new Map();
  let ref = 0, closed = false, heartbeat, restored = false;
  const fail = () => {
    closed = true;
    clearInterval(heartbeat);
    for (const waiter of pending.values()) waiter.reject(new Error("operator-unavailable"));
    pending.clear();
  };
  const close = () => { fail(); socket.close(); };
  socket.addEventListener("error", fail);
  socket.addEventListener("close", fail);
  const joinRef = "1";
  socket.addEventListener("message", ({ data }) => {
    let frame;
    try { frame = JSON.parse(data); } catch { close(); return; }
    if (!Array.isArray(frame) || frame.length !== 5) { close(); return; }
    const [joined, replyRef, topic, event, payload] = frame;
    const waiter = pending.get(replyRef);
    if (!waiter || topic !== waiter.topic || joined !== waiter.joinRef || event !== "phx_reply") return;
    if (payload?.status === "ok") waiter.resolve();
    else waiter.reject(new Error("operator-rejected"));
  });
  const request = (topic, event, payload, joined = joinRef) => new Promise((resolve, reject) => {
    if (closed || socket.readyState !== WebSocket.OPEN) { reject(new Error("operator-unavailable")); return; }
    const id = String(++ref);
    const finish = (callback, value) => { clearTimeout(timer); pending.delete(id); callback(value); };
    const timer = setTimeout(() => { finish(reject, new Error("operator-timeout")); close(); }, 10_000);
    pending.set(id, { topic, joinRef: joined, resolve: () => finish(resolve), reject: error => finish(reject, error) });
    try { socket.send(JSON.stringify([joined, id, topic, event, payload])); }
    catch { finish(reject, new Error("operator-unavailable")); close(); }
  });
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); socket.removeEventListener("open", opened); socket.removeEventListener("error", failed); socket.removeEventListener("close", failed); };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error("operator-unavailable")); };
      const timer = setTimeout(failed, 10_000);
      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
    });
    await request("agents:lobby", "phx_join", {});
    heartbeat = setInterval(() => { request("phoenix", "heartbeat", {}, null).catch(close); }, 25_000);
    return {
      async restore(agent) {
        if (restored) throw new Error("restore-already-sent");
        restored = true;
        await request("agents:lobby", "restore", { version: "0", agent_id: agent });
      },
      close,
    };
  } catch { close(); throw new Error("operator-unavailable"); }
}
