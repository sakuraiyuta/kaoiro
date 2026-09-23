// issue #396 -- real lifetime semantics for request_session_reset on
// Antigravity. Unlike cli_session_reset_availability.test.ts (which pins
// the composition with a mock host), these pins run a REAL AntigravityHost
// driven by a fake agy child process, so the actual `#drainTurns` finally
// block (state_change -> onTurnBoundary -> onTurnEnd) and the real
// SessionResetCoordinator decide the outcome -- not a hand-called callback.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Envelope, ToolDescriptor, WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";
import { AntigravityHost, type AntigravityHostOptions, type SpawnedAgy } from "../src/host.js";

const CONFIG: WrapperConfig = {
  agent_id: "host-1.antigravity-gate",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

class FakeAgy extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();

  // Unlike host.test.ts's FakeAgy (record-only kill, tests call finish()
  // explicitly), this one terminates on kill() -- host.close()'s own
  // #endEpoch("close") signals the child and this pin needs the turn to
  // actually reach its `{kind: "stale"}` outcome without an extra manual
  // step standing in for what close()'s real escalation already does.
  kill(signal?: NodeJS.Signals): boolean {
    this.stdout.end();
    this.emit("exit", null, signal ?? "SIGTERM");
    this.emit("close", null, signal ?? "SIGTERM");
    return true;
  }

  finish(): void {
    this.stdout.end();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
}

interface Rig {
  sent: Envelope[];
  requests: { mode: string; reason?: string }[];
  requestSnapshots: { sentCount: number; state: string | undefined }[];
  turnEnds: Parameters<NonNullable<AntigravityHostOptions["onTurnEnd"]>>[0][];
  sendRejections: Parameters<NonNullable<AntigravityHostOptions["onSendRejected"]>>[0][];
  linkOptions: Record<string, any>;
  hostOptions: Record<string, any>;
  host: AntigravityHost;
  agyChildren: FakeAgy[];
  done: Promise<void>;
}

async function makeRig(
  overrides: Partial<WrapperConfig> = {},
  prepareInput?: AntigravityHostOptions["prepareInput"],
): Promise<Rig> {
  const sent: Envelope[] = [];
  const requests: Rig["requests"] = [];
  const requestSnapshots: Rig["requestSnapshots"] = [];
  const turnEnds: Rig["turnEnds"] = [];
  const sendRejections: Rig["sendRejections"] = [];
  const agyChildren: FakeAgy[] = [];
  let linkOptions!: Record<string, any>;
  let hostOptions!: Record<string, any>;
  let host!: AntigravityHost;
  const link = {
    close: () => {},
    send: (envelope: Envelope) => sent.push(envelope),
    requestSessionReset: async (mode: string, reason?: string) => {
      requestSnapshots.push({
        sentCount: sent.length,
        state: sent.filter((e) => e.type === "state_change").at(-1)?.state,
      });
      requests.push({ mode, ...(reason !== undefined ? { reason } : {}) });
      return { requestId: "r-1" };
    },
  };
  const done = runAntigravityCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...CONFIG, ...overrides }),
    createServerLink: (_url, _agentId, options) => {
      linkOptions = options as unknown as Record<string, any>;
      queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
      return link as never;
    },
    createHost: (cfg, options) => {
      hostOptions = options as unknown as Record<string, any>;
      host = new AntigravityHost(cfg, {
        ...options,
        runtimeAssetsAvailable: () => true,
        verifyGate: async () => true,
        agyPath: "/test/agy",
        ...(prepareInput === undefined ? {} : { prepareInput }),
        onTurnEnd: (info) => {
          turnEnds.push(info);
          options.onTurnEnd?.(info);
        },
        onSendRejected: (info) => {
          sendRejections.push(info);
          options.onSendRejected?.(info);
        },
        spawn: () => {
          const child = new FakeAgy();
          agyChildren.push(child);
          return child as unknown as SpawnedAgy;
        },
      } as AntigravityHostOptions);
      return host;
    },
  });
  await vi.waitFor(() => expect(host).toBeDefined());
  return {
    sent,
    requests,
    requestSnapshots,
    turnEnds,
    sendRejections,
    get linkOptions() {
      return linkOptions;
    },
    get hostOptions() {
      return hostOptions;
    },
    get host() {
      return host;
    },
    agyChildren,
    done,
  };
}

