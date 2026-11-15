import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { get } from "node:http";

const [marker, barrier] = process.argv.slice(2);
const send = (id, result) => process.stdout.write(
  JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n",
);
createInterface({ input: process.stdin }).on("line", async line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send(message.id, { protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "yield", version: "1" } });
  } else if (message.method === "tools/list") {
    send(message.id, { tools: ["slow", "late"].map(name => ({ name,
      description: "Owned yield barrier", inputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false } })) });
  } else if (message.method === "tools/call") {
    appendFileSync(marker, JSON.stringify({ name: message.params.name,
      event: "start", at: Date.now() }) + "\n");
    await new Promise(resolve => get(barrier, response => {
      response.resume(); response.once("end", resolve);
    }));
    appendFileSync(marker, JSON.stringify({ name: message.params.name,
      event: "end", at: Date.now() }) + "\n");
    send(message.id, { content: [{ type: "text", text: "STDIO521-COMPLETE" }] });
  } else send(message.id, {});
});
