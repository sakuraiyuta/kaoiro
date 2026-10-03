import { describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "@kaoiro/wrapper-core";
import { cliAppFixture } from "./fixtures/cli_app_server.js";

const rateLimitStates = (f: Awaited<ReturnType<typeof cliAppFixture>>) => f.envelopes("state_change")
  .map(envelope => (envelope as { ext?: { rate_limits?: unknown } }).ext?.rate_limits)
  .filter((value): value is Record<string, unknown> => value !== undefined);
const rateNotification = (usedPercent: number, windowDurationMins = 10080, limitId = "codex") => ({
  method: "account/rateLimits/updated",
  params: { rateLimits: {
    limitId,
    primary: { windowDurationMins, usedPercent, resetsAt: 1791431221 },
    secondary: null,
  } },
});

it("starts the real watchdog only at dispatch, extends on matching progress, and stops at terminal", async () => {
  const f = await cliAppFixture(true);
  try {
    await f.inbound(1, "first");
    await vi.waitFor(() => expect(f.permissionWaits > 0 || f.turns().length > 0).toBe(true));
    expect(f.permissionWaits).toBeGreaterThan(0);await f.drain();
    expect(f.turns()).toHaveLength(0);expect(f.clock.size).toBe(0);expect(f.acks()).toEqual([]);
    f.clock.advance(120000);expect(f.interrupts()).toHaveLength(0);
    f.wire.push("permission_sync", { version: "0", next: { revision: 1, requested: { sandbox: "workspace-write", network_access: false } }, control: { revision: 1, requested: { sandbox: "workspace-write", network_access: false }, status: "pending", constraints: { approval: "never", enforcement: "os" } } });
    await vi.waitFor(() => expect(f.turns()).toHaveLength(1));expect(f.clock.size).toBe(1);await f.waitForAcks([1]);
    f.clock.advance(59000);
    f.send({ method: "item/completed", params: { threadId: "thread", turnId: "turn-1", item: { id: "progress", type: "agentMessage", text: "progress" } } });
    await vi.waitFor(() => expect(f.envelopes("log").some(e => (e.payload as any).text === "progress")).toBe(true));
    f.clock.advance(59000);expect(f.interrupts()).toHaveLength(0);
    // Neither unrelated notifications nor incoming operator work is model progress.
    f.send({ method: "item/completed", params: { threadId: "other", turnId: "turn-1", item: { id: "other", type: "agentMessage", text: "other" } } });
    f.send({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 } } } });
    f.wire.push("instruction", { version: "0", text: "queued" });
    await vi.waitFor(() => expect(f.rateLimits?.buckets[0]?.windows.five_hour?.utilization).toBe(0.01));
    await vi.waitFor(() => expect(f.queued).toContain("queued"));f.clock.advance(1000);
    await vi.waitFor(() => expect(f.interrupts()).toHaveLength(1));expect(f.turns()).toHaveLength(1);
    f.terminal("interrupted");await vi.waitFor(() => expect(f.envelopes("result")).toHaveLength(1));
    // Queued work is now waiting on the observation gate, with no watchdog timer.
    expect(f.clock.size).toBe(0);f.clock.advance(120000);expect(f.interrupts()).toHaveLength(1);
  } finally { await f.close(); }
});

