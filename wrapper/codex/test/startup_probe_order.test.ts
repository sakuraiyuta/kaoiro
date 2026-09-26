import { expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { CodexHost } from "../src/host.js";

const config: WrapperConfig = {
  agent_id: "startup-order.codex",
  persona: { id: "test", name: "Test", sprite_set: "test" },
  display_name: "Test",
  server_url: "ws://unused",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function heldProbe() {
  const closing = deferred(), release = deferred();
  let rejectRead!: (reason: Error) => void;
  const read = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  let closePromise: Promise<void> | undefined;
  const transport = {
    readRateLimits: () => read,
    close: () => closePromise ??= (async () => {
      closing.resolve();
      await release.promise;
      rejectRead(new Error("probe closed"));
    })(),
  };
  return { transport, closing: closing.promise, release: release.resolve };
}

it("closes the account probe before creating an app-server session", async () => {
  const probe = heldProbe();
  const createSession = vi.fn(async () => { throw new Error("fixture session stopped"); });
  const host = new CodexHost(config, {
    backend: "app-server", appendSystemPrompt: "Test", onState: () => {},
    appServerSessionFactory: createSession,
    startupRateLimitTransportFactory: () => probe.transport,
  });
  const reading = host.probeAccountRateLimits();
  const running = host.run();
  try {
    await host.send("TURN");
    await probe.closing;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(createSession).not.toHaveBeenCalled();
    probe.release();
    await reading;
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(host.statusSnapshot()).not.toHaveProperty("rate_limits");
  } finally {
    probe.release();
    host.close();
    await running;
  }
});

it("closes the account probe before starting an exec child", async () => {
  const probe = heldProbe();
  const runStreamed = vi.fn(async () => ({ events: (async function* () {
    yield { type: "turn.completed" as const, usage: {
      input_tokens: 0, output_tokens: 0, cached_input_tokens: 0,
      cache_write_input_tokens: 0, reasoning_output_tokens: 0,
    } };
  })() }));
  const host = new CodexHost(config, {
    backend: "exec", appendSystemPrompt: "Test", onState: () => {},
    codexFactory: () => ({ startThread: () => ({ runStreamed }), resumeThread: () => ({ runStreamed }) }),
    startupRateLimitTransportFactory: () => probe.transport,
  });
  const reading = host.probeAccountRateLimits();
  const running = host.run();
  try {
    await host.send("TURN");
    await probe.closing;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(runStreamed).not.toHaveBeenCalled();
    probe.release();
    await reading;
    await vi.waitFor(() => expect(runStreamed).toHaveBeenCalledTimes(1));
    expect(host.statusSnapshot()).not.toHaveProperty("rate_limits");
  } finally {
    probe.release();
    host.close();
    await running;
  }
});

it("does not create an app-server child if the Host closes while the probe is draining", async () => {
  const probe = heldProbe();
  const createSession = vi.fn(async () => { throw new Error("unexpected session"); });
  const host = new CodexHost(config, {
    backend: "app-server", appendSystemPrompt: "Test", onState: () => {},
    appServerSessionFactory: createSession,
    startupRateLimitTransportFactory: () => probe.transport,
  });
  const reading = host.probeAccountRateLimits();
  const running = host.run();
  try {
    await host.send("TURN");
    await probe.closing;
    host.close();
    probe.release();
    await reading;
    await running;
    expect(createSession).not.toHaveBeenCalled();
  } finally {
    probe.release();host.close();await running;
  }
});
