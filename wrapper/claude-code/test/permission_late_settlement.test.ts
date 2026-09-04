// issue #285 regression: a permission decision that arrives after its own
// turn already ended. The 2026-08-31 freeze followed exactly this order —
// canUseTool pending, turn watchdog interrupt, error/waiting_input, and 70
// minutes later the operator answered the dialog that was still on screen.
//
// The turn must be wrapper-fed here: ownership is keyed on the SDK-active
// turn token, so a fake that never drains args.prompt would leave every wait
// unowned and measure nothing.

import { describe, expect, it } from "vitest";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentHost } from "../src/host.js";
import type { AgentHostOptions } from "../src/host.js";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";

const config: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const msg = (shape: unknown): SDKMessage => shape as SDKMessage;
const assistant = (content: unknown): SDKMessage =>
  msg({ type: "assistant", message: { content } });
const result = (subtype: string): SDKMessage => msg({ type: "result", subtype });
const toolUse = (id: string): Record<string, unknown> => ({
  type: "tool_use",
  id,
  name: "Bash",
  input: { command: "git rebase origin/develop" },
});

type QueryArgs = { prompt: AsyncIterable<SDKUserMessage>; options: Options };
type QueryFn = NonNullable<AgentHostOptions["queryFn"]>;

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

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

interface AbandonedRun {
  envelopes: Envelope[];
  states: string[];
  warnings: string[];
  answer: (allow: boolean) => void;
  finish: () => Promise<void>;
}

/** Drives one host to the exact incident position: a permission request whose
 *  turn has already been torn down by an interrupt, with the decision still
 *  unanswered and the SDK stream still open for later turns. */
async function runToAbandonedPermission(): Promise<AbandonedRun> {
  const envelopes: Envelope[] = [];
  const warnings: string[] = [];
  const decision = deferred<{ allow: boolean }>();
  const requested = deferred();
  const streamOpen = deferred();

  const queryFn = ((args: QueryArgs) => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      const input = args.prompt[Symbol.asyncIterator]();
      await input.next();
      yield assistant([toolUse("tu_1")]);
      void args.options.canUseTool!("Bash", toolUse("tu_1").input as never, {
        signal: new AbortController().signal,
      } as never);
      await requested.promise;
      // The watchdog interrupt lands: the SDK abandons the tool call and
      // ends the turn without ever reading the permission answer.
      yield result("error");
      await streamOpen.promise;
    }
    return Object.assign(gen(), {
      interrupt: async () => {},
    }) as unknown as Query;
  }) as unknown as QueryFn;

  let host!: AgentHost;
  host = new AgentHost(config, {
    onState: (envelope) => envelopes.push(envelope),
    warn: (message) => warnings.push(message),
    // Mirrors PermissionBroker.decide: stamp the authoritative pending
    // record synchronously (ADR-0022 F3), clear it only on settle.
    decidePermission: () => {
      host.setPendingPermission({
        request_id: "req_1",
        tool_name: "Bash",
        ts: "T",
      });
      requested.resolve();
      return decision.promise.then((answer) => {
        host.setPendingPermission(null);
        return answer;
      });
    },
    queryFn,
    now: () => "T",
  });
  const running = host.run();
  await host.send("go");

  while (!envelopes.some((envelope) => envelope.state === "waiting_input")) {
    await flush();
  }
  await flush();

  return {
    envelopes,
    warnings,
    get states() {
      return envelopes.map((envelope) => envelope.state);
    },
    answer: (allow) => decision.resolve({ allow }),
    finish: async () => {
      streamOpen.resolve();
      host.close();
      await running;
    },
  };
}