it("forwards a post-open Codex rate notification through runCodexCli while fencing the older read", async () => {
  const f = await cliAppFixture(false, "app-server", "legacy", { holdRateLimitRead: true });
  const rates = () => rateLimitStates(f);
  try {
    await f.inbound(1, "rate-refresh");
    await vi.waitFor(() => expect(f.rateLimitReadPending).toBe(true));

    f.send({ method: "account/rateLimits/updated", params: { rateLimits: {
      limitId: "codex",
      primary: { windowDurationMins: 300, usedPercent: 35, resetsAt: 1791431221 },
      secondary: { windowDurationMins: 10080, usedPercent: 47, resetsAt: 1791431221 },
    } } });
    await vi.waitFor(() => expect(rates().at(-1)).toEqual({
      five_hour: { utilization: 0.35, resets_at: 1791431221 },
      seven_day: { utilization: 0.47, resets_at: 1791431221 },
    }));

    f.send(rateNotification(48));
    await vi.waitFor(() => expect(rates().at(-1)).toEqual({
      seven_day: { utilization: 0.48, resets_at: 1791431221 },
    }));

    f.completeRateLimitRead({ rateLimitsByLimitId: { codex: {
      limitId: "codex",
      primary: { windowDurationMins: 300, usedPercent: 1, resetsAt: 1234 },
      secondary: { windowDurationMins: 10080, usedPercent: 2, resetsAt: 5678 },
    } } });
    await vi.waitFor(() => expect(f.rateLimits?.buckets[0]?.windows).toEqual({
      seven_day: { utilization: 0.48, resets_at: 1791431221 },
    }));
    await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    f.terminal();await vi.waitFor(() => expect(f.envelopes("result")).toHaveLength(1));
    expect(rates().at(-1)).toEqual({ seven_day: { utilization: 0.48, resets_at: 1791431221 } });
  } finally { await f.close(); }
});

it("does not project another limitId into the Codex meter", async () => {
  const f = await cliAppFixture();
  try {
    await f.inbound(1, "non-codex-rate");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    f.send(rateNotification(99, 300, "images"));
    f.send(rateNotification(47));
    await vi.waitFor(() => expect(rateLimitStates(f)).toEqual([
      { seven_day: { utilization: 0.47, resets_at: 1791431221 } },
    ]));
  } finally { await f.close(); }
});

it("suppresses a duplicate Codex rate snapshot", async () => {
  const f = await cliAppFixture();
  try {
    await f.inbound(1, "duplicate-rate");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    f.send(rateNotification(47));
    f.send(rateNotification(47));
    f.send(rateNotification(48));
    await vi.waitFor(() => expect(rateLimitStates(f).at(-1)).toEqual({
      seven_day: { utilization: 0.48, resets_at: 1791431221 },
    }));
    expect(rateLimitStates(f)).toEqual([
      { seven_day: { utilization: 0.47, resets_at: 1791431221 } },
      { seven_day: { utilization: 0.48, resets_at: 1791431221 } },
    ]);
  } finally { await f.close(); }
});

it("does not project a rate notification after the runtime is closed", async () => {
  const f = await cliAppFixture(false, "app-server", "legacy", { holdChildExitOnClose: true, shutdownTimeoutMs: 5000 });
  try {
    await f.inbound(1, "closed-rate");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    f.send(rateNotification(47));
    await vi.waitFor(() => expect(rateLimitStates(f)).toEqual([
      { seven_day: { utilization: 0.47, resets_at: 1791431221 } },
    ]));
    f.host.close();
    f.send(rateNotification(48));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(rateLimitStates(f)).toEqual([
      { seven_day: { utilization: 0.47, resets_at: 1791431221 } },
    ]);
    f.releaseChildClose();await f.running;
  } finally { f.releaseChildClose();await f.close(); }
});

it("fences interrupt by Host token, keeps the queue until interrupted terminal, then resumes it", async () => {
  const f = await cliAppFixture();
  try {
    await f.inbound(1, "first");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    const token = f.host.activeInterAgentTurnToken()!;
    await f.inbound(2, "second");await f.drain();
    expect(f.host.requestInterruptForTurn("stale")).toBe(false);expect(f.interrupts()).toHaveLength(0);
    expect(f.host.requestInterruptForTurn(token)).toBe(true);
    await vi.waitFor(() => expect(f.interrupts()).toHaveLength(1));expect(f.turns()).toHaveLength(1);await f.waitForAcks([1]);
    expect(f.interrupts()[0]?.params).toEqual({ threadId: "thread", turnId: "turn-1" });
    f.terminal("interrupted");await vi.waitFor(() => expect(f.turns()).toHaveLength(2));
    expect(f.host.requestInterruptForTurn(token)).toBe(false);
    await f.waitForAcks([1, 2]);f.terminal();await vi.waitFor(() => expect(f.envelopes("result")).toHaveLength(2));
    expect(f.spawned).toBe(1);expect(f.clock.size).toBe(0);
  } finally { await f.close(); }
});

