import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { CodexHost } from "../src/host.js";
import { sweepOrphanLocalImages, tempDirPrefix } from "../src/upload.js";

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

it("keeps an image readable when send enters materialization before the startup sweep", async () => {
  const identity = config(), bytes = Buffer.from("image-order-content");
  const created = deferred(), releaseMaterialize = deferred(), releaseSession = deferred();
  let dir = "", path = "", sweepCount = 0;
  const host = new CodexHost(identity, {
    backend: "app-server", appendSystemPrompt: "Test", onState: () => {},
    materializeImages: async (agentId, _uploads, lifecycle) => {
      dir = await mkdtemp(join(tmpdir(), tempDirPrefix(agentId)));
      path = join(dir, "image.png");created.resolve();
      await releaseMaterialize.promise;
      lifecycle.onDirectoryCreated(dir);
      await writeFile(path, bytes);
      return { dir, paths: [path] };
    },
    sweepImages: async (...args) => { sweepCount += 1;await sweepOrphanLocalImages(...args); },
    appServerSessionFactory: async () => { await releaseSession.promise;throw new Error("fixture stopped"); },
  });
  attachImage(host, bytes);
  const sending = host.send("TURN", ["image"]);
  const running = host.run();
  try {
    await created.promise;
    expect(sweepCount).toBe(0);
    releaseMaterialize.resolve();
    await sending;
    await vi.waitFor(() => expect(sweepCount).toBe(1));
    expect(await readFile(path)).toEqual(bytes);
  } finally {
    releaseMaterialize.resolve();releaseSession.resolve();
    host.close();await running;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

it("waits for a startup sweep before materializing a later image", async () => {
  const identity = config(), bytes = Buffer.from("later-image-content");
  const sweeping = deferred(), releaseSweep = deferred(), releaseTurn = deferred();
  let materializeCount = 0, dir = "", path = "";
  const host = new CodexHost(identity, {
    backend: "exec", appendSystemPrompt: "Test", onState: () => {},
    sweepImages: async (...args) => {
      sweeping.resolve();await releaseSweep.promise;
      await sweepOrphanLocalImages(...args);
    },
    materializeImages: async (agentId, _uploads, lifecycle) => {
      materializeCount += 1;
      dir = await mkdtemp(join(tmpdir(), tempDirPrefix(agentId)));
      lifecycle.onDirectoryCreated(dir);
      path = join(dir, "image.png");await writeFile(path, bytes);
      return { dir, paths: [path] };
    },
    codexFactory: () => ({ startThread: () => ({ runStreamed: async () => ({ events: (async function* () {
      await releaseTurn.promise;
      yield { type: "turn.completed" as const, usage: { input_tokens: 0, output_tokens: 0,
        cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
    })() }) }), resumeThread: () => { throw new Error("unexpected resume"); } }),
  });
  const running = host.run();
  try {
    await sweeping.promise;
    attachImage(host, bytes);
    const sending = host.send("TURN", ["image"]);
    expect(materializeCount).toBe(0);
    releaseSweep.resolve();
    await sending;
    expect(materializeCount).toBe(1);
    expect(await readFile(path)).toEqual(bytes);
  } finally {
    releaseSweep.resolve();releaseTurn.resolve();
    host.close();await running;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

it("keeps the image operation chain usable after a rejected materialization", async () => {
  const identity = config(), bytes = Buffer.from("retry-content");
  let attempts = 0, dir = "", path = "";
  const rejected: unknown[] = [];
  const host = new CodexHost(identity, {
    backend: "exec", appendSystemPrompt: "Test", onState: () => {},
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
