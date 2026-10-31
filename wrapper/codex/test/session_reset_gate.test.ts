import "../../../scripts/test/fixtures/test-isolation.mjs";
// Scripted SDK turns drive the production CLI, bridge and reset coordinator.
import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { PermissionBroker, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";
import { CodexHost } from "../src/host.js";
import type { CodexClientLike, CodexHostOptions, CodexThreadLike } from "../src/host.js";

const CONFIG: WrapperConfig = {
  agent_id: "host-1.codex-gate",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

type Ending = "completed" | "failed" | "eof" | "throw";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** One scripted SDK turn. A `tool` turn announces an mcp_tool_call and
 *  then parks until the test chooses how it ends — or until the SDK abort
 *  signal fires, which ends the stream the way a killed `codex exec`
 *  does. A plain turn completes at once. */
interface TurnScript {
  tool: boolean;
  ending: ReturnType<typeof deferred<Ending>>;
  /** How the stream reacts to the SDK abort signal: end quietly (the
   *  default) or throw, the way a killed `codex exec` surfaces as a
   *  runStreamed rejection (issue #349). */
  onAbort?: "eof" | "throw";
}

function turnCompleted(): ThreadEvent {
  return {
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

function makeThread(scripts: TurnScript[], options: ThreadOptions[]): CodexClientLike {
  const thread: CodexThreadLike = {
    async runStreamed(_input, turnOptions) {
      const script = scripts.shift();
      if (script === undefined) throw new Error("no scripted turn left");
      const signal = turnOptions?.signal;
      async function* gen(): AsyncGenerator<ThreadEvent> {
        if (!script!.tool) {
          yield turnCompleted();
          return;
        }
        yield {
          type: "item.started",
          item: {
            id: "call-1",
            type: "mcp_tool_call",
            server: "kaoiro",
            tool: "request_session_reset",
            arguments: { mode: "new" },
            status: "in_progress",
          },
        };
        const onAbort = script!.onAbort ?? "eof";
        const aborted = new Promise<Ending>((resolve) => {
          if (signal?.aborted) resolve(onAbort);
          signal?.addEventListener("abort", () => resolve(onAbort), { once: true });
        });
        const ending = await Promise.race([script!.ending.promise, aborted]);
        switch (ending) {
          case "completed":
            yield turnCompleted();
            return;
          case "failed":
            yield { type: "turn.failed", error: { message: "boom" } };
            return;
          case "eof":
            return;
          case "throw":
            throw new Error("Codex Exec exited with code 1");
        }
      }
      return { events: gen() };
    },
  };
  return {
    startThread: value => { options.push(value ?? {});return thread; },
    resumeThread: (_id, value) => { options.push(value ?? {});return thread; },
  };
}

/** Minimal bridge stand-in: one persistent connection, several calls. */
class FakeBridge {
  readonly #socket: Socket;
  readonly #pending = new Map<number, (line: Record<string, unknown>) => void>();
  #next = 1;
  #buffer = "";
  readonly closed = deferred();

  constructor(path: string) {
    this.#socket = createConnection(path);
    this.#socket.setEncoding("utf8");
    this.#socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline !== -1) {
        const line = JSON.parse(this.#buffer.slice(0, newline)) as Record<string, unknown>;
        this.#buffer = this.#buffer.slice(newline + 1);
        this.#pending.get(line.id as number)?.(line);
        this.#pending.delete(line.id as number);
        newline = this.#buffer.indexOf("\n");
      }
    });
    this.#socket.on("error", () => {});
    this.#socket.on("close", () => this.closed.resolve());
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => { this.#socket.once("connect", resolve); this.#socket.once("error", reject); });
  }

  call(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.#next++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#socket.write(`${JSON.stringify({ id, method: "call_tool", name, input })}\n`);
    });
  }

  destroy(): void {
    this.#socket.destroy();
  }
}

interface Rig {
  threadOptions: ThreadOptions[];
  sent: Envelope[];
  requests: { mode: string; reason?: string }[];
  requestSnapshots: { sentCount: number; state: string | undefined }[];
  turnEnds: Parameters<NonNullable<CodexHostOptions["onTurnEnd"]>>[0][];
  linkOptions: Record<string, any>;
  hostOptions: Record<string, any>;
  host: CodexHost;
  socketPath: string;
  turnTokens: string[];
  /** Runs the production entrypoint; settles once the host is closed. */
  done: Promise<void>;
  bridge: () => Promise<FakeBridge>;
}

async function makeRig(
  scripts: TurnScript[],
  configOverrides: Partial<WrapperConfig> = {},
): Promise<Rig> {
  const sent: Envelope[] = [];
  const requests: { mode: string; reason?: string }[] = [];
  const requestSnapshots: Rig["requestSnapshots"] = [];
  const turnEnds: Rig["turnEnds"] = [];
  const turnTokens: string[] = [];
  let linkOptions!: Record<string, any>;
  let hostOptions!: Record<string, any>;
  let host!: CodexHost;
  let captured: CodexOptions | null = null;
  const threadOptions: ThreadOptions[] = [];
  const client = makeThread(scripts, threadOptions);
  const link = {
    close: () => {},
    currentSessionId: () => null,
    reportPermissionLifecycle: vi.fn(),
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
  const done = runCodexCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...CONFIG, ...configOverrides }),
    createServerLink: (_url, _agentId, options) => {
      linkOptions = options as unknown as Record<string, any>;
      queueMicrotask(() => {
        (linkOptions.onPersonaPrompt as (prompt: string) => void)("system prompt");
      });
      return link as never;
    },
    createHost: (config, options) => {
      hostOptions = options as unknown as Record<string, any>;
      host = new CodexHost(config, {
        ...options,
        onTurnStart: (info) => {
          turnTokens.push(info.turnToken);
          options.onTurnStart?.(info);
        },
        onTurnEnd: (info) => {
          turnEnds.push(info);
          options.onTurnEnd?.(info);
        },
        backend: "exec", codexFactory: (codexOptions) => {
          captured = codexOptions;
          return client;
        },
        now: () => "T",
      });
      return host;
    },
    prepareStartup: async () => {},
  });
  await vi.waitFor(() => expect(host).toBeDefined());
  return {
    threadOptions,
    sent,
    requests,
    requestSnapshots,
    turnEnds,
    get linkOptions() {
      return linkOptions;
    },
    get hostOptions() {
      return hostOptions;
    },
    get host() {
      return host;
    },
    get socketPath() {
      const config = captured?.config as Record<string, unknown> | undefined;
      const mcp = config?.mcp_servers as
        | Record<string, { env: Record<string, string> }>
        | undefined;
      const path = mcp?.kaoiro?.env.KAOIRO_BRIDGE_SOCKET;
      if (path === undefined) throw new Error("bridge socket not yet configured");
      return path;
    },
    turnTokens,
    done,
    bridge: async function (this: Rig) {
      await vi.waitFor(() => expect(captured).not.toBeNull());
      const bridge = new FakeBridge(this.socketPath);
      await bridge.ready();
      return bridge;
    },
  };
}

