// @vitest-environment jsdom
// issue #304 (candidate A): differential test for the incremental error
// index (noteIfNewestError / recomputeLatestError / dropLatestError,
// protocol.ts) that replaced App.svelte's former $derived.by full-rescan of
// `latestErrorKeyByAgent`. `referenceLatestErrorKeyByAgent` (protocol.ts) is
// that original full-rescan algorithm, kept ONLY for this comparison (it
// shares `findLatestErrorEnvelope` with `recomputeLatestError` -- both call
// the same unexported helper in protocol.ts, so this is not two
// independent implementations happening to agree).
//
// This mounts the REAL App.svelte (same captured-handlers mock as
// appUnackedErrorAck.integration.test.ts) and drives its actual production
// wiring through a randomized operation sequence mixing all 8
// logs-mutating paths (live append / history join / resume replay / reset
// / clear x2 / agent delete / logout), so a wiring omission at any ONE
// site -- not just a logic bug inside the pure functions themselves -- is
// what a red run here is pinning against. The sequence is seeded
// (mulberry32) and the seed/step/op are embedded in the assertion message,
// so a failure is reproducible without rerunning with instrumentation.
//
// `randomEnvelope` deliberately reuses the previous (ts, seq) pair for a
// given agent some of the time, so the sequence exercises BOTH cases
// noteIfNewestError's CONTRACT depends on: two entries that tie on (ts,
// seq) while differing elsewhere (mergeTranscriptEntries keeps both,
// stable-sorted), and two entries with the FULL identity match
// (mergeTranscriptEntries dedupes, keeping only the first). Without this,
// every candidate has a unique (ts, seq) and neither case is ever
// reached.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Envelope,
  ErrorIndexState,
  KaoiroHandlers,
  SessionResetCompletedPayload,
} from "../src/lib/protocol";

const captured = vi.hoisted(() => ({
  handlers: null as KaoiroHandlers | null,
  latestIndex: null as ErrorIndexState | null,
}));

vi.mock("../src/lib/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/protocol")>();
  // Wrapping (not replacing) the 3 index-update functions: App.svelte's own
  // calls still compute the REAL result via `actual`, but every call is
  // also recorded into `captured.latestIndex` so the test can read the
  // component's private $state without exposing a test-only prop/global.
  const track = (state: ErrorIndexState): ErrorIndexState => {
    captured.latestIndex = state;
    return state;
  };
  return {
    ...actual,
    connectKaoiro: (_url: string, handlers: KaoiroHandlers) => {
      captured.handlers = handlers;
      return {
        disconnect: () => {},
        reconnect: () => {},
        notifyOnline: () => {},
        sendInstruction: () => {},
        sendInterrupt: () => {},
        stop: async () => {},
        restore: async () => {},
        deleteAgent: async () => {},
        renameAgent: async () => {},
      };
    },
    fetchPersonaManifest: async () => null,
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
    noteIfNewestError: (
      ...args: Parameters<typeof actual.noteIfNewestError>
    ) => track(actual.noteIfNewestError(...args)),
    recomputeLatestError: (
      ...args: Parameters<typeof actual.recomputeLatestError>
    ) => track(actual.recomputeLatestError(...args)),
    dropLatestError: (...args: Parameters<typeof actual.dropLatestError>) =>
      track(actual.dropLatestError(...args)),
  };
});

const { default: App } = await import("../src/App.svelte");
const {
  mergeTranscriptEntries,
  mergeHistories,
  resetTranscriptHistory,
  filterAfterHistoryCleared,
  referenceLatestErrorKeyByAgent,
} = await import("../src/lib/protocol");

let component: object | null = null;

/** Deterministic seedable PRNG (mulberry32) -- a random operation sequence
 *  must be reproducible on failure; the seed is embedded in every
 *  assertion message below. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function onlineEnvelope(agentId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name: agentId, sprite_set: agentId },
    ts: "2026-09-01T00:00:00Z",
    type: "state_change",
    state: "waiting_input",
    payload: {},
  } as unknown as Envelope;
}

let seqCounter = 0;
// Last (ts, seq) issued per agent -- randomEnvelope reuses it some of the
// time to manufacture ties/duplicate-identity pairs. Reset in beforeEach.
let lastTsSeqByAgent = new Map<string, { ts: string; seq: number }>();

/** Builds a `result`/is_error-or-not envelope. Reuses the agent's last
 *  (ts, seq) ~35% of the time instead of minting a fresh one -- combined
 *  with the caller picking `sessionId` independently each time, this
 *  naturally produces both of noteIfNewestError's contract cases: same
 *  (ts, seq) + different session_id (tie, both entries survive merge) and
 *  same (ts, seq) + same session_id (full identity match, merge dedupes
 *  to the first). `ts` is otherwise randomized within a wide window (not
 *  monotonic with `seq`) so plain out-of-order arrival is exercised too. */
