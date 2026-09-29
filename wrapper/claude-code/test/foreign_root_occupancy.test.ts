// issue #426 stage 1: a root interval whose opener the host cannot name
// (a hand-back turn) holds the input barrier and grants no send authority.
// Each control below names the guard it pins; the mutation log lists the
// production edit that turns it red.

import { describe, expect, it, vi } from "vitest";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentHost } from "../src/host.js";
import type { AgentHostOptions } from "../src/host.js";
import { INTER_AGENT_TOOL_FQN } from "@kaoiro/agent-common";
import type { WrapperConfig } from "@kaoiro/agent-common";

const config: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const S = "s";
const signal = { signal: new AbortController().signal };
const msg = (shape: unknown): SDKMessage => shape as SDKMessage;

type QueryFn = NonNullable<AgentHostOptions["queryFn"]>;
type QueryArgs = { prompt: AsyncIterable<SDKUserMessage>; options: Options };

interface Rig {
  host: AgentHost;
  starts: Array<{ token: string; kind: string | undefined }>;
  ends: Array<{ token: string | undefined; detail?: string; cancellation?: string }>;
  freezes: Array<string | undefined>;
  states: string[];
  decisions: Array<{ kind: string; reason?: string }>;
  warnings: string[];
  obs: Record<string, unknown>;
}
interface Ctx {
  input: AsyncIterator<SDKUserMessage>;
  options: Options;
  rig: Rig;
}

const NOTE_TEXT = (task = "task", parent = "parent") =>
  `<task-notification><task-id>${task}</task-id><tool-use-id>${parent}</tool-use-id>` +
  `<status>completed</status><output-file>/tmp/${task}</output-file><summary>done</summary></task-notification>`;

const initFrame = (session = S): SDKMessage => msg({ type: "system", subtype: "init", session_id: session });
const taskStarted = (task = "task"): SDKMessage =>
  msg({ type: "system", subtype: "task_started", session_id: S, task_id: task, task_type: "local_bash", is_backgrounded: true });
const taskNotification = (task = "task", parent = "parent"): SDKMessage =>
  msg({ type: "system", subtype: "task_notification", session_id: S, task_id: task, tool_use_id: parent, status: "completed", output_file: `/tmp/${task}`, summary: "done" });
const rootFrame = (session = S): SDKMessage =>
  msg({ type: "assistant", session_id: session, parent_tool_use_id: null, message: { content: [{ type: "text", text: "working" }] } });
const childFrame = (session = S): SDKMessage =>
  msg({ type: "assistant", session_id: session, parent_tool_use_id: "toolu_child", message: { content: [{ type: "text", text: "child" }] } });
const res = (index: number | undefined, extra: Record<string, unknown> = {}): SDKMessage =>
  msg({
    type: "result", subtype: "success", is_error: false, session_id: S, uuid: `u${index}`, result: "ok",
    ...(index === undefined ? {} : { result_index: index }), ...extra,
  });

