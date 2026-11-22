#!/usr/bin/env node
// Sends one raw HTTP/1.1 request to 127.0.0.1 from its own process and prints
// what came back as one JSON line. The request is written by hand, so a test
// can send what a client library would not: a body that never arrives, a
// declared length it never sends, or a chunked stream of any size.
//
// The JSON spec arrives on stdin (a large body does not fit in argv):
//   port, head (the request line and headers, CRLF-terminated, ending with the
//   blank line), body (text), bodyRepeat ({ char, count }), chunked (wrap the
//   body in chunked framing), leaveOpen (send the head only), timeoutMs.
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

const spec = JSON.parse(readFileSync(0, "utf8"));
const started = Date.now();
const socket = createConnection({ host: "127.0.0.1", port: spec.port });
let received = Buffer.alloc(0);
let settled = false;
let writeError;
const finish = (extra = {}) => {
  if (settled) return;
  settled = true;
  const text = received.toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  const headText = split === -1 ? text : text.slice(0, split);
  const lines = headText.split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "");
  process.stdout.write(
    JSON.stringify({
      status: status ? Number(status[1]) : null,
      headers: Object.fromEntries(
        lines.slice(1).map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
        }),
      ),
      body: split === -1 ? "" : text.slice(split + 4),
      elapsedMs: Date.now() - started,
      ...(writeError ? { writeError } : {}),
      ...extra,
    }) + "\n",
  );
  socket.destroy();
  process.exit(0);
};
socket.on("error", (error) => {
  if (received.length === 0 && !socket.connecting && writeError === undefined) {
    writeError = error.code ?? String(error);
  }
  if (error.code === "ECONNREFUSED") finish({ refused: true });
  else if (received.length > 0) finish();
});
socket.on("close", () => finish({ closed: true }));
socket.on("data", (chunk) => {
  received = Buffer.concat([received, chunk]);
  const text = received.toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  if (split === -1) return;
  const length = /content-length:\s*(\d+)/i.exec(text.slice(0, split));
  if (length && Buffer.byteLength(text.slice(split + 4)) >= Number(length[1])) {
    finish();
  }
});
setTimeout(() => finish({ timedOut: true }), spec.timeoutMs ?? 5000);
socket.on("connect", () => {
  socket.write(spec.head);
  if (spec.leaveOpen) return;
  const frame = (data) =>
    spec.chunked
      ? Buffer.concat([
          Buffer.from(`${data.length.toString(16)}\r\n`),
          data,
          Buffer.from("\r\n"),
        ])
      : data;
  if (spec.body !== undefined) socket.write(frame(Buffer.from(spec.body)));
  if (spec.bodyRepeat) {
    const piece = Buffer.alloc(64 * 1024, spec.bodyRepeat.char);
    let left = spec.bodyRepeat.count;
    const pump = () => {
      while (left > 0) {
        const part = piece.subarray(0, Math.min(piece.length, left));
        left -= part.length;
        if (!socket.write(frame(part))) {
          socket.once("drain", pump);
          return;
        }
      }
      if (spec.chunked) socket.write("0\r\n\r\n");
    };
    pump();
  } else if (spec.chunked) {
    socket.write("0\r\n\r\n");
  }
});
