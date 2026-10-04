import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";

// Test-only Phoenix v2 JSON peer that goes down the way a restarting server
// behind a proxy does: it closes its sockets with a code, then refuses
// connections, answers upgrades with 502, or accepts them and stays silent
// for a while, and then comes back on the same port.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type OutageMode = "refuse" | "502" | "silent";

export interface WireEvent {
  topic: string;
  event: string;
  payload: unknown;
}

function encodeText(text: string): Buffer {
  const payload = Buffer.from(text);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

/** Pops one complete client frame (always masked) off `buffer`. */
function takeFrame(
  buffer: Buffer,
): { opcode: number; text: string; rest: Buffer } | undefined {
  if (buffer.length < 2) return undefined;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + 4 + length) return undefined;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let i = 0; i < payload.length; i += 1) payload[i]! ^= mask[i % 4]!;
  return {
    opcode: buffer[0]! & 0x0f,
    text: payload.toString("utf8"),
    rest: buffer.subarray(offset + 4 + length),
  };
}

export async function startPhoenixOutageServer(
  joinReply: (topic: string) => Record<string, unknown> = () => ({}),
) {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const live = new Set<Duplex>();
  const silent = new Set<Duplex>();
  const events: WireEvent[] = [];
  let down: OutageMode | null = null;

  server.on("upgrade", (request, socket) => {
    socket.on("error", () => {});
    if (down === "502") {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    if (down === "silent") {
      // Held until close(), even after the outage: the client's attempt has
      // to end through its own handshake bound, not through an RST or EOF.
      silent.add(socket);
      return;
    }
    live.add(socket);
    socket.on("close", () => live.delete(socket));
    const key = String(request.headers["sec-websocket-key"] ?? "");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${createHash("sha1").update(key + WS_GUID).digest("base64")}\r\n\r\n`,
    );
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let frame = takeFrame(buffer); frame !== undefined; frame = takeFrame(buffer)) {
        buffer = frame.rest;
        if (frame.opcode === 8) {
          socket.end();
          return;
        }
        if (frame.opcode !== 1) continue;
        const [joinRef, ref, topic, event, payload] = JSON.parse(frame.text) as [
          string | null,
          string | null,
          string,
          string,
          unknown,
        ];
        events.push({ topic, event, payload });
        if (ref !== null) {
          const response = event === "phx_join" ? joinReply(topic) : {};
          socket.write(encodeText(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response }])));
        }
      }
    });
  });

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(new Error(`outage server could not listen on ${port}: ${error.message}`));
      server.once("error", fail);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", fail);
        resolve();
      });
    });

  await listen(0);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const port = address.port;

  return {
    url: (path: string) => `ws://127.0.0.1:${port}${path}`,
    events,
    count: (event: string, topicPrefix = "") =>
      events.filter((e) => e.event === event && e.topic.startsWith(topicPrefix)).length,

    /** Stops accepting (per `mode`), closes every live socket with `code`,
     *  waits `ms`, and accepts again. */
    async outage(mode: OutageMode, ms: number, code = 1012): Promise<void> {
      if (mode === "refuse") server.close();
      else down = mode;
      for (const socket of live) {
        socket.write(Buffer.from([0x88, 0x02, code >> 8, code & 0xff]));
        setTimeout(() => socket.destroy(), 50);
      }
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (mode === "refuse") await listen(port);
      else down = null;
    },

    async close(): Promise<void> {
      for (const socket of [...live, ...silent]) socket.destroy();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
