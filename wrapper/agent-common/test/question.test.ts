import "../../../scripts/test/fixtures/test-isolation.mjs";
import { askUserQuestionDescriptor } from "../src/ask_user_question.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionBroker } from "../src/question.js";
import type {
  Envelope,
  PendingQuestionExt,
  Question,
  WrapperConfig,
} from "../src/types.js";

const config: WrapperConfig = {
  agent_id: "test.q",
  persona: { id: "ao", name: "あお", sprite_set: "ao" },
  display_name: "あお",
  server_url: "ws://localhost:4000/wrapper",
};

const questions: Question[] = [
  {
    question: "どの方式を採用しますか?",
    header: "方式",
    multiSelect: false,
    options: [
      { label: "REST", description: "素直だが冗長" },
      { label: "gRPC", description: "高速だが導入コスト" },
    ],
  },
];

function makeBroker(
  overrides: {
    timeoutMs?: number;
    onPendingChange?: (pending: PendingQuestionExt | null) => void;
  } = {},
) {
  const sent: Envelope[] = [];
  let counter = 0;
  const broker = new QuestionBroker({
    config,
    send: (envelope) => sent.push(envelope),
    now: () => "2026-07-03T00:00:00Z",
    newId: () => `q-${++counter}`,
    ...overrides,
  });
  return { broker, sent };
}

describe("QuestionBroker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("decide は question_request エンベロープを送る", () => {
    const { broker, sent } = makeBroker();

    void broker.decide(questions);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "question_request",
      state: "waiting_question",
      agent_id: "test.q",
      payload: { request_id: "q-1", questions },
    });
  });

  it("question_response の relay で answers を返す", async () => {
    const { broker } = makeBroker();

    const pending = broker.decide(questions);
    broker.resolve({
      request_id: "q-1",
      answers: { "どの方式を採用しますか?": "gRPC" },
    });

    await expect(pending).resolves.toStrictEqual({
      cancelled: false,
      answers: { "どの方式を採用しますか?": "gRPC" },
    });
  });

  it("cancelled の response は deny (cancelled) で解決する", async () => {
    const { broker } = makeBroker();

    const pending = broker.decide(questions);
    broker.resolve({ request_id: "q-1", answers: {}, cancelled: true });

    await expect(pending).resolves.toStrictEqual({ cancelled: true });
  });

  it("既定では timeout なし (無制限待機、ADR-0022/0027)", async () => {
    const { broker } = makeBroker();

    const pending = broker.decide(questions);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    const racer = Promise.race([
      pending,
      new Promise((r) => setTimeout(() => r("still-pending"), 0)),
    ]);
    vi.advanceTimersByTime(1);
    await expect(racer).resolves.toBe("still-pending");

    broker.resolve({ request_id: "q-1", answers: { x: "y" } });
    await expect(pending).resolves.toMatchObject({ cancelled: false });
  });

  it("opt-in の有限 timeoutMs では cancelled で fail-closed する", async () => {
    const { broker } = makeBroker({ timeoutMs: 5_000 });

    const pending = broker.decide(questions);
    vi.advanceTimersByTime(5_000);

    await expect(pending).resolves.toStrictEqual({ cancelled: true });
  });

  it("タイムアウト後の遅延 response は無視される", async () => {
    const { broker } = makeBroker({ timeoutMs: 1000 });

    const pending = broker.decide(questions);
    vi.advanceTimersByTime(1000);
    broker.resolve({ request_id: "q-1", answers: { x: "y" } });

    await expect(pending).resolves.toStrictEqual({ cancelled: true });
  });

  it("falls the single slot back to a still-live question (issue #285 M2)", async () => {
    // ADR-0027 gives the wrapper ONE authoritative pending slot. With two
    // questions live, settling the newest must hand the slot back to the
    // older one rather than empty it: the dialog is its only settle path,
    // so an emptied slot hides a question nobody can answer.
    const events: (PendingQuestionExt | null)[] = [];
    const { broker } = makeBroker({ onPendingChange: (p) => events.push(p) });

    const first = broker.decide(questions);
    const second = broker.decide(questions);
    expect(events.map((p) => p?.request_id ?? null)).toEqual(["q-1", "q-2"]);

    broker.resolve({ request_id: "q-2", answers: {}, cancelled: true });
    await second;
    expect(events[events.length - 1]).toMatchObject({ request_id: "q-1" });

    broker.resolve({ request_id: "q-1", answers: {}, cancelled: true });
    await first;
    expect(events[events.length - 1]).toBeNull();
  });

  it("onPendingChange は decide で pending、resolve で null を順に呼ぶ", async () => {
    const events: (PendingQuestionExt | null)[] = [];
    const { broker } = makeBroker({ onPendingChange: (p) => events.push(p) });

    const pending = broker.decide(questions);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      request_id: "q-1",
      questions,
      ts: "2026-07-03T00:00:00Z",
    });

    broker.resolve({ request_id: "q-1", answers: { x: "y" } });
    await pending;
    expect(events).toHaveLength(2);
    expect(events[1]).toBeNull();
  });

  it("未知の request_id は無視される", () => {
    const { broker } = makeBroker();
    expect(() =>
      broker.resolve({ request_id: "q-none", answers: {} }),
    ).not.toThrow();
  });

  it("close は保留中の質問を全て cancelled で解決する", async () => {
    const { broker } = makeBroker();

    const a = broker.decide(questions);
    const b = broker.decide(questions);
    broker.close();

    await expect(a).resolves.toStrictEqual({ cancelled: true });
    await expect(b).resolves.toStrictEqual({ cancelled: true });
  });
});

it.each([0, 1])("aborts only question %i", async (index) => {
  const slots = vi.fn();
  const { broker } = makeBroker({ onPendingChange: slots });
  const tool = askUserQuestionDescriptor(broker.decide.bind(broker));
  const calls = [new AbortController(), new AbortController()];
  const results = calls.map(({ signal }) => tool.handler({ questions }, { signal }));
  calls[index]!.abort();
  expect(slots).toHaveBeenCalledTimes(3);
  const survivor = 1 - index;
  const id = `q-${survivor + 1}`;
  expect(slots.mock.lastCall?.[0]?.request_id).toBe(id);
  expect(JSON.parse((await results[index]!).content[0]!.text))
    .toEqual({ cancelled: true });
  broker.resolve({ request_id: id, answers: { a: "b" } });
  const result = await results[survivor]!;
  expect(JSON.parse(result.content[0]!.text).answers).toEqual({ a: "b" });
  slots.mockClear();
  calls[survivor]!.abort();
  expect(slots).not.toHaveBeenCalled();
});

it("does not publish a question for an aborted request", async () => {
  const { broker, sent } = makeBroker();
  const tool = askUserQuestionDescriptor(broker.decide.bind(broker));
  const result = await tool.handler({ questions }, { signal: AbortSignal.abort() });
  expect(JSON.parse(result.content[0]!.text)).toEqual({ cancelled: true });
  expect(sent).toEqual([]);
});
