// issue #285 review round 1 (ふじ2 M1 / M2 / M3). Everything here drives a
// REAL PermissionBroker or QuestionBroker: the hazards live in the broker's
// registry and in the single authoritative pending slot, neither of which a
// decider stub has, so a stub cannot measure them.

import { describe, expect, it, vi } from "vitest";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { PermissionBroker, QuestionBroker } from "@kaoiro/agent-common";
import { AgentHost } from "../src/host.js";
import type { AgentHostOptions } from "../src/host.js";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";

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
  input: { command: "true" },
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

function requestIdsFrom(envelopes: Envelope[]): string[] {
  return envelopes
    .map((envelope) => envelope.payload?.request_id)
    .filter((id): id is string => typeof id === "string");
}

/** Wires a host to real brokers exactly as cli.ts does, so a test measures
 *  the composed behaviour rather than a hand-written stand-in. */
function withRealBrokers(options: {
  queryFn: QueryFn;
  onState?: (envelope: Envelope) => void;
  warn?: (message: string) => void;
}): {
  host: AgentHost;
  broker: PermissionBroker;
  questionBroker: QuestionBroker;
  requests: Envelope[];
} {
  const requests: Envelope[] = [];
  let host!: AgentHost;

  const broker = new PermissionBroker({
    config,
    send: (envelope) => requests.push(envelope),
    onPendingChange: (pending) => host.setPendingPermission(pending),
    now: () => "T",
  });
  const questionBroker = new QuestionBroker({
    config,
    send: (envelope) => requests.push(envelope),
    onPendingChange: (pending) => host.setPendingQuestion(pending),
    now: () => "T",
  });

  host = new AgentHost(config, {
    onState: options.onState ?? (() => {}),
    ...(options.warn === undefined ? {} : { warn: options.warn }),
    decidePermission: (toolName, input) => broker.decide(toolName, input),
    decideQuestion: (questions) => questionBroker.decide(questions),
    cancelDecision: (kind, requestId) => {
      if (kind === "permission") {
        broker.resolve({ request_id: requestId, allow: false });
      } else {
        questionBroker.resolve({
          request_id: requestId,
          answers: {},
          cancelled: true,
        });
      }
    },
    queryFn: options.queryFn,
    now: () => "T",
  });

  return { host, broker, questionBroker, requests };
}

describe("issue #285 M1 — a request the SDK cancels is invalidated broker-side", () => {
  it("does not let its late answer clear a newer request's slot", async () => {
    const controller = new AbortController();
    const firstOpened = deferred();
    const secondOpened = deferred();
    const streamOpen = deferred();

    const queryFn = ((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        const input = args.prompt[Symbol.asyncIterator]();
        await input.next();
        yield assistant([toolUse("tu_1")]);
        void args.options.canUseTool!("Bash", { id: "tu_1" }, {
          signal: controller.signal,
        } as never);
        await firstOpened.promise;
        // The SDK cancels this one while the turn keeps running — no turn
        // boundary will ever settle it.
        controller.abort();
        await flush();
        void args.options.canUseTool!("Bash", { id: "tu_2" }, {
          signal: new AbortController().signal,
        } as never);
        await secondOpened.promise;
        await streamOpen.promise;
      }
      return Object.assign(gen(), {
        interrupt: async () => {},
      }) as unknown as Query;
    }) as unknown as QueryFn;

    const { host, broker, requests } = withRealBrokers({ queryFn });
    const running = host.run();
    await host.send("go");

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    firstOpened.resolve();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    secondOpened.resolve();
    await flush();

    const [first, second] = requestIdsFrom(requests);
    expect(host.statusExtSnapshot().pending_permission).toMatchObject({
      request_id: second,
    });

    // The decisive assertion: the cancelled request must be GONE from the
    // broker, not merely displaced off the slot. Left registered, it becomes
    // the slot's fallback the moment the live request settles — an operator
    // dialog for a tool the SDK already dropped, which is the issue #285
    // class over again. So answer ONLY the live one and require the slot to
    // empty rather than fall back.
    broker.resolve({ request_id: second!, allow: true });
    await flush();
    expect(host.statusExtSnapshot().pending_permission).toBeUndefined();

    // And a late answer to the cancelled id changes nothing.
    broker.resolve({ request_id: first!, allow: true });
    await flush();
    expect(host.statusExtSnapshot().pending_permission).toBeUndefined();

    streamOpen.resolve();
    host.close();
    await running;
  });
});

