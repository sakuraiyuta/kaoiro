import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

// Test-only Phoenix JSON wire peer. ServerLink and its WebSocket transport stay real.
export async function phoenixLoopback(
  joinReply: (joins: number) => Record<string, unknown> = () => ({ permission_sync: true }),
  reply: (event: string, payload: Record<string, unknown>) => Record<string, unknown> = () => ({}),
) {
  const server = createServer();
  const sockets = new Set<Duplex>();
  const received: Array<{ event: string; payload: Record<string, unknown> }> = [];
  let joined: { socket: Duplex; ref: string; topic: string } | undefined, joins = 0;
  const frame = (socket: Duplex, value: unknown) => {
    const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(body.length < 126 ? 2 : 4);
    header[0] = 0x81;header[1] = body.length < 126 ? body.length : 126;
    if (body.length >= 126) header.writeUInt16BE(body.length, 2);
    socket.write(Buffer.concat([header, body]));
  };
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);socket.on("close", () => sockets.delete(socket));socket.on("error", () => {});
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 15, masked = (buffer[1]! & 128) !== 0;
        let length = buffer[1]! & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return;length = buffer.readUInt16BE(2);offset = 4; }
        if (length === 127) { if (buffer.length < 10) return;length = Number(buffer.readBigUInt64BE(2));offset = 10; }
        const maskOffset = offset;if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const body = Buffer.from(buffer.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ buffer[maskOffset + i % 4]!;
        buffer = buffer.subarray(offset + length);
        if (opcode === 8) { socket.end();return; }
        if (opcode !== 1) continue;
        const [joinRef, ref, topic, event, payload] = JSON.parse(body.toString()) as [string, string, string, string, Record<string, unknown>];
        received.push({ event, payload });
        if (event === "phx_join") { joins += 1;joined = { socket, ref: joinRef, topic }; }
        frame(socket, [joinRef, ref, topic, "phx_reply", { status: "ok", response: event === "phx_join" ? joinReply(joins) : reply(event, payload) }]);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();if (!address || typeof address === "string") throw new Error("No socket port");
  return {
    url: `ws://127.0.0.1:${address.port}/wrapper`, received, get joins() { return joins; },
    push(event: string, payload: Record<string, unknown>) {
      if (!joined) throw new Error("No joined socket");
      frame(joined.socket, [joined.ref, null, joined.topic, event, payload]);
    },
    drop() { joined?.socket.destroy(); },
    async close() { for (const socket of sockets) socket.destroy();await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
