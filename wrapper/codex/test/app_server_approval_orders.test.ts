import { afterAll, describe, expect, it, vi } from "vitest";
import type { ApprovalTransition } from "../src/app_server_approval.js";
import { harness, settle } from "./app_server_approval_harness.js";

// Order coverage for approval records (ADR-0064, issue #367 r3 §C / r5).
//
// A generator emits every order of a per-family event alphabet, constrained
// only by causality (a key's S after its R; nothing after the connection is
// gone). Each order runs through the real rpc, transport, router and broker
// over a fake child. The expected result comes from the literal oracle below,
// which does not import the implementation: its admission list is written out
// again here. After all runs, the (state, event) cells the implementation
// visited are compared with the table: a visited cell outside the table, or a
// reachable cell no run visited, fails.

type Start = "same" | "other" | "unnamed" | "failed";
type Operator = "accept" | "decline" | "timeout";
type Event =
  | { kind: "R"; key: string } | { kind: "S"; key: string } | { kind: "O"; key: string; value: Operator }
  | { kind: "K"; start: Start } | { kind: "T" } | { kind: "F" } | { kind: "A" };

interface Expected { state: string; writes: string[]; shown: boolean }

// ---- the oracle -------------------------------------------------------------

function oracle(events: Event[], keys: string[]): Record<string, Expected> {
  const owner = { alive: true, aborted: false, terminal: false, start: undefined as Start | undefined, bufferedT: false };
  let rpcFailed = false;
  const rec: Record<string, Expected & { live: boolean }> = {};
  for (const key of keys) rec[key] = { state: "absent", writes: [], shown: false, live: false };

  const finalize = (key: string, state: string, write?: string) => {
    const r = rec[key]!;
    r.state = state;
    r.live = state === "held" || state === "pending";
    if (write !== undefined) r.writes.push(write);
    if (state === "pending") r.shown = true;
  };
  // Literal admission list (r5), for a valid request on the bound thread
  // under an open opt-in and an on-request policy.
  const admission = (): [string, number] => {
    if (rpcFailed) return ["dropped", 2];
    if (!owner.alive) return ["rejected", 4];
    if (owner.aborted) return ["dropped", 5];
    if (owner.terminal) return ["dropped", 6];
    if (owner.start === undefined) return ["held", 7];
    if (owner.start !== "same") return ["rejected", 8];
    return ["pending", 10];
  };
  const admitKey = (key: string) => {
    const [state] = admission();
    finalize(key, state, state === "rejected" && !rpcFailed ? "-32601" : undefined);
  };
  const dropLive = () => { for (const key of keys) if (rec[key]!.live) finalize(key, "dropped"); };

  for (const event of events) {
    switch (event.kind) {
      case "R": admitKey(event.key); break;
      case "S": if (rec[event.key]!.live) finalize(event.key, "dropped"); break;
      case "O": {
        const r = rec[event.key]!;
        if (r.state === "pending") finalize(event.key, "replied", event.value === "accept" ? "accept" : "decline");
        break;
      }
      case "K":
        if (event.start === "failed") {
          dropLive();
          rpcFailed = true;
          owner.alive = false;
          break;
        }
        owner.start = event.start;
        if (event.start === "same" && owner.bufferedT) owner.terminal = true;
        for (const key of keys) if (rec[key]!.state === "held") admitKey(key);
        if (event.start === "unnamed" || (event.start === "same" && owner.bufferedT)) owner.alive = false;
        break;
      case "T":
        if (!owner.alive) break;
        if (owner.start === undefined) owner.bufferedT = true;
        else if (owner.start === "same") {
          owner.terminal = true;
          for (const key of keys) if (rec[key]!.state === "pending") finalize(key, "dropped");
          owner.alive = false;
        }
        break;
      case "F":
        dropLive();
        rpcFailed = true;
        if (owner.start === undefined) owner.alive = false;
        break;
      case "A":
        if (!owner.alive) break;
        owner.aborted = true;
        dropLive();
        break;
    }
  }
  const out: Record<string, Expected> = {};
  for (const key of keys) out[key] = { state: rec[key]!.state, writes: rec[key]!.writes, shown: rec[key]!.shown };
  return out;
}

// ---- the generator ----------------------------------------------------------

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) { yield [...items]; return; }
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) yield [items[i]!, ...tail];
  }
}

const label = (e: Event) => e.kind === "R" || e.kind === "S" ? `${e.kind}(${e.key})`
  : e.kind === "O" ? `O(${e.key}:${e.value})` : e.kind === "K" ? `K(${e.start})` : e.kind;

/** Orders obeying causality only; everything after the connection is gone is
 * cut, since nothing can arrive or be written after it. */
function orders(alphabet: Event[]): Event[][] {
  const seen = new Set<string>();
  const out: Event[][] = [];
  for (const order of permutations(alphabet)) {
    let ok = true;
    const cut: Event[] = [];
    const received = new Set<string>();
    for (const event of order) {
      if (event.kind === "R") received.add(event.key);
      if (event.kind === "S" && !received.has(event.key)) { ok = false; break; }
      cut.push(event);
      if (event.kind === "F" || (event.kind === "K" && event.start === "failed")) break;
    }
    if (!ok) continue;
    const id = cut.map(label).join(" ");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(cut);
  }
  return out;
}