function resetDescriptor(rig: Rig): ToolDescriptor {
  const descriptors = rig.hostOptions.toolDescriptors as ToolDescriptor[];
  return descriptors.find((d) => d.name === "request_session_reset")!;
}

describe("Antigravity session-reset real lifetime semantics (issue #396)", () => {
  // The state_change this turn's own outcome produces (host.ts's
  // #drainTurns finally block: #publishTerminalResult/#terminalError ->
  // #apply -> #emitState, synchronous) must reach the link BEFORE the
  // dispatched session_reset_request -- the #395 bug on the opposite side.
  // Checked on both the result-success and result-with-is_error paths.
  it.each([
    ["result", '{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n'],
    ["is_error result", '{"event":"result","result":{"status":"ERROR","response":"boom"}}\n'],
  ] as const)(
    "delivers the turn's own state_change before the dispatched session_reset_request (%s)",
    async (_label, stdoutLine) => {
      const rig = await makeRig();
      await rig.host.send("do the thing", undefined, ["cid-a"], "turn-a");
      await vi.waitFor(() => expect(rig.agyChildren).toHaveLength(1));

      const reset = resetDescriptor(rig);
      const requestsSoFar = rig.sent.filter((e) => e.type === "permission_request").length;
      const call = reset.handler({ mode: "new", reason: "done here" });
      await vi.waitFor(() =>
        expect(rig.sent.filter((e) => e.type === "permission_request").length).toBe(
          requestsSoFar + 1,
        ),
      );
      const request = rig.sent.filter((e) => e.type === "permission_request").at(-1)!;
      const requestId = (request.payload as { request_id: string }).request_id;
      rig.linkOptions.onPermissionDecision({ request_id: requestId, allow: true });
      await call;

      rig.agyChildren[0]!.stdout.write(stdoutLine);
      rig.agyChildren[0]!.finish();

      await vi.waitFor(() => expect(rig.requests).toHaveLength(1));
      expect(rig.requests[0]).toMatchObject({ mode: "new", reason: "done here" });
      // The ordering pin itself: at the moment requestSessionReset fired,
      // the LAST state_change already reflected the turn's own end.
      expect(rig.requestSnapshots[0]!.state).toBe("waiting_input");
    },
  );

  // A reservation dispatches cleanly at its owning turn's authoritative
  // end, and a later turn that gets skipped by `prepareInput` (never even
  // reaching onTurnEnd) does not disturb that -- exercising issue #394
  // commit 2's `{kind: "skipped"}` outcome alongside this new code path.
  it("a reservation dispatches at its owning turn's end and a subsequent skipped turn does not interfere", async () => {
    const rig = await makeRig({}, (token) => (token === "turn-b" ? null : undefined));
    await rig.host.send("do the thing", undefined, ["cid-a"], "turn-a");
    await vi.waitFor(() => expect(rig.agyChildren).toHaveLength(1));

    const reset = resetDescriptor(rig);
    const call = reset.handler({ mode: "clear" });
    await vi.waitFor(() => expect(rig.sent.filter((e) => e.type === "permission_request")).toHaveLength(1));
    const requestId = (
      rig.sent.filter((e) => e.type === "permission_request")[0]!.payload as { request_id: string }
    ).request_id;
    rig.linkOptions.onPermissionDecision({ request_id: requestId, allow: true });
    await call;

    // Queue a second, later turn while the first is still in flight, and
    // arrange for it to be SKIPPED (host.ts's `{kind: "skipped"}` branch --
    // onTurnEnd is never called for it at all -- the rig's prepareInput
    // returns null for it).
    await rig.host.send("skip me", undefined, ["cid-b"], "turn-b");

    expect(rig.requests).toHaveLength(0);
    rig.agyChildren[0]!.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
    rig.agyChildren[0]!.finish();

    await vi.waitFor(() => expect(rig.requests).toHaveLength(1));
    expect(rig.requests[0]).toMatchObject({ mode: "clear" });
    // Only one dispatch ever happened -- the skipped turn never produced a
    // second onTurnEnd call that could have re-dispatched or duplicated it.
    expect(rig.turnEnds).toHaveLength(1);
  });

  // A turn that ends via close() while a reservation is pending is dropped
  // with a cancellation notice, NOT dispatched. This is the pin `terminal`
  // exists for -- outcome.kind === "stale" (host.ts, close()-during-flight)
  // reaches onTurnEnd with neither an `error` nor a `cancellation`,
  // indistinguishable from a real result without the `terminal` field this
  // issue adds.
  it("drops a pending reservation, without dispatching, when its turn ends via close()", async () => {
    const rig = await makeRig();
    await rig.host.send("do the thing", undefined, ["cid-a"], "turn-a");
    await vi.waitFor(() => expect(rig.agyChildren).toHaveLength(1));

    const reset = resetDescriptor(rig);
    const call = reset.handler({ mode: "new" });
    await vi.waitFor(() => expect(rig.sent.filter((e) => e.type === "permission_request")).toHaveLength(1));
    const requestId = (
      rig.sent.filter((e) => e.type === "permission_request")[0]!.payload as { request_id: string }
    ).request_id;
    rig.linkOptions.onPermissionDecision({ request_id: requestId, allow: true });
    await call;

    // The turn never produces a result -- close() ends it as `stale`.
    rig.host.close();
    await vi.waitFor(() => expect(rig.turnEnds).toHaveLength(1));

    // Give the coordinator's onTurnEnd handling a tick to run to completion.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rig.requests).toHaveLength(0);
  });

  // A watchdog fail-stop's ACTIVE-turn onTurnEnd never fires at all (see
  // the finally block's
  // `!this.#watchdogFailStopped` gate in host.ts), so a pending
  // reservation freezes ONLY when the queue is empty at fail-stop time --
  // ADR-0043 and antigravity-tools-permissions.md previously described
  // this as unconditional. When an unstarted turn is still queued,
  // `#failStopForWatchdog` settles IT with a synthetic `onTurnEnd`
  // (`terminal: false`), which reaches the coordinator as
  // non-authoritative -- and the coordinator drops ANY pending
  // reservation on that signal alone, before ever checking which turn
  // owns it. This pins that the reservation is genuinely CANCELLED (not
  // silently frozen) in that case: no dispatch happens, and the
  // cancellation's own `notify()` call reaches `host.send()`, which by
  // then is already closed and rejects it -- an observable side effect a
  // mutant that removed the queue-settlement-cancels-reservation
  // behaviour (e.g. by moving the owner check before the authoritative
  // check) would not produce.
  it("a queued unstarted turn's settlement cancels (not freezes) a pending reservation on watchdog fail-stop", async () => {
    const rig = await makeRig();
    await rig.host.send("do the thing", undefined, ["cid-a"], "turn-a");
    await vi.waitFor(() => expect(rig.agyChildren).toHaveLength(1));

    const reset = resetDescriptor(rig);
    const call = reset.handler({ mode: "new" });
    await vi.waitFor(() => expect(rig.sent.filter((e) => e.type === "permission_request")).toHaveLength(1));
    const requestId = (
      rig.sent.filter((e) => e.type === "permission_request")[0]!.payload as { request_id: string }
    ).request_id;
    rig.linkOptions.onPermissionDecision({ request_id: requestId, allow: true });
    await call;

    // Queue a second turn behind the still-active turn-a; it must stay
    // queued (agy never produces a result for turn-a) until fail-stop hits.
    await rig.host.send("queued behind turn-a", undefined, ["cid-b"], "turn-b");
    expect(rig.requests).toHaveLength(0);

    expect(rig.host.failStopTurnForWatchdog("turn-a")).toBe(true);

    // The cancellation's notify() call reaches host.send(), already
    // closed by fail-stop, and is rejected rather than silently ignored.
    await vi.waitFor(() => expect(rig.sendRejections).toHaveLength(1));
    expect(rig.sendRejections[0]).toMatchObject({ reason: "watchdog_fail_stopped" });
    expect(rig.requests).toHaveLength(0);
  });
});
