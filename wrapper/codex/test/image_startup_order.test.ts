import "../../../scripts/test/fixtures/test-isolation.mjs";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { CodexHost } from "../src/host.js";
import { tempDirPrefix } from "../src/upload.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function config(): WrapperConfig {
  return { agent_id: `image-order-${randomUUID()}`,
    persona: { id: "test", name: "Test", sprite_set: "test" },
    display_name: "Test", server_url: "ws://unused" };
}

function attachImage(host: CodexHost, bytes: Buffer): void {
  host.attachOpen({ upload_id: "image", filename: "image.png", mime: "image/png", size: bytes.length, chunks: 1 });
  const chunk = Buffer.alloc(4 + 5 + 4 + bytes.length);
  chunk.writeUInt32BE(5, 0);chunk.write("image", 4);chunk.writeUInt32BE(0, 9);bytes.copy(chunk, 13);
  host.attachChunk(chunk);host.attachClose("image");
}

it("keeps the image operation chain usable after a rejected materialization", async () => {
  const identity = config(), bytes = Buffer.from("retry-content");
  let attempts = 0, dir = "", path = "";
  const rejected: unknown[] = [];
  const host = new CodexHost(identity, {
    appendSystemPrompt: "Test", onState: () => {},
    onInstructionRejected: event => rejected.push(event),
    materializeImages: async (agentId, _uploads, lifecycle) => {
      if (++attempts === 1) throw new Error("fixture materialization error");
      dir = await mkdtemp(join(tmpdir(), tempDirPrefix(agentId)));
      lifecycle.onDirectoryCreated(dir);
      path = join(dir, "image.png");await writeFile(path, bytes);
      return { dir, paths: [path] };
    },
  });
  try {
    attachImage(host, bytes);
    await host.send("FIRST", ["image"]);
    expect(rejected).toHaveLength(1);
    await host.send("SECOND", ["image"]);
    expect(attempts).toBe(2);
    expect(await readFile(path)).toEqual(bytes);
  } finally {
    host.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
