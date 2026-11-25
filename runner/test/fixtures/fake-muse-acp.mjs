#!/usr/bin/env node
// A stand-in for `muse acp` in runner discovery tests. The scenario file
// (FAKE_MUSE_SCENARIO) decides the answers:
//   pages:     { "<cursor or __first__>": result | { error: code } }
//   hang:      never answer session/list
//   initError: answer initialize with this JSON-RPC error code
// Every request is appended to FAKE_MUSE_LOG as JSON lines.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = JSON.parse(readFileSync(process.env.FAKE_MUSE_SCENARIO, "utf8"));
const log = process.env.FAKE_MUSE_LOG;
const reply = (id, body) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (log) appendFileSync(log, `${JSON.stringify({ method: msg.method, params: msg.params ?? {} })}\n`);
  if (msg.method === "initialize") {
    if (scenario.initError !== undefined) {
      reply(msg.id, { error: { code: scenario.initError, message: "fixture init error" } });
    } else {
      reply(msg.id, { result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    }
    return;
  }
  if (msg.method === "session/list") {
    if (scenario.hang) return;
    const key = msg.params.cursor ?? "__first__";
    const page = scenario.pages?.[key];
    if (page === undefined) {
      reply(msg.id, { error: { code: -32602, message: "no such page" } });
    } else if (typeof page === "object" && page !== null && "error" in page) {
      reply(msg.id, { error: { code: page.error, message: "fixture list error" } });
    } else {
      reply(msg.id, { result: page });
    }
  }
});