it.each(["exec", "app-server"] as const)("%s fail-stops once, retires pending and dispatched-but-unstarted IA, and ignores late terminal", async backend => {
  const f = await cliAppFixture(false, backend, "legacy", { stages: true });
  const stderr = vi.spyOn(process.stderr, "write");
  try {
    await f.inbound(1, "active");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    await f.inbound(2, "pending");await f.inbound(3, "queued", "queued", "other.peer");
    await f.drain();expect(f.acks()).toEqual([1]);
    f.clock.advance(60000);
    if (backend === "app-server") await vi.waitFor(() => expect(f.interrupts()).toHaveLength(1));
    f.clock.advance(1000);
    expect(stderr.mock.calls.filter(([text]) => String(text).includes("turn watchdog fail-stop:"))).toHaveLength(1);
    f.releaseExec();await f.running;
    expect(f.envelopes("result")).toHaveLength(0);expect(f.turns()).toHaveLength(1);expect(f.spawned).toBe(1);
    expect(f.envelopes("state_change").filter(e => e.state === "error")).toHaveLength(1);
    expect(stderr.mock.calls.filter(([text]) => String(text).includes("turn watchdog interrupt grace expired"))).toHaveLength(1);
    const retire = f.wire.received.filter(e => e.event === "delivery_resync");
    expect(retire.length).toBeGreaterThan(0);
    expect(retire.flatMap(e => e.payload.missing_ranges as number[][]).sort((a, b) => a[0]! - b[0]!)).toEqual([[2, 2], [3, 3]]);
    await f.host.send("after");f.clock.advance(120000);expect(f.turns()).toHaveLength(1);expect(f.acks()[0]).toBe(1);
    expect(f.wire.received.filter(e => e.event === "session_reset_request")).toHaveLength(0);
  } finally { stderr.mockRestore();await f.close(); }
});

it.each(["completed", "interrupted", "eof", "fail-stop"])("keeps approved reset bound to its %s terminal through the real broker and coordinator", async status => {
  const f = await cliAppFixture();
  try {
    await f.inbound(1, "reset");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    const call = f.tool("request_session_reset", { mode: "new", reason: "fixture" });
    await vi.waitFor(() => expect(f.envelopes("permission_request")).toHaveLength(1));
    const pending = f.envelopes("permission_request")[0]!.payload as { request_id: string };
    expect(f.wire.received.filter(e => e.event === "session_reset_request")).toHaveLength(0);
    f.wire.push("permission_decision", { version: "0", request_id: pending.request_id, allow: true });
    expect(JSON.stringify(await call)).toContain("reserved");
    expect(f.wire.received.filter(e => e.event === "session_reset_request")).toHaveLength(0);
    if (status === "eof") { f.exit();await f.running; }
    else if (status === "fail-stop") { f.clock.advance(60000);await vi.waitFor(() => expect(f.interrupts()).toHaveLength(1));f.clock.advance(1000);await f.running;expect(f.envelopes("result")).toHaveLength(0); }
    else { f.terminal(status);await vi.waitFor(() => expect(f.envelopes("result")).toHaveLength(1)); }
    if (status === "completed") await vi.waitFor(() => expect(f.wire.received.filter(e => e.event === "session_reset_request")).toHaveLength(1));
    else {
      if (status === "interrupted") { await vi.waitFor(() => expect(f.finalized).toHaveLength(1));await f.drain(); }
      expect(f.wire.received.filter(e => e.event === "session_reset_request")).toHaveLength(0);
    }
  } finally { await f.close(); }
});

