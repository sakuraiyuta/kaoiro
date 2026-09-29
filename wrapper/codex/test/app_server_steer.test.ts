import { describe, expect, it } from "vitest";
import { SteerRecord, type SteerOutcome, type SteerResponse, type SteerTerminal } from "../src/app_server_steer.js";

const responses: Record<string, SteerResponse> = {
  A: { kind: "A" },
  V: { kind: "V", turnId: "other" },
  P: { kind: "P", reason: "turn_changed" },
  E: { kind: "E", code: -32602, message: "bad" },
  C: { kind: "C" },
};

// Literal oracle for design r3 §1, keyed by response|observed-before-terminal|terminal.
// Deliberately not computed by settleSteer.
const expected: Record<string, string> = {
  "A|O|T": "included", "A|-|T": "unknown:not_observed", "A|O|X": "included", "A|-|X": "unknown:connection",
  "V|O|T": "unknown:protocol_violation", "V|-|T": "unknown:protocol_violation",
  "V|O|X": "unknown:protocol_violation", "V|-|X": "unknown:protocol_violation",
  "P|O|T": "unknown:protocol_contradiction", "P|-|T": "requeued:turn_changed",
  "P|O|X": "unknown:protocol_contradiction", "P|-|X": "requeued:turn_changed",
  "E|O|T": "unknown:protocol_contradiction", "E|-|T": "refused:-32602",
  "E|O|X": "unknown:protocol_contradiction", "E|-|X": "refused:-32602",
  "C|O|T": "included", "C|-|T": "unknown:connection", "C|O|X": "included", "C|-|X": "unknown:connection",
};

const label = (o: SteerOutcome) => o.kind === "included" ? "included"
  : o.kind === "requeued" ? `requeued:${o.reason}`
  : o.kind === "refused" ? `refused:${o.code}` : `unknown:${o.reason}`;

type Step = "R" | "O" | "T";
function run(order: Step[], response: SteerResponse, terminal: SteerTerminal) {
  const settled: SteerOutcome[] = [];
  const record = new SteerRecord("kaoiro-steer:1", "turn-1", { onSettle: o => settled.push(o) });
  for (const step of order) {
    if (step === "R") record.respond(response);
    else if (step === "O") record.observe();
    else record.end(terminal);
  }
  return settled;
}

const orders: Step[][] = [
  ["O", "R", "T"], ["O", "T", "R"], ["R", "O", "T"], ["R", "T", "O"], ["T", "O", "R"], ["T", "R", "O"],
  ["R", "T"], ["T", "R"],
];

describe("steer record settlement over every arrival order (design r3 §2)", () => {
  for (const order of orders) {
    for (const kind of Object.keys(responses)) {
      for (const terminal of ["T", "X"] as const) {
        const observed = order.includes("O") && order.indexOf("O") < order.indexOf("T");
        const key = `${kind}|${observed ? "O" : "-"}|${terminal}`;
        it(`${order.join(">")} with ${kind}/${terminal} settles once as ${expected[key]}`, () => {
          const settled = run(order, responses[kind]!, terminal);
          expect(settled.map(label)).toEqual([expected[key]]);
        });
      }
    }
  }

  it("fuji order 1: terminal then accepted response", () => {
    expect(run(["T", "R"], responses.A!, "T").map(label)).toEqual(["unknown:not_observed"]);
  });
  it("fuji order 2: terminal then precondition rejection requeues", () => {
    expect(run(["T", "R"], responses.P!, "T").map(label)).toEqual(["requeued:turn_changed"]);
  });
  it("fuji order 3: input item, terminal, then accepted response is included", () => {
    expect(run(["O", "T", "R"], responses.A!, "T").map(label)).toEqual(["included"]);
  });
});

describe("steer record latches (AC-2)", () => {
  it("response-side latch: a duplicate response after settlement settles nothing", () => {
    const settled: SteerOutcome[] = [];
    const record = new SteerRecord("id", "turn-1", { onSettle: o => settled.push(o) });
    expect(record.respond({ kind: "A" })).toBe(true);
    record.observe();
    expect(record.end("T")).toBe(true);
    expect(record.respond({ kind: "C" })).toBe(false);
    expect(settled.map(label)).toEqual(["included"]);
  });

  it("terminal-side latch: a duplicate terminal after settlement settles nothing", () => {
    const settled: SteerOutcome[] = [];
    const record = new SteerRecord("id", "turn-1", { onSettle: o => settled.push(o) });
    expect(record.end("T")).toBe(true);
    expect(record.respond({ kind: "A" })).toBe(true);
    expect(record.end("X")).toBe(false);
    expect(settled.map(label)).toEqual(["unknown:not_observed"]);
  });

  it("an observation after the terminal is ignored", () => {
    const record = new SteerRecord("id", "turn-1", { onSettle: () => {} });
    record.end("T");
    expect(record.observe()).toBe(false);
  });

  it("the response hook runs before settlement in the response's own section (AC-1 order)", () => {
    const calls: string[] = [];
    const record = new SteerRecord("id", "turn-1", {
      onResponse: r => calls.push(`response:${r.kind}`),
      onSettle: o => calls.push(`settle:${label(o)}`),
    });
    record.end("T");
    record.respond({ kind: "P", reason: "turn_changed" });
    expect(calls).toEqual(["response:P", "settle:requeued:turn_changed"]);
  });
});