describe("issue #285 — permission decision after its turn ended", () => {
  it("does not re-enter tool_running when the answer arrives late", async () => {
    const run = await runToAbandonedPermission();
    // The teardown itself must already leave the host at rest: settling the
    // abandoned wait is what re-entered tool_running in production, and it
    // happens at the turn boundary, not only at the operator's answer.
    expect(run.states[run.states.length - 1]).toBe("waiting_input");

    run.answer(true);
    await flush();
    await flush();

    expect(run.states[run.states.length - 1]).toBe("waiting_input");
    expect(run.states.lastIndexOf("tool_running")).toBeLessThan(
      run.states.indexOf("waiting_input"),
    );
    expect(run.warnings).toEqual([]);
    await run.finish();
  });

  it("stops advertising the pending dialog once the turn is torn down", async () => {
    const run = await runToAbandonedPermission();

    const last = run.envelopes.at(-1);
    expect(last?.ext?.pending_permission).toBeUndefined();
    expect(run.states).toContain("waiting_permission");

    run.answer(true);
    await run.finish();
  });

  it("withdraws the dialog when the watchdog fail-stops the turn", async () => {
    const envelopes: Envelope[] = [];
    const requested = deferred();
    const streamOpen = deferred();
    let turnToken = "";

    const queryFn = ((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        const input = args.prompt[Symbol.asyncIterator]();
        await input.next();
        yield assistant([toolUse("tu_1")]);
        void args.options.canUseTool!("Bash", { id: "tu_1" }, {
          signal: new AbortController().signal,
        } as never);
        await streamOpen.promise;
      }
      return Object.assign(gen(), {
        interrupt: async () => {},
      }) as unknown as Query;
    }) as unknown as QueryFn;

    let host!: AgentHost;
    host = new AgentHost(config, {
      onState: (envelope) => envelopes.push(envelope),
      onTurnStart: (info) => {
        turnToken = info.turnToken;
      },
      decidePermission: () => {
        host.setPendingPermission({
          request_id: "req_1",
          tool_name: "Bash",
          ts: "T",
        });
        requested.resolve();
        return new Promise(() => {});
      },
      queryFn,
      now: () => "T",
    });
    const running = host.run();
    await host.send("go");
    await requested.promise;
    await flush();

    expect(host.failStopTurnForWatchdog(turnToken)).toBe(true);
    const error = envelopes.at(-1);
    expect(error?.state).toBe("error");
    expect(error?.ext?.pending_permission).toBeUndefined();

    streamOpen.resolve();
    await running;
  });

  it("settles a request the SDK cancels while its turn keeps running", async () => {
    // Measured 2026-09-05 against @anthropic-ai/claude-agent-sdk 0.3.258: the
    // CLI cancels an outstanding can_use_tool and the SDK aborts this signal
    // 2ms after Query.interrupt(). No turn boundary settles this case.
    const envelopes: Envelope[] = [];
    const requested = deferred();
    const controller = new AbortController();
    const decided: Array<{ behavior: string; message?: string }> = [];

    const queryFn = ((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        const input = args.prompt[Symbol.asyncIterator]();
        await input.next();
        yield assistant([toolUse("tu_1")]);
        const pending = args.options.canUseTool!("Bash", { id: "tu_1" }, {
          signal: controller.signal,
        } as never);
        await requested.promise;
        controller.abort();
        decided.push((await pending) as { behavior: string; message?: string });
        yield result("success");
      }
      return Object.assign(gen(), {
        interrupt: async () => {},
      }) as unknown as Query;
    }) as unknown as QueryFn;

    let host!: AgentHost;
    host = new AgentHost(config, {
      onState: (envelope) => envelopes.push(envelope),
      decidePermission: () => {
        host.setPendingPermission({
          request_id: "req_1",
          tool_name: "Bash",
          ts: "T",
        });
        requested.resolve();
        return new Promise(() => {});
      },
      queryFn,
      now: () => "T",
    });
    const running = host.run();
    await host.send("go");
    host.close();
    await running;

    expect(decided[0]).toMatchObject({ behavior: "deny" });
    expect(decided[0]?.message).toContain("cancelled before it was answered");
    const states = envelopes.map((envelope) => envelope.state);
    const resumed = states.lastIndexOf("tool_running");
    expect(resumed).toBeGreaterThan(states.indexOf("waiting_permission"));
    expect(envelopes[resumed]?.ext?.pending_permission).toBeUndefined();
  });

  it("still resumes tool_running for concurrent answers inside a live turn", async () => {
    const envelopes: Envelope[] = [];
    const warnings: string[] = [];
    const behaviors: string[] = [];
    const gate = deferred();

    const queryFn = ((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        const input = args.prompt[Symbol.asyncIterator]();
        await input.next();
        yield assistant([toolUse("tu_1"), toolUse("tu_2")]);
        const both = Promise.all(
          ["tu_1", "tu_2"].map((id) =>
            args.options.canUseTool!("Bash", { id }, {
              signal: new AbortController().signal,
            } as never),
          ),
        );
        gate.resolve();
        for (const decided of await both) behaviors.push(decided?.behavior ?? "null");
        yield result("success");
      }
      return Object.assign(gen(), {
        interrupt: async () => {},
      }) as unknown as Query;
    }) as unknown as QueryFn;

    const host = new AgentHost(config, {
      onState: (envelope) => envelopes.push(envelope),
      warn: (message) => warnings.push(message),
      decidePermission: async () => {
        await gate.promise;
        return { allow: true };
      },
      queryFn,
      now: () => "T",
    });
    const running = host.run();
    await host.send("go");
    host.close();
    await running;

    expect(behaviors).toEqual(["allow", "allow"]);
    const states = envelopes.map((envelope) => envelope.state);
    expect(states.filter((state) => state === "waiting_permission")).toHaveLength(2);
    expect(states.filter((state) => state === "tool_running")).toHaveLength(3);
    expect(states.slice(-2)).toEqual(["done", "waiting_input"]);
    expect(warnings).toEqual([]);
  });
});
