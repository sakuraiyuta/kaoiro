import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PermissionBroker, type WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost, type AntigravityHostOptions, type SpawnedAgy } from "../src/host.js";

// issue #379: wiring-level tests for the Host's use of subtree_termination.ts.
// The escalation timing itself (SIGTERM now, SIGKILL after graceMs, cancel,
// shortenGraceTo, the M3 liveness re-check) is unit-tested exhaustively in
// subtree_termination.test.ts against fake timers; these tests confirm the
// HOST calls into it correctly (which grace value, which trigger cancels it,
// that a repeat interrupt does not re-signal). Real (small) timeouts + polling
// match this file's existing convention (`waitFor`) rather than adding a new
// fake-timer injection seam to `AntigravityHostOptions` only for this.

class FakeAgy extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  kill(_signal?: NodeJS.Signals): boolean {
    return true;
  }
  finish(): void {
    this.stdout.end();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
}

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    agent_id: "a1",
    persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P",
    server_url: "ws://localhost:4000",
    sandbox: "workspace-write",
    network_access: false,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for host");
}

function hostHarness(options: {
  abortGraceMs?: number;
  closeGraceMs?: number;
} = {}) {
  const calls: { child: FakeAgy }[] = [];
  const turnStarts: string[] = [];
  const cfg = config();
  const host = new AntigravityHost(cfg, {
    cwd: process.cwd(),
    appendSystemPrompt: "persona",
    permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
    onState: () => {},
    runtimeAssetsAvailable: () => true,
    verifyGate: async () => true,
    agyPath: "/test/agy",
    onTurnStart: ({ turnToken }) => turnStarts.push(turnToken),
    ...(options.abortGraceMs === undefined ? {} : { abortGraceMs: options.abortGraceMs }),
    ...(options.closeGraceMs === undefined ? {} : { closeGraceMs: options.closeGraceMs }),
    spawn: () => {
      const child = new FakeAgy();
      calls.push({ child });
      return child as unknown as SpawnedAgy;
    },
  } satisfies AntigravityHostOptions);
  return { host, calls, turnStarts };
}

describe("AntigravityHost subtree termination wiring (issue #379)", () => {
  it("a repeat interrupt() sends SIGTERM to the child exactly once (pin 3)", async () => {
    const { host, calls } = hostHarness({ abortGraceMs: 10_000 });
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const killSpy = vi.spyOn(calls[0]!.child, "kill");
    await host.interrupt();
    await host.interrupt();
    await host.interrupt();
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith("SIGTERM");
    host.close();
  });

  it("close() after interrupt() shortens the escalation to closeGraceMs, not abortGraceMs (M2)", async () => {
    const { host, calls } = hostHarness({ abortGraceMs: 10_000, closeGraceMs: 30 });
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const killSpy = vi.spyOn(calls[0]!.child, "kill");
    await host.interrupt(); // arms the 10s abort grace
    expect(killSpy).toHaveBeenCalledTimes(1); // SIGTERM only so far
    host.close(); // shortens it down to 30ms
    await waitFor(() => killSpy.mock.calls.length === 2);
    expect(killSpy).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("failStopTurnForWatchdog sends SIGKILL immediately, with no grace of its own", async () => {
    const { host, calls, turnStarts } = hostHarness({ abortGraceMs: 10_000 });
    const sent = host.send("hello");
    await waitFor(() => calls.length === 1);
    await waitFor(() => turnStarts.length === 1);
    const turnToken = turnStarts[0]!;
    const killSpy = vi.spyOn(calls[0]!.child, "kill");
    // requestInterruptForTurn: SIGTERM only, no grace armed by the Host --
    // TurnWatchdog (unit-tested separately) owns that timing externally.
    expect(host.requestInterruptForTurn(turnToken)).toBe(true);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenNthCalledWith(1, "SIGTERM");
    // failStopTurnForWatchdog: called only after TurnWatchdog's OWN grace
    // already elapsed, so this escalates straight to SIGKILL.
    expect(host.failStopTurnForWatchdog(turnToken)).toBe(true);
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenNthCalledWith(2, "SIGKILL");
    calls[0]!.child.finish();
    await sent;
  });

  it("timer ownership: a cancelled escalation for turn A's child never signals turn B's child (pin 6)", async () => {
    const { host, calls } = hostHarness({ abortGraceMs: 50 });
    await host.send("first");
    await waitFor(() => calls.length === 1);
    await host.interrupt(); // arms a 50ms escalation for child A
    calls[0]!.child.finish(); // A exits immediately -> cancels the escalation

    await host.send("second");
    await waitFor(() => calls.length === 2);
    const bKillSpy = vi.spyOn(calls[1]!.child, "kill");
    // Wait well past A's original 50ms deadline; a stale timer would fire
    // a SIGKILL at child B here if cancellation had not actually cleared it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(bKillSpy).not.toHaveBeenCalled();
    host.close();
  });

  it("gate probe / model probe spawns never receive `detached` (pin 4: excluded from the group-kill boundary)", async () => {
    const probeCalls: unknown[] = [];
    const modelsProbeCalls: unknown[] = [];
    const cfg = config();
    const calls: { child: FakeAgy }[] = [];
    const host = new AntigravityHost(cfg, {
      cwd: process.cwd(),
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {},
      runtimeAssetsAvailable: () => true,
      verifyGate: async () => true,
      agyPath: "/test/agy",
      abortGraceMs: 10_000,
      spawn: () => {
        const child = new FakeAgy();
        calls.push({ child });
        return child as unknown as SpawnedAgy;
      },
      probeSpawn: (_command, _args, opts) => {
        probeCalls.push(opts);
        return { stdout: new PassThrough(), kill: () => true } as never;
      },
      modelsProbeSpawn: (_command, _args, opts) => {
        modelsProbeCalls.push(opts);
        return { stdout: new PassThrough(), kill: () => true } as never;
      },
    } satisfies AntigravityHostOptions);
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    // The turn child DID get the group-aware treatment (detached spawn,
    // group-signal escalation). Whatever probe calls happened along the way
    // must never carry a `detached` option -- their spawn signature does
    // not even accept one, so this also guards against a future signature
    // change accidentally threading it through.
    for (const call of [...probeCalls, ...modelsProbeCalls]) {
      expect(call as Record<string, unknown>).not.toHaveProperty("detached");
    }
    host.close();
  });
});