// ---- the runner -------------------------------------------------------------

const keyId = (key: string) => (key === "k1" ? 0 : 100);

async function run(events: Event[], keys: string[], cells: Set<string>): Promise<Record<string, Expected>> {
  const h = await harness({ deadlineMs: 1_000 });
  await h.reserve();
  // The n-th record shown owns the n-th broker request id.
  const shownOrder: string[] = [];
  for (const event of events) {
    switch (event.kind) {
      case "R": h.request(keyId(event.key)); break;
      case "S": h.resolved(keyId(event.key)); break;
      case "T": h.completed("t1"); break;
      case "F": h.f.eof(); break;
      case "A": h.transport.abortApprovals("tok"); break;
      case "K":
        if (event.start === "same") h.startNamed("t1");
        else if (event.start === "other") h.startNamed("t2");
        else if (event.start === "unnamed") h.startError();
        else h.startInvalid();
        break;
      case "O": {
        const index = shownOrder.indexOf(event.key);
        if (index < 0) break;
        if (event.value === "timeout") vi.advanceTimersByTime(1_000);
        else h.decide(`req-${index + 1}`, event.value === "accept");
        break;
      }
    }
    await settle();
    for (const t of h.transitions) if (t.to === "pending" && !shownOrder.includes(keyOf(t))) shownOrder.push(keyOf(t));
  }
  const out: Record<string, Expected> = {};
  for (const key of keys) {
    const mine = h.transitions.filter(t => keyOf(t) === key);
    const id = keyId(key);
    out[key] = {
      state: mine.at(-1)?.to ?? "absent",
      writes: h.f.replies().filter(m => m.id === id)
        .map(m => m.error !== undefined ? "-32601" : String((m.result as { decision: string }).decision)),
      shown: mine.some(t => t.to === "pending"),
    };
  }
  await h.finish();
  for (const t of h.transitions) cells.add(cell(t));
  // Every dialog that opened has closed once the connection is gone.
  if (h.slots.length > 0) expect(h.slots.at(-1)).toBeNull();
  return out;
}

function keyOf(t: ApprovalTransition): string {
  const id = Number(t.key.split(":n:")[1]);
  return id === 0 ? "k1" : "k2";
}
const FINAL = new Set(["replied", "dropped", "rejected"]);
function cell(t: ApprovalTransition): string {
  return `${FINAL.has(t.from) ? "final" : t.from}.${t.event}`;
}

// The table (r3 §C as revised by r5), in the router's event names. Every
// cell not listed cannot happen; see the reference doc for the reasons.
const REACHABLE = new Set([
  "absent.R",
  "held.Kn", "held.Ku", "held.S", "held.F", "held.A",
  "pending.S", "pending.T", "pending.F", "pending.A", "pending.D", "pending.X",
  "final.S",
]);

describe("approval record orders against the literal oracle", () => {
  const cells = new Set<string>();
  let runs = 0;

  afterAll(() => {
    // (a) nothing outside the table; (b) every reachable cell visited.
    expect([...cells].filter(c => !REACHABLE.has(c))).toEqual([]);
    expect([...REACHABLE].filter(c => !cells.has(c))).toEqual([]);
    expect(runs).toBeGreaterThan(0);
    if (process.env.KAOIRO_ORDERS_DEBUG) console.log(`runs=${runs} cells=${[...cells].sort().join(",")}`);
  });

  const families: Array<{ name: string; keys: string[]; alphabets: Event[][] }> = [
    {
      name: "one key, every start outcome and operator outcome",
      keys: ["k1"],
      alphabets: (["same", "other", "unnamed", "failed", undefined] as const).flatMap(start =>
        (["accept", "decline", "timeout"] as const).map(value => [
          { kind: "R", key: "k1" }, { kind: "S", key: "k1" }, { kind: "T" }, { kind: "F" }, { kind: "A" },
          { kind: "O", key: "k1", value },
          ...(start === undefined ? [] : [{ kind: "K", start } as Event]),
        ] as Event[])),
    },
    {
      name: "two keys sharing one owner",
      keys: ["k1", "k2"],
      alphabets: [[
        { kind: "R", key: "k1" }, { kind: "R", key: "k2" }, { kind: "K", start: "same" },
        { kind: "S", key: "k1" }, { kind: "O", key: "k2", value: "accept" }, { kind: "T" },
      ]],
    },
  ];

  for (const family of families) {
    it(`matches the oracle: ${family.name}`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const mismatches: string[] = [];
        for (const alphabet of family.alphabets) {
          for (const order of orders(alphabet)) {
            runs += 1;
            const actual = await run(order, family.keys, cells);
            const expected = oracle(order, family.keys);
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              mismatches.push(`${order.map(label).join(" ")}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
              if (mismatches.length >= 5) break;
            }
          }
          if (mismatches.length >= 5) break;
        }
        expect(mismatches).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    }, 600_000);
  }
});