function permissionRequests(sent: Envelope[]): Envelope[] {
  return sent.filter((e) => e.type === "permission_request");
}

function pendingPermissionOf(envelope: Envelope): unknown {
  return (envelope.ext as Record<string, unknown> | undefined)?.pending_permission;
}

/** Starts a turn by pushing an operator instruction through the real link
 *  callback and waits for the SDK turn to begin. */
async function startToolTurn(rig: Rig, conversationIds?: readonly string[]): Promise<string> {
  const before = rig.turnTokens.length;
  if (conversationIds === undefined) {
    await (rig.linkOptions.onInstruction as (text: string) => void)("reset yourself");
  } else {
    await rig.host.send("reset yourself", undefined, conversationIds);
  }
  await vi.waitFor(() => expect(rig.turnTokens.length).toBe(before + 1));
  return rig.turnTokens[before]!;
}

async function reserveReset(rig: Rig, bridge: FakeBridge): Promise<void> {
  const broker = vi.spyOn(PermissionBroker.prototype, "decide");
  let result: Record<string, unknown>;
  try {
    result = await bridge.call("request_session_reset", { mode: "new", reason: "tired" });
    expect(broker).not.toHaveBeenCalled();
  } finally { broker.mockRestore(); }
  expect(JSON.stringify(result)).toContain("reserved");
  expect(permissionRequests(rig.sent)).toHaveLength(0);
  expect(rig.sent.some(e => e.state === "waiting_permission" || pendingPermissionOf(e) !== undefined)).toBe(false);
}