function randomEnvelope(
  rand: () => number,
  agentId: string,
  sessionId: string,
  isError: boolean,
): Envelope {
  const last = lastTsSeqByAgent.get(agentId);
  let ts: string;
  let seq: number;
  if (last && rand() < 0.35) {
    ({ ts, seq } = last);
  } else {
    ts = new Date(
      Date.parse("2026-09-01T00:00:00Z") + Math.floor(rand() * 1_000_000),
    ).toISOString();
    seq = seqCounter++;
    lastTsSeqByAgent.set(agentId, { ts, seq });
  }
  return isError
    ? ({
        version: "0",
        agent_id: agentId,
        session_id: sessionId,
        ts,
        seq,
        type: "result",
        state: "error",
        payload: { is_error: true, error_detail: "seeded failure" },
      } as unknown as Envelope)
    : ({
        version: "0",
        agent_id: agentId,
        session_id: sessionId,
        ts,
        seq,
        type: "log",
        state: "thinking",
        payload: { kind: "assistant", text: `entry ${seq}` },
      } as unknown as Envelope);
}

/** onHistoryReplayEnvelope's real caller (parseHistoryReplayEnvelope,
 *  protocol.ts) rejects anything but `type: "inter_agent_message"` --
 *  a `result`/is_error envelope can never reach this path in production.
 *  This building block exists so the "replay" operation below exercises
 *  the actual reachable shape instead of an impossible one. */
function randomInterAgentMessageEnvelope(
  rand: () => number,
  agentId: string,
  to: string,
): Envelope {
  const ts = new Date(
    Date.parse("2026-09-01T00:00:00Z") + Math.floor(rand() * 1_000_000),
  ).toISOString();
  const seq = seqCounter++;
  return {
    version: "0",
    agent_id: agentId,
    ts,
    seq,
    type: "inter_agent_message",
    state: "thinking",
    payload: {
      to,
      conversation_id: `conv-${seq}`,
      turn_number: 1,
      kind: "inform",
      body: "x",
      meta: { done: false, propose_next: "" },
      owner: { kind: "agent", id: agentId },
    },
  } as unknown as Envelope;
}

async function mountApp(): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (captured.handlers === null) throw new Error("not connected yet");
  });
  return captured.handlers!;
}