describe("issue #285 M2 — concurrent tool calls share one authoritative slot", () => {
  for (const order of ["second-first", "first-first"] as const) {
    it(`keeps the unanswered request visible when answered ${order}`, async () => {
      const bothOpened = deferred();
      const decided: string[] = [];

      const queryFn = ((args: QueryArgs) => {
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          const input = args.prompt[Symbol.asyncIterator]();
          await input.next();
          yield assistant([toolUse("tu_1"), toolUse("tu_2")]);
          const calls = ["tu_1", "tu_2"].map((id) =>
            args.options
              .canUseTool!("Bash", { id }, {
                signal: new AbortController().signal,
              } as never)
              .then((decision) => decided.push(`${id}:${decision?.behavior}`)),
          );
          await bothOpened.promise;
          await Promise.all(calls);
          yield result("success");
        }
        return Object.assign(gen(), {
          interrupt: async () => {},
        }) as unknown as Query;
      }) as unknown as QueryFn;

      const { host, broker, requests } = withRealBrokers({ queryFn });
      const running = host.run();
      await host.send("go");

      await vi.waitFor(() => expect(requests).toHaveLength(2));
      const [first, second] = requestIdsFrom(requests);
      bothOpened.resolve();

      // The newest request holds the single slot while both are live.
      expect(host.statusExtSnapshot().pending_permission).toMatchObject({
        request_id: second,
      });

      const [answerFirst, answerSecond] =
        order === "second-first" ? [second!, first!] : [first!, second!];

      broker.resolve({ request_id: answerFirst, allow: true });
      await flush();

      // Answering one must not blank the slot: the other is still live, and
      // the dialog is its only settle path.
      expect(host.statusExtSnapshot().pending_permission).toMatchObject({
        request_id: answerSecond,
      });

      broker.resolve({ request_id: answerSecond, allow: true });
      await flush();

      expect(host.statusExtSnapshot().pending_permission).toBeUndefined();
      expect(decided.sort()).toEqual(["tu_1:allow", "tu_2:allow"]);

      host.close();
      await running;
    });
  }
});

describe("issue #285 M2 — the question arm of the same slot rule", () => {
  it("hands the slot back to the still-live question through the real host", async () => {
    // The permission case above cannot cover this: #clearPendingFor branches
    // on kind, and the question arm is its own comparison. Two AskUserQuestion
    // calls in one turn, opened through the real host and a real
    // QuestionBroker, are what make that branch run.
    const bothOpened = deferred();
    const decided: string[] = [];
    const envelopes: Envelope[] = [];

    const queryFn = ((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        const input = args.prompt[Symbol.asyncIterator]();
        await input.next();
        yield assistant([
          { type: "tool_use", id: "q_1", name: "AskUserQuestion", input: {} },
          { type: "tool_use", id: "q_2", name: "AskUserQuestion", input: {} },
        ]);
        const calls = ["q_1", "q_2"].map((id) =>
          args.options
            .canUseTool!(
              "AskUserQuestion",
              {
                questions: [
                  { question: `${id}?`, header: "h", multiSelect: false, options: [] },
                ],
              },
              { signal: new AbortController().signal } as never,
            )
            .then((decision) => decided.push(`${id}:${decision?.behavior}`)),
        );
        await bothOpened.promise;
        await Promise.all(calls);
        yield result("success");
      }
      return Object.assign(gen(), {
        interrupt: async () => {},
      }) as unknown as Query;
    }) as unknown as QueryFn;

    const { host, questionBroker, requests } = withRealBrokers({
      queryFn,
      onState: (envelope) => envelopes.push(envelope),
    });
    const running = host.run();
    await host.send("go");

    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const [first, second] = requestIdsFrom(requests);
    bothOpened.resolve();

    expect(host.statusExtSnapshot().pending_question).toMatchObject({
      request_id: second,
    });

    questionBroker.resolve({
      request_id: second!,
      answers: { "q_2?": "a" },
      cancelled: false,
    });
    await flush();

    // Settling one must not blank the slot: the other question is still live
    // and its dialog is the only way to answer it.
    expect(host.statusExtSnapshot().pending_question).toMatchObject({
      request_id: first,
    });
    // The operator sees it on the wire too, not merely in the snapshot.
    expect(envelopes[envelopes.length - 1]?.ext?.pending_question).toMatchObject(
      { request_id: first },
    );

    questionBroker.resolve({
      request_id: first!,
      answers: { "q_1?": "a" },
      cancelled: false,
    });
    await flush();

    expect(host.statusExtSnapshot().pending_question).toBeUndefined();
    expect(decided.sort()).toEqual(["q_1:allow", "q_2:allow"]);

    host.close();
    await running;
  });
});

