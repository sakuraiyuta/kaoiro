import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { CodexHost } from "../src/host.js";
import type { CodexClientLike, CodexThreadLike } from "../src/host.js";

const cleanup = vi.hoisted(() => ({
  dirs: [] as string[],
  gate: null as Promise<void> | null,
}));

vi.mock("../src/upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/upload.js")>()),
  cleanupLocalImages: async (dir: string) => {
    cleanup.dirs.push(dir);
    await cleanup.gate;
  },
}));

const CONFIG: WrapperConfig = {
  agent_id: `drop-temp-turns-${randomUUID()}`,
  persona: { id: "test", name: "Test", sprite_set: "test" },
  display_name: "Test",
  server_url: "ws://unused",
};

const dirOf = (id: string): string => `/tmp/kaoiro-drop-temp-turns-${id}`;

// run() does real startup work before its first turn; leave headroom.
const RUN_PROGRESS = { timeout: 4000 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Makes every cleanupLocalImages call wait until the returned release(). */
function holdCleanup(): () => void {
  const gate = deferred();
  cleanup.gate = gate.promise;
  return gate.resolve;
}

/** `holds[n]` keeps the n-th SDK turn in flight until it resolves. */
function build(holds: ReadonlyArray<Promise<void>> = []) {
  const ran: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const thread: CodexThreadLike = {
    async runStreamed(input, turnOptions) {
      signals.push(turnOptions?.signal);
      const index = ran.push(
        typeof input === "string" ? input : (input[0] as { text: string }).text,
      ) - 1;
      async function* events(): AsyncGenerator<ThreadEvent> {
        await holds[index];
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            cache_write_input_tokens: 0,
          },
        };
      }
      return { events: events() };
    },
  };
  const client: CodexClientLike = {
    startThread: () => thread,
    resumeThread: () => thread,
  };
  const host = new CodexHost(CONFIG, {
    backend: "exec",
    appendSystemPrompt: "p",
    onState: () => {},
    codexFactory: () => client,
    sweepImages: async () => {},
    materializeImages: async (_agentId, uploads, lifecycle) => {
      const dir = dirOf(uploads[0]!.meta.upload_id);
      lifecycle.onDirectoryCreated(dir);
      return { dir, paths: [`${dir}/image.png`] };
    },
  });
  return { host, ran, signals };
}

/** Sends a text + one-image turn whose temp dir is dirOf(id). */
async function sendImage(host: CodexHost, id: string): Promise<void> {
  host.attachOpen({
    upload_id: id, filename: "i.png", mime: "image/png", size: 1, chunks: 1,
  });
  const chunk = Buffer.alloc(4 + id.length + 4 + 1);
  chunk.writeUInt32BE(id.length, 0);
  chunk.write(id, 4);
  chunk.writeUInt32BE(0, 4 + id.length);
  host.attachChunk(chunk);
  host.attachClose(id);
  await host.send(`img-${id}`, [id]);
}

async function drain(
  host: CodexHost,
  ran: string[],
  expected: string[],
): Promise<void> {
  const running = host.run();
  try {
    await vi.waitFor(() => expect(ran).toEqual(expected), RUN_PROGRESS);
  } finally {
    host.close();
    await running;
  }
}

beforeEach(() => {
  cleanup.dirs.length = 0;
  cleanup.gate = null;
});

describe("CodexHost.interrupt while a queued image turn's cleanup is pending", () => {
  it("keeps a text turn enqueued during the cleanup", async () => {
    const { host, ran } = build();
    await sendImage(host, "a");
    const release = holdCleanup();
    const interrupting = host.interrupt();
    try {
      await vi.waitFor(() => expect(cleanup.dirs).toEqual([dirOf("a")]));
      await host.send("late");
    } finally {
      release();
    }
    await interrupting;
    await drain(host, ran, ["late"]);
  });

  it("keeps an image turn enqueued after the interrupt", async () => {
    const { host, ran } = build();
    await sendImage(host, "a");
    const release = holdCleanup();
    const interrupting = host.interrupt();
    try {
      await vi.waitFor(() => expect(cleanup.dirs).toEqual([dirOf("a")]));
      await sendImage(host, "b");
    } finally {
      release();
    }
    await interrupting;
    expect(cleanup.dirs).toEqual([dirOf("a")]);
    await drain(host, ran, ["img-b"]);
  });

  it("neither runs the dropped image turn nor loses the one behind it", async () => {
    const hold = deferred();
    const { host, ran } = build([hold.promise]);
    const running = host.run("first");
    let release = () => {};
    try {
      await vi.waitFor(() => expect(ran).toEqual(["first"]), RUN_PROGRESS);
      await sendImage(host, "a");
      await host.send("text-b");
      release = holdCleanup();
      const interrupting = host.interrupt();
      await vi.waitFor(() => expect(cleanup.dirs).toEqual([dirOf("a")]));
      hold.resolve();
      await vi.waitFor(
        () => expect(ran.length).toBeGreaterThan(1),
        RUN_PROGRESS,
      );
      release();
      await interrupting;
      await host.send("end");
      await vi.waitFor(() => expect(ran).toContain("end"), RUN_PROGRESS);
      expect(ran).toEqual(["first", "text-b", "end"]);
    } finally {
      release();
      hold.resolve();
      host.close();
      await running;
    }
  });

  it("does not abort a turn the run loop started during the cleanup", async () => {
    const first = deferred();
    const second = deferred();
    const { host, ran, signals } = build([first.promise, second.promise]);
    const running = host.run("first");
    let release = () => {};
    try {
      await vi.waitFor(() => expect(ran).toEqual(["first"]), RUN_PROGRESS);
      await sendImage(host, "a");
      await host.send("text-b");
      release = holdCleanup();
      const interrupting = host.interrupt();
      await vi.waitFor(() => expect(cleanup.dirs).toEqual([dirOf("a")]));
      first.resolve();
      await vi.waitFor(
        () => expect(ran.length).toBeGreaterThan(1),
        RUN_PROGRESS,
      );
      release();
      await interrupting;
      expect(signals[1]?.aborted).toBe(false);
    } finally {
      release();
      first.resolve();
      second.resolve();
      host.close();
      await running;
    }
  });

  it("does not resurrect a placeholder removed during the cleanup", async () => {
    const { host, ran } = build();
    await sendImage(host, "a");
    expect(host.createInterAgentPlaceholder("batch", 0)).toBe(true);
    const release = holdCleanup();
    const interrupting = host.interrupt();
    try {
      await vi.waitFor(() => expect(cleanup.dirs).toEqual([dirOf("a")]));
      host.removeInterAgentPlaceholder("batch");
    } finally {
      release();
    }
    await interrupting;
    const running = host.run();
    try {
      await host.send("follow-up");
      await vi.waitFor(
        () => expect(ran).toEqual(["follow-up"]),
        RUN_PROGRESS,
      );
    } finally {
      host.close();
      await running;
    }
  });
});