async function finish(rig: Rig): Promise<void> {
  rig.host.close();
  await rig.done;
}

describe("codex request_session_reset gate (issue #347)", () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  afterEach(() => {
    stderr.mockClear();
  });

  it("autonomous → reserve → turn.completed sends session_reset_request once, in the right states", async () => {
    const script: TurnScript = { tool: true, ending: deferred<Ending>() };
    const rig = await makeRig([script]);
    try {
      const turnToken = await startToolTurn(rig, ["conv-completed"]);
      const bridge = await rig.bridge();
      await reserveReset(rig, bridge);
      expect(stderr.mock.calls.some(([text]) => String(text).includes("approved by the agent"))).toBe(true);
      expect(rig.requests).toHaveLength(0);
      const policy = rig.host.bridgeToolApproval(turnToken);
      expect(rig.threadOptions.at(-1)?.approvalPolicy).toBe("never");
      expect(policy).toEqual({ turn: rig.threadOptions.at(-1)?.approvalPolicy, next: "never", blocked: false });
      expect(rig.host.bridgeToolApproval("other-token").turn).toBeNull();
      script.ending.resolve("completed");
      await vi.waitFor(() => expect(rig.requests).toEqual([{ mode: "new", reason: "tired" }]));
      const snapshot = rig.requestSnapshots[0]!;
      expect(snapshot.state).toBe("waiting_input");
      expect(rig.sent.slice(0, snapshot.sentCount).some((e) => e.type === "result")).toBe(true);
      expect(rig.turnEnds).toEqual([{
        turnToken,
        conversationIds: ["conv-completed"],
        terminal: "turn.completed",
      }]);
      expect(rig.sent.some((e) => pendingPermissionOf(e) !== undefined && e.state !== "waiting_permission")).toBe(false);
      bridge.destroy();
    } finally {
      await finish(rig);
    }
  });

  it("exec ignores replayed strict approval when the approval axis is off", async () => {
    const script: TurnScript = { tool: true, ending: deferred<Ending>() };
    const rig = await makeRig([script], { sandbox: "read-only", network_access: false });
    try {
      const stored = { revision: 3, requested: {
        sandbox: "read-only", network_access: false, approval: "on-request",
      } };
      rig.linkOptions.permissionSync.onNegotiated(true);
      rig.linkOptions.permissionSync.onSync({ version: "0", next: stored,
        control: { ...stored, status: "pending", constraints: { approval: "never", enforcement: "os" } },
      });
      const token = await startToolTurn(rig);
      const bridge = await rig.bridge();
      try {
        expect(rig.threadOptions.at(-1)?.approvalPolicy).toBe("never");
        expect(rig.host.bridgeToolApproval(token)).toEqual({ turn: "never", next: "never", blocked: false });
        await reserveReset(rig, bridge);
        script.ending.resolve("completed");
        await vi.waitFor(() => expect(rig.requests).toHaveLength(1));
      } finally { bridge.destroy(); }
    } finally { await finish(rig); }
  });

  it("exec asks when permission becomes blocked during a live never turn", async () => {
    const script: TurnScript = { tool: true, ending: deferred<Ending>() };
    const rig = await makeRig([script], { sandbox: "read-only", network_access: false });
    const broker = vi.spyOn(PermissionBroker.prototype, "decide");
    try {
      const selection = { revision: 3, requested: { sandbox: "read-only", network_access: false } };
      rig.linkOptions.permissionSync.onNegotiated(true);
      rig.linkOptions.permissionSync.onSync({ version: "0", next: selection,
        control: { ...selection, status: "pending", constraints: { approval: "never", enforcement: "os" } },
      });
      const token = await startToolTurn(rig);
      const bridge = await rig.bridge();
      try {
        rig.linkOptions.permissionSync.onSync({ version: "0", next: selection,
          control: { ...selection, status: "failed", reason: "policy_mismatch",
            constraints: { approval: "never", enforcement: "os" } },
        });
        expect(rig.host.bridgeToolApproval(token)).toEqual({ turn: "never", next: "never", blocked: true });
        const call = bridge.call("request_session_reset", { mode: "new" });
        await vi.waitFor(() => expect(permissionRequests(rig.sent)).toHaveLength(1));
        expect(broker).toHaveBeenCalledTimes(1);
        expect(rig.sent.some(e => e.state === "waiting_permission" && pendingPermissionOf(e) !== undefined)).toBe(true);
        const request = permissionRequests(rig.sent)[0]!.payload as { request_id: string };
        rig.linkOptions.onPermissionDecision({ request_id: request.request_id, allow: false });
        expect(JSON.stringify(await call)).toContain("not approved");
        expect(rig.requests).toHaveLength(0);
        script.ending.resolve("completed");
        await vi.waitFor(() => expect(rig.turnEnds).toHaveLength(1));
        expect(rig.requests).toHaveLength(0);
      } finally { bridge.destroy(); }
    } finally { broker.mockRestore();await finish(rig); }
  });

  it("turn.failed is an authoritative terminal too: the reservation is sent", async () => {
    const script: TurnScript = { tool: true, ending: deferred<Ending>() };
    const rig = await makeRig([script]);
    try {
      const turnToken = await startToolTurn(rig, ["conv-failed"]);
      const bridge = await rig.bridge();
      await reserveReset(rig, bridge);
      script.ending.resolve("failed");
      await vi.waitFor(() => expect(rig.requests).toHaveLength(1));
      const snapshot = rig.requestSnapshots[0]!;
      expect(snapshot.state).toBe("waiting_input");
      expect(rig.sent.slice(0, snapshot.sentCount).some((e) => e.type === "result")).toBe(true);
      expect(rig.turnEnds).toEqual([{
        turnToken,
        conversationIds: ["conv-failed"],
        terminal: "turn.failed",
        error: { detail: "boom" },
      }]);
      bridge.destroy();
    } finally {
      await finish(rig);
    }
  });

  for (const ending of ["eof", "throw"] as const) {
    it(`autonomous → reserve → ${ending} without a terminal drops the reservation, and the next turn's completion sends nothing`, async () => {
      const script: TurnScript = { tool: true, ending: deferred<Ending>() };
      // The cancellation notice itself becomes a turn; give it a plain
      // completion so the "next unrelated turn end" case is exercised.
      const notice: TurnScript = { tool: false, ending: deferred<Ending>() };
      const rig = await makeRig([script, notice]);
      try {
        await startToolTurn(rig);
        const bridge = await rig.bridge();
        await reserveReset(rig, bridge);
        script.ending.resolve(ending);
        // The notice turn ran to its own authoritative completion.
        await vi.waitFor(() => expect(rig.turnTokens).toHaveLength(2));
        await vi.waitFor(() =>
          expect(rig.sent.filter((e) => e.type === "result")).toHaveLength(2),
        );
        expect(rig.requests).toHaveLength(0);
        expect(
          stderr.mock.calls.some(([line]) =>
            String(line).includes("reservation cancelled"),
          ),
        ).toBe(true);
        bridge.destroy();
      } finally {
        await finish(rig);
      }
    });
  }

  // An operator interrupt aborts the SDK run; depending on timing the stream
  // then ends quietly (terminal-less EOF) or rejects (run_streamed_rejected).
  // Both must drop the reservation AND name the operator (issue #349).
  for (const onAbort of ["eof", "throw"] as const) {
    it(`autonomous → reserve → interrupt (${onAbort}) drops the reservation and names the operator`, async () => {
      const script: TurnScript = { tool: true, ending: deferred<Ending>(), onAbort };
      const notice: TurnScript = { tool: false, ending: deferred<Ending>() };
      const rig = await makeRig([script, notice]);
      try {
        await startToolTurn(rig);
        const bridge = await rig.bridge();
        await reserveReset(rig, bridge);
        (rig.linkOptions.onInterrupt as () => void)();
        await vi.waitFor(() => expect(rig.turnTokens).toHaveLength(2));
        await vi.waitFor(() =>
          expect(rig.sent.filter((e) => e.type === "result")).toHaveLength(2),
        );
        expect(rig.requests).toHaveLength(0);
        const lines = stderr.mock.calls.map(([line]) => String(line));
        expect(
          lines.some((l) => l.includes("the operator interrupted the turn that reserved it")),
        ).toBe(true);
        expect(
          lines.some((l) => l.includes("ended without a confirmed result")),
        ).toBe(false);
        bridge.destroy();
      } finally {
        await finish(rig);
      }
    });
  }

  it("autonomous → reserve → watchdog fail-stop sends nothing", async () => {
    const script: TurnScript = { tool: true, ending: deferred<Ending>() };
    const rig = await makeRig([script]);
    try {
      const token = await startToolTurn(rig);
      const bridge = await rig.bridge();
      await reserveReset(rig, bridge);
      expect(rig.host.failStopTurnForWatchdog(token)).toBe(true);
      // A late terminal from the stuck stream is not admitted after a stop.
      script.ending.resolve("completed");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rig.requests).toHaveLength(0);
      bridge.destroy();
    } finally {
      await finish(rig);
    }
  });

  // Every entry that abandons a live turn from outside (reviews R2 / R3):
  // a terminal the SDK had already produced must not carry the reservation,
  // and the cancellation names the actual cause.
  const ABANDON_ENTRIES: Record<
    string,
    { act: (rig: Rig, token: string) => void; cause: string; noticeTurn: boolean }
  > = {
    operator: {
      act: (rig) => (rig.linkOptions.onInterrupt as () => void)(),
      cause: "the operator interrupted the turn that reserved it",
      noticeTurn: true,
    },
    watchdog: {
      act: (rig, token) => {
        expect(rig.host.requestInterruptForTurn(token)).toBe(true);
      },
      cause: "the turn watchdog interrupted the turn that reserved it",
      noticeTurn: true,
    },
    close: {
      act: (rig) => rig.host.close(),
      cause: "the wrapper shut down before the turn that reserved it ended",
      noticeTurn: false,
    },
  };

  for (const [entry, { act, cause, noticeTurn }] of Object.entries(ABANDON_ENTRIES)) {
    for (const ending of ["completed", "failed"] as const) {
      it(`${entry}: a terminal (${ending}) already produced when the turn is abandoned does not carry the reservation`, async () => {
        const script: TurnScript = { tool: true, ending: deferred<Ending>() };
        const notice: TurnScript = { tool: false, ending: deferred<Ending>() };
        const rig = await makeRig([script, notice]);
        try {
          const token = await startToolTurn(rig);
          const bridge = await rig.bridge();
          await reserveReset(rig, bridge);
          // The SDK terminal is ready before the abort can win the race, so
          // the host still observes turn.${ending} after the abandonment.
          script.ending.resolve(ending);
          act(rig, token);
          if (noticeTurn) {
            // The cancellation notice turn completes on its own; still nothing.
            await vi.waitFor(() => expect(rig.turnTokens).toHaveLength(2));
            await vi.waitFor(() =>
              expect(rig.sent.filter((e) => e.type === "result")).toHaveLength(2),
            );
          } else {
            await rig.done;
          }
          expect(rig.requests).toHaveLength(0);
          const lines = stderr.mock.calls.map(([line]) => String(line));
          expect(lines.some((l) => l.includes(cause))).toBe(true);
          for (const other of Object.values(ABANDON_ENTRIES)) {
            if (other.cause !== cause) {
              expect(lines.some((l) => l.includes(other.cause))).toBe(false);
            }
          }
          bridge.destroy();
        } finally {
          await finish(rig);
        }
      });
    }
  }

  it("a retired exec endpoint rejects connections without a dialog", async () => {
    const script: TurnScript = { tool: false, ending: deferred<Ending>() };
    const rig = await makeRig([script]);
    try {
      await startToolTurn(rig);
      await vi.waitFor(() =>
        expect(rig.sent.filter((e) => e.type === "result")).toHaveLength(1),
      );
      await expect(rig.bridge()).rejects.toMatchObject({ code: "ENOENT" });
      expect(permissionRequests(rig.sent)).toHaveLength(0);
      expect(rig.requests).toHaveLength(0);
    } finally {
      await finish(rig);
    }
  });


});
