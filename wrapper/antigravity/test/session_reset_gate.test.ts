import "../../../scripts/test/fixtures/test-isolation.mjs";
// issue #396 -- real lifetime semantics for request_session_reset on
// Antigravity. Unlike cli_session_reset_availability.test.ts (which pins
// the composition with a mock host), these pins run a REAL AntigravityHost
// driven by a fake agy child process, so the actual `#drainTurns` finally
// block (state_change -> onTurnBoundary -> onTurnEnd) and the real
// SessionResetCoordinator decide the outcome -- not a hand-called callback.
import { describe, expect, it, vi } from "vitest";
import type { Envelope, ToolDescriptor, WrapperConfig } from "@kaoiro/agent-common";
import type { DirectoryEntry } from "@kaoiro/protocol";
import { runAntigravityCli } from "../src/cli.js";
import type { AntigravityHost, AntigravityHostOptions } from "../src/host.js";
import { createTestHost, type FakeAgy } from "./acp_fake.js";

const CONFIG: WrapperConfig = {
  agent_id: "host-1.antigravity-gate",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

interface Rig {
  sent: Envelope[];
  acknowledged: number[];
  requests: { mode: string; reason?: string }[];
  requestSnapshots: { sentCount: number; state: string | undefined }[];
  turnEnds: Parameters<NonNullable<AntigravityHostOptions["onTurnEnd"]>>[0][];
  sendRejections: Parameters<NonNullable<AntigravityHostOptions["onSendRejected"]>>[0][];
  linkOptions: Record<string, any>;
  hostOptions: Record<string, any>;
  host: AntigravityHost;
  agyChildren: FakeAgy[];
  directoryAgents: DirectoryEntry[];
  done: Promise<void>;
}

async function makeRig(
  overrides: Partial<WrapperConfig> = {},
  prepareInput?: AntigravityHostOptions["prepareInput"],
): Promise<Rig> {
  const sent: Envelope[] = [];
  const acknowledged: number[] = [];
  const requests: Rig["requests"] = [];
  const requestSnapshots: Rig["requestSnapshots"] = [];
  const turnEnds: Rig["turnEnds"] = [];
  const sendRejections: Rig["sendRejections"] = [];
  const directoryAgents: DirectoryEntry[] = [];
  let agyChildren: FakeAgy[] = [];
  let linkOptions!: Record<string, any>;
  let hostOptions!: Record<string, any>;
  let host!: AntigravityHost;
  const link = {
    close: () => {},
    setSessionId: () => {},
    send: (envelope: Envelope) => sent.push(envelope),
    acknowledgeInterAgentDelivery: (sequence: number) => acknowledged.push(sequence),
    requestSessionReset: async (mode: string, reason?: string) => {
      requestSnapshots.push({
        sentCount: sent.length,
        state: sent.filter((e) => e.type === "state_change").at(-1)?.state,
      });
      requests.push({ mode, ...(reason !== undefined ? { reason } : {}) });
      return { requestId: "r-1" };
    },
    requestDirectory: async () => ({ agents: directoryAgents, users: [] }),
  };
  const done = runAntigravityCli({
    parseCliArgs: () => ({ configPath: "test" }),
    loadConfig: () => ({ ...CONFIG, ...overrides }),
    createServerLink: (_url, _agentId, options) => {
      linkOptions = options as unknown as Record<string, any>;
      queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
      return link as never;
    },
    createHost: (cfg, options) => {
      hostOptions = options as unknown as Record<string, any>;
      const test = createTestHost(cfg, {
        ...options,
        ...(prepareInput === undefined ? {} : { prepareInput }),
        onTurnEnd: (info) => {
          turnEnds.push(info);
          options.onTurnEnd?.(info);
        },
        onSendRejected: (info) => {
          sendRejections.push(info);
          options.onSendRejected?.(info);
        },
      } as AntigravityHostOptions);
      agyChildren = test.agys;
      host = test.host;
      return host;
    },
  });
  await vi.waitFor(() => expect(host).toBeDefined());
  return {
    sent,
    acknowledged,
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
    get agyChildren() {
      return agyChildren;
    },
    directoryAgents,
    done,
  };
}

function resetDescriptor(rig: Rig): ToolDescriptor {
  const descriptors = rig.hostOptions.toolDescriptors as ToolDescriptor[];
  return descriptors.find((d) => d.name === "request_session_reset")!;
}

function peerEnvelope(deliverySeq: number): Envelope {
  return {
    version: "0",
    agent_id: "peer-1",
    persona: { id: "peer", name: "peer", sprite_set: "peer" },
    display_name: "peer",
    ts: "2026-10-09T00:00:00Z",
    type: "inter_agent_message",
    state: "thinking",
    payload: {
      to: CONFIG.agent_id,
      conversation_id: "peer-conversation",
      turn_number: 1,
      kind: "request",
      body: "peer batch while probing",
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
    delivery_seq: deliverySeq,
  } as unknown as Envelope;
}

/** The prompt of process `index` is open, and its reset call passed the hook
 *  and shows as a running tool, as a real kaoiro call does. */
async function markChildToolRunning(rig: Rig, index: number): Promise<void> {
  await vi.waitFor(() => expect(rig.agyChildren[index]?.promptOpen).toBe(true));
  const agy = rig.agyChildren[index]!;
  agy.toolCall(`reset-${index}`, "mcp_kaoiro_request_session_reset", { mode: "new" });
  await expect(agy.preToolUse(`reset-${index}`, "mcp_kaoiro_request_session_reset", { mode: "new" })).resolves.toEqual({ decision: "allow" });
  await vi.waitFor(() => expect(rig.sent.filter((e) => e.type === "state_change").at(-1)?.state).toBe("tool_running"));
}

async function markToolRunning(rig: Rig): Promise<void> {
  await markChildToolRunning(rig, 0);
}

/** Completes the reset call, then answers the prompt. */
function end(rig: Rig, index: number, stopReason = "end_turn"): void {
  rig.agyChildren[index]!.toolDone(`reset-${index}`, "mcp_kaoiro_request_session_reset", { mode: "new" });
  rig.agyChildren[index]!.respond(stopReason);
}

/** A tool call that completes with no hook latches the gate fault. */
function unhooked(rig: Rig, index: number): void {
  rig.agyChildren[index]!.toolCall("loose", "run_command", { CommandLine: "ls" });
  rig.agyChildren[index]!.toolDone("loose", "run_command", { CommandLine: "ls" });
}

describe("Antigravity session-reset real lifetime semantics (issue #396)", () => {
  it("keeps the tool approval at waiting_permission until the decision settles", async () => {
    const rig = await makeRig();
    await rig.host.send("do the thing", undefined, ["cid-a"], "turn-a");
    await markToolRunning(rig);

    const call = resetDescriptor(rig).handler({ mode: "new" });
    await vi.waitFor(() => expect(rig.sent.some((e) => e.type === "permission_request")).toBe(true));
    const statesWhilePending = rig.sent.filter((e) => e.type === "state_change").map((e) => e.state);
    expect(statesWhilePending.at(-1)).toBe("waiting_permission");
    expect(statesWhilePending.slice(statesWhilePending.indexOf("waiting_permission"))).not.toContain("tool_running");

    const request = rig.sent.filter((e) => e.type === "permission_request").at(-1)!;
    const requestId = (request.payload as { request_id: string }).request_id;
    rig.linkOptions.onPermissionDecision({ request_id: requestId, allow: true });
    await call;
    expect(rig.sent.filter((e) => e.type === "state_change").at(-1)?.state).toBe("tool_running");

    end(rig, 0);
    await vi.waitFor(() => expect(rig.turnEnds).toHaveLength(1));
    rig.host.close();
  });

  it("list_agents descriptor serializes waiting_permission during a tool approval", async () => {
    const rig = await makeRig();
    await rig.host.send("do the thing", undefined, ["cid-a"], "turn-list-agents");
    await markToolRunning(rig);

    const call = resetDescriptor(rig).handler({ mode: "new" });
    await vi.waitFor(() => expect(rig.sent.some((e) => e.type === "permission_request")).toBe(true));
    rig.directoryAgents.push({
      agent_id: CONFIG.agent_id,
      persona: CONFIG.persona,
      state: rig.host.state,
    });
    const listAgents = (rig.hostOptions.toolDescriptors as ToolDescriptor[]).find((d) => d.name === "list_agents")!;
    const result = await listAgents.handler({});
    const parsed = JSON.parse(result.content[0]!.text) as { agents: DirectoryEntry[] };
    expect(parsed.agents.find((agent) => agent.agent_id === CONFIG.agent_id)?.state).toBe("waiting_permission");

    const request = rig.sent.filter((e) => e.type === "permission_request").at(-1)!;
    const requestId = (request.payload as { request_id: string }).request_id;
    rig.linkOptions.onPermissionDecision({ request_id: requestId, allow: true });
    await call;
    end(rig, 0);
    await vi.waitFor(() => expect(rig.turnEnds).toHaveLength(1));
    rig.host.close();
  });

  it("retires a tool wait lease when its child dies before the approval settles", async () => {
    const rig = await makeRig();
    await rig.host.send("do the thing", undefined, ["cid-a"], "turn-dead-child-a");
    await markToolRunning(rig);

    const firstCall = resetDescriptor(rig).handler({ mode: "new" });
    await vi.waitFor(() => expect(rig.sent.filter((e) => e.type === "permission_request")).toHaveLength(1));
    rig.agyChildren[0]!.exit(1);
    await vi.waitFor(() => expect(rig.turnEnds).toHaveLength(1));
    expect(rig.sent.filter((e) => e.type === "state_change").at(-1)?.state).not.toBe("waiting_permission");

    await rig.host.send("next turn", undefined, ["cid-b"], "turn-dead-child-b");
    await markChildToolRunning(rig, 1);
    const secondCall = resetDescriptor(rig).handler({ mode: "new" });
    await vi.waitFor(() => expect(rig.sent.filter((e) => e.type === "permission_request")).toHaveLength(2));
    expect(rig.sent.filter((e) => e.type === "state_change").at(-1)?.state).toBe("waiting_permission");

    const requests = rig.sent.filter((e) => e.type === "permission_request");
    const firstRequestId = (requests[0]!.payload as { request_id: string }).request_id;
    const secondRequestId = (requests[1]!.payload as { request_id: string }).request_id;
    rig.linkOptions.onPermissionDecision({ request_id: firstRequestId, allow: true });
    await firstCall;
    expect(rig.sent.filter((e) => e.type === "state_change").at(-1)?.state).toBe("waiting_permission");
    rig.linkOptions.onPermissionDecision({ request_id: secondRequestId, allow: true });
    await secondCall;
    expect(rig.sent.filter((e) => e.type === "state_change").at(-1)?.state).toBe("tool_running");

    end(rig, 1);
    await vi.waitFor(() => expect(rig.turnEnds).toHaveLength(2));
    rig.host.close();
  });

  it("returns to tool_running after a denied tool approval without reserving a reset", async () => {
    const rig = await makeRig();
    await rig.host.send("do the thing", undefined, ["cid-a"], "turn-deny");
    await markToolRunning(rig);

    const call = resetDescriptor(rig).handler({ mode: "new" });
    await vi.waitFor(() => expect(rig.sent.some((e) => e.type === "permission_request")).toBe(true));
    const request = rig.sent.filter((e) => e.type === "permission_request").at(-1)!;
    const requestId = (request.payload as { request_id: string }).request_id;
    rig.linkOptions.onPermissionDecision({ request_id: requestId, allow: false, message: "denied" });
    await expect(call).resolves.toMatchObject({ isError: true });
    expect(rig.sent.filter((e) => e.type === "state_change").at(-1)?.state).toBe("tool_running");
    expect(rig.requests).toHaveLength(0);

    end(rig, 0);
    await vi.waitFor(() => expect(rig.turnEnds).toHaveLength(1));
    rig.host.close();
  });

  it("returns to tool_running after a timed-out tool approval", async () => {
    const rig = await makeRig({ permission_timeout_ms: 10 });
    await rig.host.send("do the thing", undefined, ["cid-a"], "turn-timeout");
    await markToolRunning(rig);

    const result = await resetDescriptor(rig).handler({ mode: "new" });
    expect(result).toMatchObject({ isError: true });
    expect(rig.sent.filter((e) => e.type === "state_change").at(-1)?.state).toBe("tool_running");
    expect(rig.requests).toHaveLength(0);

    end(rig, 0);
    await vi.waitFor(() => expect(rig.turnEnds).toHaveLength(1));
    rig.host.close();
  });

  // The state_change this turn's own outcome produces (host.ts's
  // #drainTurns finally block: #publishTerminalResult/#terminalError ->
  // #apply -> #emitState, synchronous) must reach the link BEFORE the
  // dispatched session_reset_request -- the #395 bug on the opposite side.
  // Checked on both the result-success and result-with-is_error paths.
  it.each([
    ["result", "end_turn"],
    ["is_error result", "max_tokens"],
  ] as const)(
    "delivers the turn's own state_change before the dispatched session_reset_request (%s)",
    async (_label, stopReason) => {
      const rig = await makeRig();
      await rig.host.send("do the thing", undefined, ["cid-a"], "turn-a");
      await vi.waitFor(() => expect(rig.agyChildren).toHaveLength(1));
      await markToolRunning(rig);

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

      end(rig, 0, stopReason);

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
    await markToolRunning(rig);

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
    end(rig, 0);

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
    await markToolRunning(rig);

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
    await markToolRunning(rig);

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

  it("after a gate fault, the dropped reservation's notice and a peer batch are rejected as gate_broken; no process starts", async () => {
    const rig = await makeRig();
    await rig.host.send("do the thing", undefined, ["cid-owner"], "turn-owner");
    await markToolRunning(rig);

    const call = resetDescriptor(rig).handler({ mode: "new" });
    await vi.waitFor(() => expect(rig.sent.some((e) => e.type === "permission_request")).toBe(true));
    const permission = rig.sent.filter((e) => e.type === "permission_request").at(-1)!;
    rig.linkOptions.onPermissionDecision({
      request_id: (permission.payload as { request_id: string }).request_id,
      allow: true,
    });
    await call;

    unhooked(rig, 0);
    await vi.waitFor(() => expect(rig.turnEnds).toHaveLength(1));
    expect(rig.host.state).toBe("error");
    await vi.waitFor(() => expect(rig.sendRejections.some((event) => event.reason === "gate_broken")).toBe(true));
    expect(rig.requests).toHaveLength(0);

    const before = rig.sendRejections.length;
    await rig.linkOptions.onInterAgentMessage(peerEnvelope(7));
    await vi.waitFor(() => expect(rig.sendRejections.length).toBeGreaterThan(before));
    const notices = rig.sent.filter((envelope) => {
      const payload = envelope.payload as { to?: string; error?: { code?: string } };
      return envelope.type === "inter_agent_message" && payload.to === "peer-1" && payload.error?.code === "interrupted";
    });
    expect(notices).toHaveLength(1);
    expect(rig.acknowledged).not.toContain(7);
    expect(rig.agyChildren).toHaveLength(1);
    rig.host.close();
  });

  it("logs a rejected tokenless work notice once and does not replay it", async () => {
    const output: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const rig = await makeRig();
    try {
      await rig.host.send("trip", undefined, ["cid-trip"], "trip-token");
      await vi.waitFor(() => expect(rig.agyChildren[0]?.promptOpen).toBe(true));
      unhooked(rig, 0);
      await vi.waitFor(() => expect(rig.turnEnds).toHaveLength(1));
      expect(rig.host.state).toBe("error");

      rig.linkOptions.onWorkNotice({ notice_id: "notice-541", title: "tokenless-541-marker" });
      await vi.waitFor(() => expect(rig.sendRejections.some((event) => event.turnToken === undefined && event.reason === "gate_broken")).toBe(true));
      const lifecycle = output.join("").split("\n")
        .filter((line) => line.startsWith("[kaoiro][antigravity-lifecycle] "))
        .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
      const failedNotice = lifecycle.filter((event) => event.event === "send_not_started" && event.reason === "gate_broken");
      expect(failedNotice).toHaveLength(1);
      expect(failedNotice[0]).toMatchObject({ shape: "no_op", reason: "gate_broken" });
      expect(failedNotice[0]).not.toHaveProperty("turn_token");
      expect(rig.agyChildren).toHaveLength(1);
      expect(output.join("")).not.toContain("tokenless-541-marker");
    } finally {
      rig.host.close();
      await rig.done;
      stderr.mockRestore();
    }
  });
});
