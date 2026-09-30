import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";
import { CODEX_APPROVAL_SWITCH_AXES } from "../src/host.js";
import { cliAppFixture } from "./fixtures/cli_app_server.js";

// The approval-axis opt-in (ADR-0064): default off, per persona through the
// shared parser, app-server backend only.

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

afterEach(() => { vi.unstubAllEnvs(); });

async function compose(backend: "exec" | "app-server", env: Record<string, string>, extra: Partial<WrapperConfig> = {}) {
  vi.stubEnv("KAOIRO_CODEX_APPROVAL_AXIS", "");
  vi.stubEnv("KAOIRO_CODEX_APPROVAL_AXIS_PERSONAS", "");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  let hostOptions!: Record<string, any>;
  const sent: Envelope[] = [];
  const link = { close: () => {}, currentSessionId: () => null, send: (e: Envelope) => { sent.push(e); } };
  const host = { state: "idle", statusExtSnapshot: () => ({}), send: vi.fn(async () => {}), run: async () => {}, setPendingPermission: vi.fn() };
  await runCodexCli({
    backend,
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config, ...extra }),
    createServerLink: (_url, _agentId, options) => {
      queueMicrotask(() => { (options.onPersonaPrompt as (prompt: string) => void)("system prompt"); });
      return link as never;
    },
    createHost: (_config, options) => { hostOptions = options as unknown as Record<string, any>; return host as never; },
    prepareStartup: async () => {},
  });
  return { hostOptions, sent, host };
}

describe("approval axis opt-in composition", () => {
  it("is off by default and on the exec backend", async () => {
    for (const [backend, env] of [
      ["app-server", {}], ["exec", { KAOIRO_CODEX_APPROVAL_AXIS: "1" }], ["app-server", { KAOIRO_CODEX_APPROVAL_AXIS_PERSONAS: "other" }],
    ] as const) {
      const { hostOptions } = await compose(backend, env);
      expect(hostOptions, `${backend} ${JSON.stringify(env)}`).not.toHaveProperty("appServerApprovals");
    }
  });

  it.each([
    ["the global flag", { KAOIRO_CODEX_APPROVAL_AXIS: "1" }],
    ["the persona list", { KAOIRO_CODEX_APPROVAL_AXIS_PERSONAS: "other, p" }],
  ])("wires the shared broker for %s, with no deadline unless configured", async (_label, env) => {
    const { hostOptions, sent, host } = await compose("app-server", env);
    expect(hostOptions.appServerApprovals).toMatchObject({ deadlineMs: null, inactivityLimitMs: 1_800_000 });
    const decision = hostOptions.appServerApprovals.decide("codex:command_execution", { command: "ls" }, new AbortController().signal, { deadlineMs: null });
    expect(sent.filter(e => e.type === "permission_request").map(e => (e.payload as { tool_name: string }).tool_name)).toEqual(["codex:command_execution"]);
    expect(host.setPendingPermission).toHaveBeenLastCalledWith(expect.objectContaining({ tool_name: "codex:command_execution" }));
    void decision;
  });

  it("uses permission_timeout_ms as the approval deadline when configured", async () => {
    const { hostOptions } = await compose("app-server", { KAOIRO_CODEX_APPROVAL_AXIS: "1" }, { permission_timeout_ms: 90_000 });
    expect(hostOptions.appServerApprovals.deadlineMs).toBe(90_000);
  });
});

// Production defaults end to end: the CLI's broker, ServerLink, Host, Session
// and watchdog; only the app-server child, the Phoenix peer and time are
// simulated.
describe("approval axis through the default CLI composition", () => {
  async function approvalTurn() {
    vi.stubEnv("KAOIRO_CODEX_APPROVAL_AXIS", "1");
    const f = await cliAppFixture(true);
    const requested = { sandbox: "workspace-write", network_access: false, approval: "on-request" };
    f.wire.push("permission_sync", { version: "0", next: { revision: 1, requested },
      control: { revision: 1, requested, status: "pending", constraints: { approval: "never", enforcement: "os" } } });
    await f.inbound(1, "first");
    await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
    expect(f.turns()[0]!.params).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "user" });
    f.send({ id: 41, method: "item/commandExecution/requestApproval", params: {
      threadId: "thread", turnId: "turn-1", itemId: "exec-1", startedAtMs: 1, kind: "command", command: "touch x", cwd: "/w",
    } });
    await vi.waitFor(() => expect(f.envelopes("permission_request")).toHaveLength(1));
    const request = f.envelopes("permission_request")[0]!.payload as { request_id: string; tool_name: string };
    expect(request.tool_name).toBe("codex:command_execution");
    await vi.waitFor(() => expect((f.envelopes("state_change").at(-1)?.ext as Record<string, unknown> | undefined)?.pending_permission)
      .toMatchObject({ request_id: request.request_id }));
    return { f, request };
  }
  const lastExt = (f: Awaited<ReturnType<typeof cliAppFixture>>) =>
    f.envelopes("state_change").at(-1)?.ext as Record<string, unknown> | undefined;
  const replies = (f: Awaited<ReturnType<typeof cliAppFixture>>) => f.sent.filter(m => m.method === undefined && m.id === 41);

  it("advertises the axis and writes the operator's allow as accept", async () => {
    const { f, request } = await approvalTurn();
    try {
      const caps = lastExt(f)?.session_capabilities as Record<string, unknown>;
      expect(caps.permission_switch_axes).toEqual(CODEX_APPROVAL_SWITCH_AXES);
      f.wire.push("permission_decision", { request_id: request.request_id, allow: true });
      await vi.waitFor(() => expect(replies(f)).toEqual([{ id: 41, result: { decision: "accept" } }]));
      f.terminal();
      await vi.waitFor(() => expect(f.envelopes("result")).toHaveLength(1));
    } finally { await f.close(); }
  });

  it("writes an operator deny as decline", async () => {
    const { f, request } = await approvalTurn();
    try {
      f.wire.push("permission_decision", { request_id: request.request_id, allow: false, message: "not sent to codex" });
      await vi.waitFor(() => expect(replies(f)).toEqual([{ id: 41, result: { decision: "decline" } }]));
      f.terminal();
    } finally { await f.close(); }
  });

  it("the production watchdog ends an unanswered request with no write and clears the dialog", async () => {
    const { f, request } = await approvalTurn();
    try {
      f.clock.advance(60_000);
      await vi.waitFor(() => expect(f.interrupts()).toHaveLength(1));
      await vi.waitFor(() => expect(lastExt(f)?.pending_permission).toBeUndefined());
      f.wire.push("permission_decision", { request_id: request.request_id, allow: true });
      await f.drain();
      expect(replies(f)).toEqual([]);
      f.terminal("interrupted");
      await vi.waitFor(() => expect(f.envelopes("result")).toHaveLength(1));
      expect(replies(f)).toEqual([]);
    } finally { await f.close(); }
  });
});