it("does not let an old Host settlement resolve the next same-conversation lease", async () => {
  const f = await cliAppFixture();
  try {
    await f.inbound(1, "lease");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    const old = f.host.activeInterAgentTurnToken()!;
    expect(JSON.stringify(await f.tool("send_to_agent", { to: "peer.agent", conversation_id: "lease", kind: "response", body: "first reply" }))).toContain("sent");
    await f.inbound(2, "lease", "NEXT_GENERATION", "peer.agent", 3);
    await f.drain();expect(f.turns()).toHaveLength(1);await f.waitForAcks([1]);
    f.terminal();await vi.waitFor(() => expect(f.turns()).toHaveLength(2));
    const notices = () => f.envelopes("inter_agent_message").filter(e => (e.payload as any).error);
    await f.drain();expect(notices()).toHaveLength(0);
    // Inject a duplicate old boundary at the CLI callback surface, not the new token.
    f.callbacks.onTurnEnd?.({ turnToken: old, conversationIds: ["lease"], terminal: "turn.failed", error: { detail: "old failure" } });
    await f.drain();expect(notices()).toHaveLength(0);
    f.terminal("failed");await vi.waitFor(() => expect(notices()).toHaveLength(1));
    expect(f.turns()).toHaveLength(2);expect(f.acks()).toEqual([1, 2]);
  } finally { await f.close(); }
});