beforeEach(() => {
  captured.handlers = null;
  captured.latestIndex = null;
  seqCounter = 0;
  lastTsSeqByAgent = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/session/ticket")) {
        return { ok: true, status: 200, json: async () => ({ ticket: "t-1" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.stubGlobal("confirm", () => true);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AGENT_IDS = ["a1", "a2", "a3"] as const;
const SESSION_IDS = ["s1", "s2"] as const;
const OP_COUNT = 300;
const OP_KINDS = [
  "append",
  "historyJoin",
  "replay",
  "reset",
  "clear48",
  "clearCmd",
  "delete",
] as const;

describe("App.svelte error index parity (issue #304)", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`incremental index matches full-rescan reference over a random operation sequence (seed=${seed})`, async () => {
      const rand = mulberry32(seed);
      const h = await mountApp();
      h.onHosts?.([]);
      h.onSnapshot(
        Object.fromEntries(AGENT_IDS.map((id) => [id, onlineEnvelope(id)])),
      );
      await tick();

      // Test-side ground truth `logs`, advanced with the SAME exported
      // production functions App.svelte itself calls per operation -- this
      // pins the per-operation DISPATCH (which path calls which update
      // function), not a reimplementation of merge/reset/filter semantics.
      let testLogs: Record<string, Envelope[]> = {};

      const pick = <T,>(arr: readonly T[]): T =>
        arr[Math.floor(rand() * arr.length)];

      for (let i = 0; i < OP_COUNT; i++) {
        const agentId = pick(AGENT_IDS);
        const sessionId = pick(SESSION_IDS);
        const op = pick(OP_KINDS);

        switch (op) {
          case "append": {
            const envelope = randomEnvelope(
              rand,
              agentId,
              sessionId,
              rand() < 0.3,
            );
            h.onEnvelope(envelope);
            testLogs[agentId] = mergeTranscriptEntries(
              testLogs[agentId] ?? [],
              [envelope],
            );
            break;
          }
          case "historyJoin": {
            // Reconnect surfacing one fresh row for one agent -- no
            // `epoch` passed, so applyProjectionEpoch's merge-with-
            // baseline path runs (never the discard-and-rebuild branch).
            const envelope = randomEnvelope(
              rand,
              agentId,
              sessionId,
              rand() < 0.3,
            );
            const histories = {
              [agentId]: [...(testLogs[agentId] ?? []), envelope],
            };
            h.onHistory?.(histories, {}, "per-pane-v1");
            testLogs = mergeHistories(histories, testLogs);
            break;
          }
          case "replay": {
            // Real transport shape: onHistoryReplayEnvelope only ever
            // receives an inter_agent_message (parseHistoryReplayEnvelope
            // rejects anything else), so it can never carry an is_error
            // result -- this operation exercises "logs gains a row via
            // this path" without ever touching the error index.
            const other = AGENT_IDS.find((id) => id !== agentId) ?? agentId;
            const envelope = randomInterAgentMessageEnvelope(
              rand,
              agentId,
              other,
            );
            h.onHistoryReplayEnvelope?.(agentId, envelope);
            testLogs[agentId] = mergeTranscriptEntries(
              testLogs[agentId] ?? [],
              [envelope],
            );
            break;
          }
          case "reset": {
            const preserveInterAgent = rand() < 0.5;
            h.onHistoryReset?.(agentId, preserveInterAgent, `replay-${i}`);
            testLogs[agentId] = resetTranscriptHistory(
              testLogs[agentId] ?? [],
              preserveInterAgent,
            );
            break;
          }
          case "clear48": {
            const watermark =
              rand() < 0.5
                ? undefined
                : randomEnvelope(rand, agentId, sessionId, false).ts;
            h.onHistoryCleared?.(agentId, sessionId, watermark);
            testLogs[agentId] = filterAfterHistoryCleared(
              testLogs[agentId] ?? [],
              sessionId,
              watermark,
            );
            break;
          }
          case "clearCmd": {
            // retainClearMarkerOnly (App.svelte) never retains a
            // `result`-type entry, so /clear unconditionally wipes this
            // agent's cached error regardless of its exact marker-match
            // details -- safe to model as an empty transcript here.
            const payload: SessionResetCompletedPayload = {
              request_id: `req-${i}`,
              agent_id: agentId,
              mode: "clear",
              to_session_id: null,
            };
            h.onSessionResetCompleted?.(payload);
            testLogs[agentId] = [];
            break;
          }
          case "delete": {
            h.onAgentDeleted?.(agentId);
            delete testLogs[agentId];
            break;
          }
        }
        await tick();

        const actualKeys = captured.latestIndex?.keyByAgent ?? {};
        const expectedKeys = referenceLatestErrorKeyByAgent(testLogs);
        expect(
          actualKeys,
          `seed=${seed} step=${i} op=${op} agentId=${agentId}`,
        ).toEqual(expectedKeys);
      }
    });
  }

  // logout resets `errorIndex` via a direct EMPTY_ERROR_INDEX assignment,
  // not through any of the 3 tracked functions -- unobservable via the spy
  // above, so this checks the same invariant through the DOM instead,
  // mirroring appUnackedErrorAck.integration.test.ts's own logout case.
  it("logout clears the badge (index reset is not spy-observable, verified via DOM)", async () => {
    const h = await mountApp();
    h.onHosts?.([]);
    h.onSnapshot({ a1: onlineEnvelope("a1") });
    h.onEnvelope(randomEnvelope(mulberry32(7), "a1", "s1", true));
    await tick();
    expect(document.querySelector(".badge")).not.toBeNull();

    document.querySelector<HTMLButtonElement>("button.logout")?.click();
    await tick();
    await tick();

    // Back at the login form; re-login and re-seed the SAME error to
    // confirm the badge is driven by a FRESH (empty) index, not a stale
    // one that happens to render nothing while the login form is up.
    captured.handlers = null;
    const tokenInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="アクセストークン"]',
    );
    const form = document.querySelector<HTMLFormElement>("form.login-card");
    expect(tokenInput).not.toBeNull();
    expect(form).not.toBeNull();
    tokenInput!.value = "dummy-token";
    tokenInput!.dispatchEvent(new Event("input", { bubbles: true }));
    form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => {
      if (captured.handlers === null) throw new Error("not reconnected yet");
    });
    const h2 = captured.handlers!;
    h2.onHosts?.([]);
    h2.onSnapshot({ a1: onlineEnvelope("a1") });
    await tick();

    expect(document.querySelector(".badge")).toBeNull();
  });
});
