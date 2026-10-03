import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const outputDir = resolve(process.argv[2] ?? "");
if (process.argv[2] === undefined || outputDir === root) {
  throw new Error("usage: prepare-builder-validator.mjs OUTPUT_DIR");
}

mkdirSync(outputDir, { recursive: true });
const sourcePath = join(root, "wrapper/agent-common/src/inter_agent.ts");
const builtPath = join(root, "wrapper/agent-common/dist/inter_agent.js");
const packagePath = pathToFileURL(join(root, "wrapper/agent-common/dist/index.js")).href;
const { InterAgentTool } = await import(packagePath);

const config = {
  agent_id: "issue214.receiver",
  persona: { id: "issue214", name: "Issue 214", sprite_set: "issue214" },
  display_name: "Issue 214",
  server_url: "ws://127.0.0.1:1/wrapper",
  inter_agent_backlog_max_items: 100,
};
function inbound(deliverySeq, conversationId, turnNumber) {
  return {
    version: "0",
    agent_id: "issue214.sender",
    persona: { id: "issue214", name: "Issue 214", sprite_set: "issue214" },
    display_name: "Issue 214 sender",
    ts: "2026-10-03T00:00:00.000Z",
    type: "inter_agent_message",
    state: "thinking",
    payload: {
      to: config.agent_id,
      conversation_id: conversationId,
      turn_number: turnNumber,
      kind: "inform",
      body: `bounded-input-${deliverySeq}`,
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    delivery_seq: deliverySeq,
  };
}

async function buildNotice(sequence, turnNumber) {
  const builder = new InterAgentTool({
    config,
    getState: () => "idle",
    send: () => {},
    replyBasisMode: () => "v1",
  });

  for (let admitted = 1; admitted <= 100; admitted += 1) {
    const disposition = await builder.receiveInbound(
      inbound(admitted, `issue214-capacity-${sequence}-admitted-${admitted}`, 1),
    );
    if (!disposition.inject || disposition.overloaded === true) {
      throw new Error(`builder did not admit default-capacity item ${admitted}`);
    }
  }

  const refused = await builder.receiveInbound(
    inbound(sequence, `issue214-capacity-${sequence}`, turnNumber),
  );
  if (refused.overloaded !== true || refused.notice === undefined) {
    throw new Error(`builder did not produce the scoped overload notice at capacity for ${sequence}`);
  }
  return refused.notice;
}

const notices = [await buildNotice(101, 1), await buildNotice(102, 2)];

const payloadPath = join(outputDir, "payload.json");
const manifestPath = join(outputDir, "manifest.json");
const payloadBytes = Buffer.from(JSON.stringify(notices));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const gitRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const manifest = {
  git_revision: gitRevision,
  builder_source_path: "wrapper/agent-common/src/inter_agent.ts",
  builder_source_sha256: hash(readFileSync(sourcePath)),
  builder_build_path: "wrapper/agent-common/dist/inter_agent.js",
  builder_build_sha256: hash(readFileSync(builtPath)),
  payload_path: basename(payloadPath),
  payload_sha256: hash(payloadBytes),
};

writeFileSync(payloadPath, payloadBytes);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`generated current builder payload: ${payloadPath}\n`);