it.each([undefined, "exec", "app-server"] as const)("selects only the published config backend (%s), ignoring other hints", async backend => {
  const { runCodexCli } = await import("../src/cli.js");
  const signals = process.listeners("SIGINT"), argv = process.argv;let selected: unknown;
  process.argv = [...argv.slice(0, 2), "--backend", "app-server"];
  vi.stubEnv("KAOIRO_CODEX_BACKEND", "app-server");
  try {
    await runCodexCli({
      parseCliArgs: () => ({ configPath: "fixture", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ agent_id: "ordinary", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://fixture", backend: "app-server", ...(backend === undefined ? {} : { codex_backend: backend }) }),
      createServerLink: (_url, _id, callbacks) => {
        queueMicrotask(() => callbacks.onPersonaPrompt?.("Fixture"));
        return { send() {}, close() {}, currentSessionId: () => null } as never;
      },
      createHost: (_config, options) => { selected = options.backend;return { state: "idle", statusExtSnapshot: () => ({}), run: async () => {} } as never; },
      prepareStartup: async () => {},
    });
    expect(selected).toBe(backend ?? "exec");
  } finally {
    for (const listener of process.listeners("SIGINT")) if (!signals.includes(listener)) process.removeListener("SIGINT", listener);
    process.argv = argv;vi.unstubAllEnvs();
  }
});

it("does not accept a public backend CLI flag", () => {
  expect(() => parseCliArgs(["--backend", "app-server"])).toThrow();
  expect(() => parseCliArgs(["--codex-backend", "app-server"])).toThrow();
});


it("reports public app-server startup failure without exec fallback or another Session", async () => {
  const { runCodexCli } = await import("../src/cli.js");
  const { CodexHost } = await import("../src/host.js");
  const { phoenixLoopback } = await import("./fixtures/phoenix_loopback.js");
  const wire = await phoenixLoopback(() => ({})), signals = process.listeners("SIGINT");
  const exec = vi.fn(() => { throw new Error("Unexpected exec fallback"); });
  const session = vi.fn(async () => { throw new Error("Required bridge startup failed"); });
  let host: InstanceType<typeof CodexHost> | undefined;
  const running = runCodexCli({
    parseCliArgs: () => ({ configPath: "fixture", prompt: "FIRST", resume: undefined }),
    loadConfig: () => ({ agent_id: "startup-failure", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: wire.url, codex_backend: "app-server" }),
    createHost: (config, options) => (host = new CodexHost(config, { ...options, codexFactory: exec, appServerSessionFactory: session })),
  });
  try {
    await vi.waitFor(() => expect(wire.joins).toBe(1));wire.push("persona_prompt", { prompt: "Fixture" });
    await running;
    const envelopes = wire.received.filter(e => e.event === "envelope").map(e => e.payload);
    expect(envelopes.some(e => e.type === "state_change" && e.state === "error")).toBe(true);
    expect(envelopes.filter(e => e.type === "result")).toHaveLength(1);
    expect(envelopes.find(e => e.type === "result")?.payload).toMatchObject({ is_error: true, error_detail: "Error: Required bridge startup failed" });
    await host!.send("AFTER_FAILURE");expect(session).toHaveBeenCalledTimes(1);expect(exec).not.toHaveBeenCalled();
  } finally {
    host?.close();await running;await wire.close();
    for (const listener of process.listeners("SIGINT")) if (!signals.includes(listener)) process.removeListener("SIGINT", listener);
  }
});

it("waits for wire acknowledgements independently of JSONL dispatch on consecutive turns", async () => {
  const f = await cliAppFixture();
  let resume: (() => unknown) | undefined;
  try {
    for (const seq of [1, 2]) {
      resume = f.wire.pauseInbound();
      await f.inbound(seq, `delayed-${seq}`);
      await vi.waitFor(() => expect(f.turns()).toHaveLength(seq));
      expect(f.acks()).toEqual(seq === 1 ? [] : [1]);
      const received = f.waitForAcks(seq === 1 ? [1] : [1, 2]);
      resume();resume = undefined;await received;
      f.terminal();await vi.waitFor(() => expect(f.finalized).toHaveLength(seq));await f.drain();
    }
  } finally { resume?.();await f.close(); }
});

it("does not confuse a received frame with completion of the asynchronous inbound handler", async () => {
  const f = await cliAppFixture(), held = f.holdNextInbound();
  const resume = f.wire.pauseInbound();
  let processed = false, drained = false;
  try {
    const draining = f.drain().then(() => { drained = true; });
    const pending = f.inbound(1, "held").then(() => { processed = true; });
    await held.entered;
    expect(processed).toBe(false);expect(drained).toBe(false);expect(f.turns()).toHaveLength(0);
    held.release();resume();await pending;await draining;
    expect(f.wire.received.filter(e => e.event === "directory_request")).toHaveLength(1);
    await vi.waitFor(() => expect(f.turns()).toHaveLength(1));await f.waitForAcks([1]);
    f.terminal();await vi.waitFor(() => expect(f.finalized).toHaveLength(1));
  } finally { held.release();resume();await f.close(); }
});

it.each(["v1", "legacy"] as const)("%s join hands off a legacy peer error through the waiter and permits the next reply", async mode => {
  const f = await cliAppFixture(false, "app-server", mode);
  try {
    await f.inbound(1, "mixed"); await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    const waiting = f.tool("send_to_agent", { to: "peer.agent", conversation_id: "mixed", kind: "query", body: "question", wait_for_response: true, timeout_ms: 2000 });
    await vi.waitFor(() => expect(f.envelopes("inter_agent_message")).toHaveLength(1));
    const outgoing = f.envelopes("inter_agent_message")[0]!;
    expect((outgoing.payload as { in_reply_to?: number }).in_reply_to).toBe(mode === "v1" ? 1 : undefined);
    f.wire.push("envelope", { ...outgoing, agent_id: "peer.agent", delivery_seq: 2, ingress_stamp: [1, 2], payload: {
      to: outgoing.agent_id, conversation_id: "mixed", turn_number: 3, kind: "inform", body: "peer failed", error: { code: "api_error", message: "peer failed" },
    } });
    const response = await waiting;
    const result = JSON.parse(response.result.content[0].text);
    expect(result.peer_error.code).toBe("api_error"); expect(result.peer_error_envelope.payload.turn_number).toBe(3);
    expect(result.reply_authorization.in_reply_to).toBe(3); await f.waitForAcks([1, 2]);
    const reply = await f.tool("send_to_agent", { to: "peer.agent", conversation_id: "mixed", kind: "response", body: "received failure", ...result.reply_authorization });
    expect(reply.result.isError).toBeUndefined();
    expect((f.envelopes("inter_agent_message")[1]!.payload as { in_reply_to?: number }).in_reply_to).toBe(mode === "v1" ? 3 : undefined);
    expect(f.turns()).toHaveLength(1);
  } finally { await f.close(); }
});

it("stale send transfers a queued body through the real recovery response without another SDK turn", async () => {
  const f = await cliAppFixture(false, "app-server", "v1");
  try {
    await f.inbound(1, "recover"); await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    await f.inbound(2, "recover", "LATEST_PEER_BODY", "peer.agent", 3); await f.waitForAcks([1]);
    const args = { to: "peer.agent", conversation_id: "recover", kind: "response", body: "reply" };
    const b = await f.tool("send_to_agent", { ...args, in_reply_to: 3 });
    expect(JSON.stringify(b)).toContain("reply_ticket_required"); expect(f.envelopes("inter_agent_message")).toHaveLength(0);
    f.rejectNextSend({ reason: "stale_reply_basis", expected_peer_turn: 3, supplied_basis: 1, conversation_id: "recover" });
    const a = await f.tool("send_to_agent", args);
    expect(a.result.isError).toBe(true);
    const recovery = JSON.parse(a.result.content[0].text);
    expect(recovery.recovery[0].payload.body).toBe("LATEST_PEER_BODY"); expect(recovery.unread_remaining).toBe(0);
    await f.waitForAcks([1, 2]);
    const c = await f.tool("send_to_agent", { ...args, ...recovery.reply_authorization });
    expect(c.result.isError).toBeUndefined();
    expect((f.envelopes("inter_agent_message")[1]!.payload as { in_reply_to: number }).in_reply_to).toBe(3);
    f.terminal(); await vi.waitFor(() => expect(f.finalized).toHaveLength(1)); await f.drain();
    expect(f.turns()).toHaveLength(1); expect(f.acks()).toEqual([1, 2]);
  } finally { await f.close(); }
});

it.each(["exec", "app-server"] as const)("%s ToolHost write applies plain and issued-ticket guidance at its real handoff boundary", async backend => {
  const f = await cliAppFixture(false, backend, "v1");
  try {
    await f.inbound(1, "plain-reply");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    const args = { to: "peer.agent", conversation_id: "plain-reply", kind: "response", body: "reply" };
    const plain = await f.tool("send_to_agent", { ...args, in_reply_to: 1 });
    expect(plain.result).toMatchObject({ isError: true });
    expect(JSON.parse(plain.result.content[0].text)).toEqual({
      error: "reply_ticket_required", send_not_attempted: true,
      guidance: "This in_reply_to matches the frozen basis for a confirmed input in this turn, and no reply authorization has been handed off for this tuple. Resend as a normal reply with both in_reply_to and reply_ticket omitted.",
    });
    expect(f.envelopes("inter_agent_message")).toHaveLength(0);
    const sent = await f.tool("send_to_agent", args);
    expect(sent.result.isError).toBeUndefined();
    expect((f.envelopes("inter_agent_message")[0]!.payload as { in_reply_to?: number }).in_reply_to).toBe(1);
  } finally { await f.close(); }
});

it.each(["exec", "app-server"] as const)("%s ToolHost guidance preserves ticket basis and keeps issued-ticket refusal actionable", async backend => {
  const f = await cliAppFixture(false, backend, "v1");
  try {
    await f.inbound(1, "ticketed");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    await f.inbound(2, "ticketed", "LATEST_PEER_BODY", "peer.agent", 3);await f.waitForAcks([1]);
    const args = { to: "peer.agent", conversation_id: "ticketed", kind: "response", body: "reply" };
    f.rejectNextSend({ reason: "stale_reply_basis", expected_peer_turn: 3, supplied_basis: 1, conversation_id: "ticketed" });
    const recovery = await f.tool("send_to_agent", args);
    const auth = JSON.parse(recovery.result.content[0].text).reply_authorization as { in_reply_to: number; reply_ticket: string };
    expect(auth.in_reply_to).toBe(3);
    await f.waitForAcks([1, 2]);
    const afterRecovery = f.envelopes("inter_agent_message").length;

    const matching = await f.tool("send_to_agent", { ...args, in_reply_to: 3 });
    expect(JSON.parse(matching.result.content[0].text)).toEqual({
      error: "reply_ticket_required", send_not_attempted: true,
      guidance: "Copy both fields from the original reply_authorization; an unspent, unexpired ticket can be retried.",
    });
    const differentBasis = await f.tool("send_to_agent", { ...args, in_reply_to: 1 });
    expect(JSON.parse(differentBasis.result.content[0].text)).toEqual({
      error: "reply_ticket_required", send_not_attempted: true,
      guidance: "A usable reply_authorization exists for a different in_reply_to. Do not use it or omit both fields. Wait for a new confirmed input or a handed-off reply_authorization matching in_reply_to=1.",
    });
    expect(f.envelopes("inter_agent_message")).toHaveLength(afterRecovery);
  } finally { await f.close(); }
});

describe("delivery stages when turn/start may or may not have been delivered", () => {
  const stages = (reports: Array<Record<string, unknown>>) => reports.map(report => report.stage).filter(stage => stage !== "queued");
  const peerErrorCodes = (f: Awaited<ReturnType<typeof cliAppFixture>>) =>
    f.envelopes("inter_agent_message").map(e => (e.payload as { error?: { code?: string } }).error?.code);

  it("ends on unknown, with no settled, when the app-server ends after turn/start was written", async () => {
    const f = await cliAppFixture(false, "app-server", "legacy", { stages: true, turnStart: () => "exit" });
    try {
      await f.inbound(1, "c1");
      await vi.waitFor(() => expect(stages(f.stageReports(1))).toEqual(["unknown"]), { timeout: 10_000 });
      expect(f.stageReports(1).find(report => report.stage === "unknown")).toMatchObject({ reason: "turn_start_disconnected", incarnation: "inc-451" });
      // The wrapper stops with its app-server; once it has exited nothing more can be reported.
      await f.running;
      expect(stages(f.stageReports(1))).toEqual(["unknown"]);
      // The turn may still be running, so the peer is told to wait, not to retry.
      expect(peerErrorCodes(f)).toEqual(["timeout"]);
    } finally { await f.close(); }
  });

  it("stays failed_before_handoff when turn/start is answered with an error", async () => {
    const f = await cliAppFixture(false, "app-server", "legacy", { stages: true, turnStart: () => "reject" });
    try {
      await f.inbound(1, "c1");
      await vi.waitFor(() => expect(stages(f.stageReports(1))).toEqual(["settled"]), { timeout: 10_000 });
      expect(f.stageReports(1).find(report => report.stage === "settled")).toMatchObject({ reason: "failed_before_handoff" });
      await vi.waitFor(() => expect(peerErrorCodes(f)).toEqual(["api_error"]), { timeout: 10_000 });
    } finally { await f.close(); }
  });

  it("is unchanged for a successful turn: submitted, then settled at the turn end", async () => {
    const f = await cliAppFixture(false, "app-server", "legacy", { stages: true });
    try {
      await f.inbound(1, "c1");
      await vi.waitFor(() => expect(stages(f.stageReports(1))).toEqual(["submitted"]), { timeout: 10_000 });
      f.terminal();
      await vi.waitFor(() => expect(stages(f.stageReports(1))).toEqual(["submitted", "settled"]), { timeout: 10_000 });
      expect(f.stageReports(1).find(report => report.stage === "submitted")).toMatchObject({ handoff: "turn_start_accepted" });
      expect(f.stageReports(1).find(report => report.stage === "settled")).toMatchObject({ reason: "turn_end" });
    } finally { await f.close(); }
  });
});

it("reports the Codex home it runs against", async () => {
  const stderr = vi.spyOn(process.stderr, "write");
  const f = await cliAppFixture(false, "app-server");
  try {
    expect(process.env.CODEX_HOME, "premise: the fixture isolates CODEX_HOME").toBeTruthy();
    expect(stderr.mock.calls.some(([text]) => String(text) === `codex: home=${process.env.CODEX_HOME}\n`)).toBe(true);
  } finally { stderr.mockRestore();await f.close(); }
});
