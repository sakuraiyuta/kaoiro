#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const { CASE, GATE, LOG } = process.env;
const argv = process.argv.slice(2);
const grok = argv.includes("agent");

if (CASE === "slow-exit") {
  const stayAlive = setInterval(() => {}, 1_000);
  process.on("SIGTERM", () => {
    clearInterval(stayAlive);
    appendFileSync(LOG, '{"method":"terminating"}\n');
    setTimeout(() => process.exit(0), 250);
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(LOG, `${JSON.stringify({ argv, pid: process.pid, ...request })}\n`);
  const reply = (result) => process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
  );
  const afterGate = (action) => {
    const interval = setInterval(() => {
      if (!existsSync(GATE)) return;
      clearInterval(interval);
      action();
    }, 10);
  };
  if (grok && request.method === "initialize") {
    afterGate(() => reply({ _meta: { modelState: {
      currentModelId: "grok-fixture",
      availableModels: [{ modelId: "grok-fixture", name: "Grok" }],
    } } }));
  } else if (request.method === "initialize") {
    reply({});
  } else if (request.method === "model/list") {
    if (CASE === "exit") process.exit(0);
    if (CASE === "hang") return;
    afterGate(() => reply({
      providerId: "meta",
      source: CASE === "source" ? "bundled" : "providerCatalog",
      models: CASE === "malformed" ? [{ modelId: "Default" }]
        : CASE === "empty" ? []
        : [{ modelId: "muse-spark-1.2", isDefault: true,
          variants: ["low", "high", "future"] },
        { modelId: "muse-ember-1.0" }],
    }));
  }
});