describe("issue #285 M3 — question twin and stream EOF", () => {
  it("invalidates an abandoned QuestionBroker request the same way", async () => {
    const opened = deferred();
    const streamOpen = deferred();
    const controller = new AbortController();

    const queryFn = ((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        const input = args.prompt[Symbol.asyncIterator]();
        await input.next();
        yield assistant([
          { type: "tool_use", id: "tu_q", name: "AskUserQuestion", input: {} },
        ]);
        void args.options.canUseTool!(
          "AskUserQuestion",
          { questions: [{ question: "q?", header: "h", options: [] }] },
          { signal: controller.signal } as never,
        );
        await opened.promise;
        controller.abort();
        await streamOpen.promise;
      }
      return Object.assign(gen(), {
        interrupt: async () => {},
      }) as unknown as Query;
    }) as unknown as QueryFn;

    const changes: Array<string | null> = [];
    const { host, questionBroker, requests } = withRealBrokers({ queryFn });
    const originalSet = host.setPendingQuestion.bind(host);
    host.setPendingQuestion = (pending) => {
      changes.push(pending?.request_id ?? null);
      originalSet(pending);
    };

    const running = host.run();
    await host.send("go");

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    opened.resolve();
    await flush();
    await flush();

    const [requestId] = requestIdsFrom(requests);
    expect(changes).toEqual([requestId, null]);
    expect(host.statusExtSnapshot().pending_question).toBeUndefined();

    // The registry entry is gone, so a late answer changes nothing.
    questionBroker.resolve({
      request_id: requestId!,
      answers: { "q?": "a" },
      cancelled: false,
    });
    await flush();
    expect(changes).toEqual([requestId, null]);

    streamOpen.resolve();
    host.close();
    await running;
  });

  it("settles an outstanding wait at stream EOF without a spurious invariant warning", async () => {
    const opened = deferred();
    const warnings: string[] = [];
    const states: string[] = [];
    const behaviors: string[] = [];

    const queryFn = ((args: QueryArgs) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        const input = args.prompt[Symbol.asyncIterator]();
        await input.next();
        yield assistant([toolUse("tu_1")]);
        void args.options
          .canUseTool!("Bash", { id: "tu_1" }, {
            signal: new AbortController().signal,
          } as never)
          .then((decision) => behaviors.push(decision?.behavior ?? "null"));
        await opened.promise;
        // The stream ends with the permission still outstanding.
      }
      return Object.assign(gen(), {
        interrupt: async () => {},
      }) as unknown as Query;
    }) as unknown as QueryFn;

    const { host, broker, requests } = withRealBrokers({
      queryFn,
      onState: (envelope) => states.push(envelope.state),
      warn: (message) => warnings.push(message),
    });

    const running = host.run();
    await host.send("go");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    opened.resolve();
    await running;
    await flush();

    // The SDK gets a real answer rather than a promise nobody settles.
    expect(behaviors).toEqual(["deny"]);
    expect(host.statusExtSnapshot().pending_permission).toBeUndefined();
    // S1: a teardown re-emit is not a busy state with no turn behind it.
    expect(warnings).toEqual([]);
    expect(states).toContain("waiting_permission");

    // The registry entry went with it: a late answer is unknown.
    const [requestId] = requestIdsFrom(requests);
    broker.resolve({ request_id: requestId!, allow: true });
    await flush();
    expect(host.statusExtSnapshot().pending_permission).toBeUndefined();
  });

  it("routes cancellation through the CLI's own production wiring", async () => {
    // M3: the real-broker tests above hand-inject the same cancelDecision
    // cli.ts writes. This one takes it from the entrypoint instead, so the
    // production option cannot silently go missing.
    const sent: Envelope[] = [];
    const pendingChanges: Array<string | null> = [];
    const questionChanges: Array<string | null> = [];
    let hostOptions!: Record<string, any>;

    const link = {
      close: () => {},
      currentSessionId: () => null,
      send: (envelope: Envelope) => sent.push(envelope),
    };
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      run: async () => {},
      setPendingPermission: (pending: { request_id?: string } | null) =>
        pendingChanges.push(pending?.request_id ?? null),
      setPendingQuestion: (pending: { request_id?: string } | null) =>
        questionChanges.push(pending?.request_id ?? null),
    };

    await runClaudeCli({
      parseCliArgs: () => ({
        configPath: "test",
        prompt: undefined,
        resume: undefined,
      }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        queueMicrotask(() => {
          (options as unknown as Record<string, any>).onPersonaPrompt("p");
        });
        return link as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return host as never;
      },
    });

    expect(hostOptions.cancelDecision).toBeTypeOf("function");

    const decision = hostOptions.decidePermission("Bash", { command: "true" });
    const requestId = requestIdsFrom(sent)[0];
    expect(requestId).toBeTypeOf("string");
    expect(pendingChanges).toEqual([requestId]);

    hostOptions.cancelDecision("permission", requestId!);

    expect(await decision).toMatchObject({ allow: false });
    expect(pendingChanges).toEqual([requestId, null]);

    // The question branch of the SAME production option — a wiring that
    // routes only permissions would leave every abandoned question
    // answerable, which is the M1 hazard on the other broker.
    const answer = hostOptions.decideQuestion([
      { question: "q?", header: "h", multiSelect: false, options: [] },
    ]);
    const questionId = sent
      .filter((envelope) => envelope.type === "question_request")
      .map((envelope) => envelope.payload?.request_id)
      .find((id): id is string => typeof id === "string");
    expect(questionId).toBeTypeOf("string");
    expect(questionChanges).toEqual([questionId]);

    hostOptions.cancelDecision("question", questionId!);

    expect(await answer).toMatchObject({ cancelled: true });
    expect(questionChanges).toEqual([questionId, null]);

    hostOptions.onHostEnd?.({ error: {} });
  });
});