function fire(c: Ctx, name: "UserPromptSubmit" | "PreToolUse", payload: Record<string, unknown>, toolUseId?: string): Promise<unknown> {
  return c.options.hooks![name]!.at(-1)!.hooks[0]!(
    { hook_event_name: name, session_id: S, ...payload } as never, toolUseId, signal);
}
const prompt = (c: Ctx, id: string, text: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
  fire(c, "UserPromptSubmit", { prompt_id: id, prompt: text, ...extra });
const sendTool = (c: Ctx, promptId: string, toolUseId: string): Promise<unknown> =>
  fire(c, "PreToolUse", { prompt_id: promptId, tool_name: INTER_AGENT_TOOL_FQN, tool_use_id: toolUseId }, toolUseId);

/** Whether the SDK's next input pull produced a turn, ended, or is still held. */
async function pull(next: Promise<IteratorResult<SDKUserMessage>>, ms = 60): Promise<"turn" | "ended" | "held"> {
  let outcome: "turn" | "ended" | "held" = "held";
  void next.then((step) => { outcome = step.done === true ? "ended" : "turn"; });
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
  else await new Promise<void>((resolve) => setTimeout(resolve, ms));
  return outcome;
}

function makeRig(script: (c: Ctx) => AsyncGenerator<SDKMessage, void>): Rig {
  const rig = {
    starts: [], ends: [], freezes: [], states: [], decisions: [], warnings: [], obs: {},
  } as unknown as Rig;
  const queryFn = ((args: QueryArgs) => {
    const c: Ctx = { input: args.prompt[Symbol.asyncIterator](), options: args.options, rig };
    return Object.assign(script(c), { interrupt: async () => {} }) as unknown as Query;
  }) as unknown as QueryFn;
  rig.host = new AgentHost(config, {
    onState: (e) => rig.states.push(e.state),
    warn: (message) => { rig.warnings.push(message); },
    queryFn,
    onTurnStart: ({ turnToken, kind }) => rig.starts.push({ token: turnToken, kind }),
    onTurnEnd: ({ turnToken, error, cancellation }) => rig.ends.push({
      token: turnToken,
      ...(error?.detail === undefined ? {} : { detail: error.detail }),
      ...(cancellation === undefined ? {} : { cancellation: cancellation.kind }),
    }),
    onAdmissionFailStop: ({ turnToken }) => rig.freezes.push(turnToken),
    onPushedInputDecision: ({ kind, reason }) => rig.decisions.push({ kind, ...(reason === undefined ? {} : { reason }) }),
  });
  return rig;
}

async function play(rig: Rig): Promise<void> {
  const running = rig.host.run();
  try {
    await rig.host.send("launch");
    await running;
  } finally {
    rig.host.close();
    await running;
  }
}

/** Wrapper turn "launch" (prompt p1), optionally leaving a background task
 * behind, ended by result index 0. */
async function* firstTurn(c: Ctx, options: { background?: boolean } = {}): AsyncGenerator<SDKMessage, void> {
  await c.input.next();
  await prompt(c, "p1", "launch");
  yield initFrame();
  if (options.background === true) yield taskStarted();
  yield res(0);
}

describe("foreign root occupancy (issue #426 stage 1)", () => {
  it("holds the next input through an unmatched root interval, grants no token, then drains", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      await prompt(c, "F", "hand-back report");
      await sendTool(c, "F", "root-call");
      c.rig.obs.rootBound = (await c.rig.host.toolOrigins.resolve("root-call")) !== undefined;
      await c.rig.host.send("second");
      const next = c.input.next();
      c.rig.obs.blockedBefore = (await pull(next)) === "held";
      yield rootFrame();
      c.rig.obs.blockedMid = (await pull(next)) === "held";
      yield res(1);
      c.rig.obs.releasedAfter = (await pull(next)) === "turn";
      await prompt(c, "p2", "second");
      yield res(2);
    });
    await play(rig);
    expect(rig.obs).toEqual({ rootBound: false, blockedBefore: true, blockedMid: true, releasedAfter: true });
    expect(rig.starts.map(({ kind }) => kind)).toEqual([undefined, undefined]);
    expect(rig.ends).toHaveLength(2);
    expect(rig.freezes).toEqual([]);
    expect(rig.states.filter((state) => state === "error")).toEqual([]);
  });

  it("establishes nothing from child-only activity", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      yield childFrame();
      await c.rig.host.send("second");
      const next = c.input.next();
      c.rig.obs.released = (await pull(next)) === "turn";
      await prompt(c, "p2", "second");
      yield res(1);
    });
    await play(rig);
    expect(rig.obs).toEqual({ released: true });
    expect(rig.freezes).toEqual([]);
  });

  it("holds and drains a frame-only root interval, and a first notification hook grants no token", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c, { background: true });
      yield rootFrame();
      await c.rig.host.send("second");
      const next = c.input.next();
      c.rig.obs.blockedBefore = (await pull(next)) === "held";
      yield taskNotification();
      await prompt(c, "F", NOTE_TEXT());
      c.rig.obs.startsAfterHook = c.rig.starts.length;
      c.rig.obs.blockedAfterHook = (await pull(next)) === "held";
      yield res(1);
      c.rig.obs.released = (await pull(next, 200)) === "turn";
      await prompt(c, "p2", "second");
      yield res(2);
    });
    await play(rig);
    expect(rig.obs).toEqual({ blockedBefore: true, startsAfterHook: 1, blockedAfterHook: true, released: true });
    expect(rig.freezes).toEqual([]);
    expect(rig.warnings.filter((line) => line.includes("invariant"))).toEqual([]);
  });

  it("folds a same-ID notification hook into the foreign interval without a token", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c, { background: true });
      await prompt(c, "F", "hand-back report");
      yield taskNotification();
      await prompt(c, "F", NOTE_TEXT());
      await c.rig.host.send("second");
      const next = c.input.next();
      yield res(1);
      c.rig.obs.releasedWithoutCandidateWait = (await pull(next, 200)) === "turn";
      await prompt(c, "p2", "second");
      yield res(2);
    });
    await play(rig);
    expect(rig.obs).toEqual({ releasedWithoutCandidateWait: true });
    expect(rig.starts).toHaveLength(2);
    expect(rig.freezes).toEqual([]);
  });

  it("keeps the barrier through conversation_reset and an interrupt ACK", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      await prompt(c, "F", "hand-back report");
      await c.rig.host.send("second");
      const next = c.input.next();
      yield msg({ type: "conversation_reset", session_id: S });
      c.rig.obs.afterReset = (await pull(next)) === "held";
      await c.rig.host.interrupt();
      c.rig.obs.afterInterrupt = (await pull(next)) === "held";
      yield res(1);
      c.rig.obs.released = (await pull(next)) === "turn";
      await prompt(c, "p2", "second");
      yield res(2);
    });
    await play(rig);
    expect(rig.obs).toEqual({ afterReset: true, afterInterrupt: true, released: true });
    expect(rig.freezes).toEqual([]);
  });

  it("fails stop at once on a session rebind frame under occupancy, before any result", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      await prompt(c, "F", "hand-back report");
      await c.rig.host.send("second");
      const next = c.input.next();
      yield initFrame("other");
      c.rig.obs.freezesAtRebind = c.rig.freezes.length;
      c.rig.obs.pull = await pull(next);
      yield res(1, { session_id: "other" });
    });
    await play(rig);
    expect(rig.obs).toEqual({ freezesAtRebind: 1, pull: "ended" });
    expect(rig.ends.find(({ detail }) => detail?.includes("SDK stream ended"))).toBeUndefined();
    expect(rig.ends.map(({ cancellation }) => cancellation)).toContain("admission_fail_stop");
  });

  it.each([
    { name: "wrong session", result: res(1, { session_id: "other" }) },
    { name: "missing session_id", result: res(1, { session_id: undefined }) },
    { name: "missing result_index", result: res(undefined) },
    { name: "regressing result_index", result: res(0, { uuid: "different" }) },
  ])("fails stop, ownerless, on a foreign terminal with $name", async ({ result }) => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      await prompt(c, "F", "hand-back report");
      await c.rig.host.send("second");
      const next = c.input.next();
      yield rootFrame();
      yield result;
      c.rig.obs.freezes = c.rig.freezes.length;
      c.rig.obs.pull = await pull(next);
    });
    await play(rig);
    expect(rig.obs).toEqual({ freezes: 1, pull: "ended" });
    expect(rig.freezes).toEqual([undefined]);
    expect(rig.ends.map(({ cancellation }) => cancellation)).toContain("admission_fail_stop");
  });

  it("fails stop, ownerless, when the stream ends under occupancy", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      await prompt(c, "F", "hand-back report");
      await c.rig.host.send("second");
    });
    await play(rig);
    expect(rig.freezes).toEqual([undefined]);
    expect(rig.states).toContain("error");
    expect(rig.ends.map(({ cancellation }) => cancellation)).toContain("admission_fail_stop");
  });

  it("does not drain a fresh-ID overlap that matches a pending notification", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c, { background: true });
      await prompt(c, "F", "hand-back report");
      yield taskNotification();
      await prompt(c, "Q", NOTE_TEXT());
      await c.rig.host.send("second");
      const next = c.input.next();
      yield res(1);
      c.rig.obs.freezes = c.rig.freezes.length;
      c.rig.obs.pull = await pull(next);
    });
    await play(rig);
    expect(rig.obs).toEqual({ freezes: 1, pull: "ended" });
    expect(rig.starts).toHaveLength(1);
  });

  it("does not settle an admitted notification when a fresh-ID interval overlaps it", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c, { background: true });
      yield taskNotification();
      await prompt(c, "N", NOTE_TEXT());
      await prompt(c, "B", "hand-back report");
      await c.rig.host.send("third");
      const next = c.input.next();
      yield res(1, { origin: { kind: "task-notification" } });
      c.rig.obs.freezes = c.rig.freezes.length;
      c.rig.obs.notificationEnds = c.rig.ends.filter(({ token }) => token === c.rig.starts[1]?.token).length;
      c.rig.obs.pull = await pull(next);
    });
    await play(rig);
    expect(rig.starts.map(({ kind }) => kind)).toEqual([undefined, "sdk_notification"]);
    expect(rig.obs).toEqual({ freezes: 1, notificationEnds: 0, pull: "ended" });
  });

  it("ignores an exact retired duplicate and fails stop on a reused index with another identity", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      await prompt(c, "F", "hand-back report");
      yield rootFrame();
      yield res(1);
      await c.rig.host.send("second");
      await c.input.next();
      await prompt(c, "p2", "second");
      yield res(1);
      c.rig.obs.endsAfterDuplicate = c.rig.ends.length;
      c.rig.obs.freezesAfterDuplicate = c.rig.freezes.length;
      yield res(1, { uuid: "other-identity" });
      c.rig.obs.freezesAfterConflict = c.rig.freezes.length;
    });
    await play(rig);
    expect(rig.obs).toEqual({ endsAfterDuplicate: 1, freezesAfterDuplicate: 0, freezesAfterConflict: 1 });
  });

  it("holds an input queued after the pull under occupancy", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      await prompt(c, "F", "hand-back report");
      const next = c.input.next();
      await c.rig.host.send("second");
      c.rig.obs.held = (await pull(next)) === "held";
      yield res(1);
      c.rig.obs.released = (await pull(next)) === "turn";
      await prompt(c, "p2", "second");
      yield res(2);
    });
    await play(rig);
    expect(rig.obs).toEqual({ held: true, released: true });
  });

  it("keeps a pull that is already waiting on a candidate held when occupancy starts and the candidate is folded", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c, { background: true });
      yield taskNotification();
      await c.rig.host.send("second");
      const next = c.input.next();
      c.rig.obs.heldByCandidate = (await pull(next)) === "held";
      await prompt(c, "F", "hand-back report");
      await prompt(c, "F", NOTE_TEXT());
      c.rig.obs.heldByOccupancy = (await pull(next)) === "held";
      yield res(1);
      c.rig.obs.released = (await pull(next)) === "turn";
      await prompt(c, "p2", "second");
      yield res(2);
    });
    await play(rig);
    expect(rig.obs).toEqual({ heldByCandidate: true, heldByOccupancy: true, released: true });
    expect(rig.freezes).toEqual([]);
  });

  it("resolves a pending pushed receipt as foreign_occupancy and never yields it", async () => {
    const rig = makeRig(async function* (c) {
      await c.input.next();
      await prompt(c, "p1", "launch");
      yield initFrame();
      c.rig.obs.pushed = c.rig.host.pushLiveInput({
        kind: "fold", text: (foldId) => `fold ${foldId}`, envelopes: [], conversationIds: [],
      });
      yield res(0);
      await prompt(c, "F", "hand-back report");
      const next = c.input.next();
      c.rig.obs.pull = await pull(next);
    });
    await play(rig);
    expect(rig.obs).toEqual({ pushed: true, pull: "held" });
    expect(rig.decisions).toEqual([{ kind: "unknown", reason: "foreign_occupancy" }]);
  });

  describe("notification candidate clocks", () => {
    it("does not arm a candidate that appears during occupancy", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const rig = makeRig(async function* (c) {
          yield* firstTurn(c, { background: true });
          await prompt(c, "F", "hand-back report");
          yield taskNotification();
          await c.rig.host.send("second");
          const next = c.input.next();
          await vi.advanceTimersByTimeAsync(11_000);
          yield res(1);
          c.rig.obs.heldByRearmedCandidate = (await pull(next)) === "held";
          await vi.advanceTimersByTimeAsync(11_000);
          c.rig.obs.releasedAfterRearm = (await pull(next)) === "turn";
          await prompt(c, "p2", "second");
          yield res(2);
        });
        await play(rig);
        expect(rig.obs).toEqual({ heldByRearmedCandidate: true, releasedAfterRearm: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it("pauses a candidate armed before occupancy and rearms it in full at the drain", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const rig = makeRig(async function* (c) {
          yield* firstTurn(c, { background: true });
          yield taskNotification();
          await prompt(c, "F", "hand-back report");
          await c.rig.host.send("second");
          const next = c.input.next();
          await vi.advanceTimersByTimeAsync(11_000);
          yield res(1);
          c.rig.obs.heldByRearmedCandidate = (await pull(next)) === "held";
          await vi.advanceTimersByTimeAsync(11_000);
          c.rig.obs.releasedAfterRearm = (await pull(next)) === "turn";
          await prompt(c, "p2", "second");
          yield res(2);
        });
        await play(rig);
        expect(rig.obs).toEqual({ heldByRearmedCandidate: true, releasedAfterRearm: true });
        expect(rig.freezes).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("unique wrapper recognition (issue #426 stage 1)", () => {
  const TAG_PROSE = "explain what a <task-notification> tag is";

  /** One wrapper turn: `body` fires its hooks and tool call and ends with an
   * originless result; the counts after that result are recorded. */
  function wrapperRig(body: (c: Ctx) => AsyncGenerator<SDKMessage, void>): Rig {
    return makeRig(async function* (c) {
      await c.input.next();
      yield initFrame();
      yield* body(c);
      c.rig.obs.endsAfterResult = c.rig.ends.length;
      c.rig.obs.freezes = c.rig.freezes.length;
    });
  }
  async function playWith(rig: Rig, text: string): Promise<void> {
    const running = rig.host.run();
    try {
      await rig.host.send(text);
      await running;
    } finally {
      rig.host.close();
      await running;
    }
  }
  const bound = async (c: Ctx, promptId: string): Promise<boolean> => {
    await sendTool(c, promptId, `call-${promptId}`);
    const origin = c.rig.host.toolOrigins.resolve(`call-${promptId}`);
    let found = false;
    // resolve() stays pending while the live turn never bound the call.
    void origin.then((value) => { found = value !== undefined; });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    return found;
  };
  const SETTLED = { bound: true, endsAfterResult: 1, freezes: 0 };
  const FAIL_STOPPED = { bound: false, endsAfterResult: 0, freezes: 1 };

  it("c1: prose containing the literal tag registers, settles and does not fail stop", async () => {
    const rig = wrapperRig(async function* (c) {
      await prompt(c, "p1", TAG_PROSE);
      c.rig.obs.bound = await bound(c, "p1");
      yield res(0);
    });
    await playWith(rig, TAG_PROSE);
    expect(rig.obs).toEqual(SETTLED);
  });

  it("c2: a duplicate same-ID hook with the identical text does not taint the owner", async () => {
    const rig = wrapperRig(async function* (c) {
      await prompt(c, "p1", TAG_PROSE);
      await prompt(c, "p1", TAG_PROSE);
      c.rig.obs.bound = await bound(c, "p1");
      yield res(0);
    });
    await playWith(rig, TAG_PROSE);
    expect(rig.obs).toEqual(SETTLED);
  });

  it.each([
    { name: "system source", extra: { source: "system" } },
    { name: "another session", extra: { session_id: "other" } },
  ])("c2 negative: a same-ID duplicate with $name still taints the owner", async ({ extra }) => {
    const rig = wrapperRig(async function* (c) {
      await prompt(c, "p1", TAG_PROSE);
      await prompt(c, "p1", TAG_PROSE, extra);
      c.rig.obs.bound = await bound(c, "p1");
      yield res(0);
    });
    await playWith(rig, TAG_PROSE);
    expect(rig.obs.bound).toBe(false);
  });

  it("c3: a fresh-ID notification-only hook during a wrapper turn makes its originless result fail stop", async () => {
    const rig = wrapperRig(async function* (c) {
      yield taskStarted();
      await prompt(c, "p1", "launch");
      yield taskNotification();
      await prompt(c, "n1", NOTE_TEXT());
      c.rig.obs.bound = await bound(c, "p1");
      yield res(0);
    });
    await playWith(rig, "launch");
    expect(rig.obs).toMatchObject({ endsAfterResult: 0, freezes: 1 });
  });

  it("c4: wrapper text equal to a pending notification's rendering is not registered and fails stop", async () => {
    const rig = wrapperRig(async function* (c) {
      yield taskStarted();
      yield taskNotification();
      await prompt(c, "w1", NOTE_TEXT());
      c.rig.obs.bound = await bound(c, "w1");
      yield res(0);
    });
    await playWith(rig, NOTE_TEXT());
    expect(rig.obs).toEqual(FAIL_STOPPED);
  });

  it.each([
    { name: "a system-source hook", extra: { source: "system" } },
    { name: "a hook of another session", extra: { session_id: "other" } },
  ])("$name with the wrapper's exact text is not uniquely recognized", async ({ extra }) => {
    const rig = wrapperRig(async function* (c) {
      await prompt(c, "w1", "launch", extra);
      c.rig.obs.bound = await bound(c, "w1");
      yield res(0);
    });
    await playWith(rig, "launch");
    expect(rig.obs).toEqual(FAIL_STOPPED);
  });

  it("a text match does not repair an interval that is already ambiguous", async () => {
    const rig = wrapperRig(async function* (c) {
      await prompt(c, "p1", "launch");
      await prompt(c, "other", "unrelated root prompt");
      await prompt(c, "p1", "launch");
      c.rig.obs.bound = await bound(c, "p1");
      yield res(0);
    });
    await playWith(rig, "launch");
    expect(rig.obs).toMatchObject({ endsAfterResult: 0, freezes: 1 });
  });
});

describe("terminal validation under a live owner (issue #426 stage 1)", () => {
  const PEER_A = { kind: "peer", senderTaskId: "child-a", handback: true };

  async function playFirst(rig: Rig): Promise<void> {
    await play(rig);
  }

  it.each([
    { name: "another session, after interval ambiguity is already established", frame: res(0, { session_id: "other-session" }), ambiguous: true },
    { name: "another session", frame: res(0, { session_id: "other-session" }), ambiguous: false },
    { name: "no result_index", frame: res(undefined), ambiguous: false },
  ])("fails stop on a wrapper-owned terminal with $name", async ({ frame, ambiguous }) => {
    const rig = makeRig(async function* (c) {
      await c.input.next();
      await prompt(c, "p1", "launch");
      yield initFrame();
      if (ambiguous) await prompt(c, "F", "foreign overlap");
      yield frame;
      c.rig.obs.endsAtResult = c.rig.ends.length;
      c.rig.obs.freezesAtResult = c.rig.freezes.length;
      c.rig.obs.bound = false;
    });
    await playFirst(rig);
    expect(rig.obs).toMatchObject({ endsAtResult: 0, freezesAtResult: 1 });
    expect(rig.freezes).toEqual([rig.starts[0]!.token]);
  });

  it.each([
    { name: "a missing session_id", session: undefined },
    { name: "an empty session_id", session: "" },
  ])("fails stop on a wrapper-owned terminal with $name", async ({ session }) => {
    const rig = makeRig(async function* (c) {
      await c.input.next();
      await prompt(c, "p1", "launch");
      yield initFrame();
      yield res(0, { session_id: session });
      c.rig.obs.endsAtResult = c.rig.ends.length;
      c.rig.obs.freezesAtResult = c.rig.freezes.length;
    });
    await playFirst(rig);
    expect(rig.obs).toEqual({ endsAtResult: 0, freezesAtResult: 1 });
  });

  it.each([
    { name: "a missing session_id", session: undefined },
    { name: "an empty session_id", session: "" },
  ])("fails stop on a notification-owned terminal with $name", async ({ session }) => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c, { background: true });
      yield taskNotification();
      await prompt(c, "N", NOTE_TEXT());
      yield res(1, { session_id: session, origin: { kind: "task-notification" } });
      c.rig.obs.notificationEnds = c.rig.ends.filter(({ token }) => token === c.rig.starts[1]?.token).length;
      c.rig.obs.freezes = c.rig.freezes.length;
    });
    await playFirst(rig);
    expect(rig.obs).toEqual({ notificationEnds: 0, freezes: 1 });
  });

  it("accepts the first result's own session for a startup error that no hook or frame preceded", async () => {
    const rig = makeRig(async function* (c) {
      await c.input.next();
      yield res(0, { session_id: "first-seen", subtype: "error_during_execution", is_error: true });
      c.rig.obs.endsAtResult = c.rig.ends.length;
      c.rig.obs.freezesAtResult = c.rig.freezes.length;
    });
    await playFirst(rig);
    expect(rig.obs).toEqual({ endsAtResult: 1, freezesAtResult: 0 });
  });

  it("holds a result before the first init to the session its root hook was matched in", async () => {
    const rig = makeRig(async function* (c) {
      await c.input.next();
      await prompt(c, "p1", "launch");
      yield res(0, { session_id: "another-session" });
      c.rig.obs.endsAtResult = c.rig.ends.length;
      c.rig.obs.freezesAtResult = c.rig.freezes.length;
    });
    await playFirst(rig);
    expect(rig.obs).toEqual({ endsAtResult: 0, freezesAtResult: 1 });
  });

  it.each([
    { name: "regressing", index: 0, ends: 1, freezes: 1 },
    { name: "advancing", index: 1, ends: 2, freezes: 0 },
  ])("keeps the run's index boundary across an idle session rebind ($name index)", async ({ index, ends, freezes }) => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      yield initFrame("s2");
      await c.rig.host.send("second");
      await c.input.next();
      await prompt(c, "p2", "second", { session_id: "s2" });
      yield res(index, { session_id: "s2", uuid: "u-s2" });
      c.rig.obs.endsAtResult = c.rig.ends.length;
      c.rig.obs.freezesAtResult = c.rig.freezes.length;
    });
    await play(rig);
    expect(rig.obs).toEqual({ endsAtResult: ends, freezesAtResult: freezes });
  });

  it("fails stop on a wrapper-owned terminal whose index regresses", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      await c.rig.host.send("second");
      await c.input.next();
      await prompt(c, "p2", "second");
      yield res(0, { uuid: "u-again" });
      c.rig.obs.endsAtResult = c.rig.ends.length;
      c.rig.obs.freezesAtResult = c.rig.freezes.length;
    });
    await play(rig);
    expect(rig.obs).toEqual({ endsAtResult: 1, freezesAtResult: 1 });
  });

  it.each([
    { name: "another session", frame: res(1, { session_id: "other-session", origin: { kind: "task-notification" } }) },
    { name: "no result_index", frame: res(undefined, { origin: { kind: "task-notification" } }) },
    { name: "a regressing result_index", frame: res(0, { uuid: "u-again", origin: { kind: "task-notification" } }) },
  ])("fails stop on a notification-owned terminal with $name", async ({ frame }) => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c, { background: true });
      yield taskNotification();
      await prompt(c, "N", NOTE_TEXT());
      yield frame;
      c.rig.obs.notificationEnds = c.rig.ends.filter(({ token }) => token === c.rig.starts[1]?.token).length;
      c.rig.obs.freezes = c.rig.freezes.length;
    });
    await play(rig);
    expect(rig.starts.map(({ kind }) => kind)).toEqual([undefined, "sdk_notification"]);
    expect(rig.obs).toEqual({ notificationEnds: 0, freezes: 1 });
  });

  it("an ambiguous wrapper interval that receives a notification-origin terminal stops admission and loses its send binding", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      yield taskStarted();
      await c.rig.host.send("second");
      await c.input.next();
      await prompt(c, "p2", "second");
      await prompt(c, "F", "foreign overlap");
      yield res(1, { origin: { kind: "task-notification" } });
      c.rig.obs.endsAtResult = c.rig.ends.length;
      c.rig.obs.freezes = c.rig.freezes.length;
      c.rig.obs.bound = await (async () => {
        await sendTool(c, "p2", "call-after");
        const origin = c.rig.host.toolOrigins.resolve("call-after");
        let found = false;
        void origin.then((value) => { found = value !== undefined; });
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        return found;
      })();
    });
    await play(rig);
    expect(rig.obs).toEqual({ endsAtResult: 1, freezes: 1, bound: false });
  });

  it("does not let a stale ownerless result lower the run's index boundary", async () => {
    const rig = makeRig(async function* (c) {
      await c.input.next();
      await prompt(c, "p1", "launch");
      yield initFrame();
      yield res(5);
      yield res(1, { uuid: "stale", origin: { kind: "task-notification" } });
      await prompt(c, "F", "hand-back report");
      yield rootFrame();
      yield res(3, { uuid: "regressing" });
      c.rig.obs.freezes = c.rig.freezes.length;
    });
    await play(rig);
    expect(rig.obs).toEqual({ freezes: 1 });
  });

  it("treats an exact retired repeat as a duplicate", async () => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      await prompt(c, "F", "hand-back report");
      yield res(1, { uuid: "u-peer", origin: PEER_A });
      yield res(1, { uuid: "u-peer", origin: PEER_A });
      c.rig.obs.freezes = c.rig.freezes.length;
    });
    await play(rig);
    expect(rig.obs).toEqual({ freezes: 0 });
  });

  it.each([
    { name: "another peer sender", frame: res(1, { uuid: "u-peer", origin: { ...PEER_A, senderTaskId: "child-b" } }) },
    { name: "a dropped hand-back flag", frame: res(1, { uuid: "u-peer", origin: { kind: "peer", senderTaskId: "child-a" } }) },
    { name: "another terminal outcome", frame: res(1, { uuid: "u-peer", origin: PEER_A, subtype: "error_during_execution", is_error: true }) },
    { name: "another terminal reason", frame: res(1, { uuid: "u-peer", origin: PEER_A, terminal_reason: "aborted_streaming" }) },
  ])("fails stop when a retired index is reused with $name", async ({ frame }) => {
    const rig = makeRig(async function* (c) {
      yield* firstTurn(c);
      await prompt(c, "F", "hand-back report");
      yield res(1, { uuid: "u-peer", origin: PEER_A });
      yield frame;
      c.rig.obs.freezes = c.rig.freezes.length;
    });
    await play(rig);
    expect(rig.obs).toEqual({ freezes: 1 });
  });
});
