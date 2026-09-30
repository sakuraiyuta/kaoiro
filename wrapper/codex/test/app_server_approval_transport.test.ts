import { describe, expect, it } from "vitest";
import { AppServerConnectionError } from "../src/app_server_rpc.js";
import {
  AppServerForeignTurnError, AppServerTurnStartUnknownError,
} from "../src/app_server_transport.js";
import type { ApprovalTransition } from "../src/app_server_approval.js";
import { FILE, harness, settle, THREAD } from "./app_server_approval_harness.js";

const steps = (transitions: ApprovalTransition[], id: number) =>
  transitions.filter(t => t.key.endsWith(`:n:${id}`)).map(t => `${t.from}.${t.event}>${t.to}`);

// Whether the transport still has an active turn for "tok", read synchronously
// through steer without sending anything.
function activeProbe(h: Awaited<ReturnType<typeof harness>>): string {
  const attempt = h.transport.steer({ hostTurnToken: "tok", input: "x", clientUserMessageId: "probe", admit: () => "probe" });
  return attempt.kind === "declined" ? "active" : attempt.kind === "starting" ? "starting" : "retired";
}

describe("owner terminal orders (r5 §B)", () => {
  it("T -> R -> Ks=: the folded terminal drops the held request", async () => {
    const h = await harness();
    await h.reserve();
    h.completed("t1"); h.request(0); await settle();
    h.startNamed("t1"); await settle();
    expect(steps(h.transitions, 0)).toEqual(["absent.R>held", "held.Kn>dropped"]);
    expect(h.f.replies()).toEqual([]);
    expect(h.slots).toEqual([]);
    await h.finish();
  });

  it("R -> T -> Ks=: the same", async () => {
    const h = await harness();
    await h.reserve();
    h.request(0); h.completed("t1"); await settle();
    h.startNamed("t1"); await settle();
    expect(steps(h.transitions, 0)).toEqual(["absent.R>held", "held.Kn>dropped"]);
    expect(h.slots).toEqual([]);
    await h.finish();
  });

  it("T -> Ks= -> R: the replay retires the owner, so R has none", async () => {
    const h = await harness();
    await h.reserve();
    h.completed("t1"); h.startNamed("t1"); await settle();
    h.request(0); await settle();
    expect(steps(h.transitions, 0)).toEqual(["absent.R>rejected"]);
    expect(h.transitions[0]!.rule).toBe(4);
    await h.finish();
  });

  it("Ks= -> T -> R: T at receipt retires the owner", async () => {
    const h = await harness();
    await h.reserve();
    h.startNamed("t1"); await settle();
    h.completed("t1"); await settle();
    h.request(0); await settle();
    expect(h.transitions[0]).toMatchObject({ to: "rejected", rule: 4 });
    await h.finish();
  });

  it("Ks= -> R -> T: the only order that shows a dialog, cleared by T", async () => {
    const h = await harness();
    await h.reserve();
    h.startNamed("t1"); await settle();
    h.request(0); await settle();
    expect(h.slots.at(-1)).toMatchObject({ tool_name: "codex:command_execution" });
    h.completed("t1"); await settle();
    expect(steps(h.transitions, 0)).toEqual(["absent.R>pending", "pending.T>dropped"]);
    expect(h.slots.at(-1)).toBeNull();
    expect(h.f.replies()).toEqual([]);
    await h.finish();
  });

  it("a terminal for another turn inside the window does not set the owner fact", async () => {
    const h = await harness();
    await h.reserve();
    h.request(0); h.completed("t9"); await settle();
    h.startNamed("t1"); await settle();
    expect(steps(h.transitions, 0)).toEqual(["absent.R>held", "held.Kn>pending"]);
    await h.finish();
  });

  it("a terminal on another thread with the owner's turn id does not set it", async () => {
    const h = await harness();
    await h.reserve();
    h.request(0); h.completed("t1", "thread-other"); await settle();
    h.startNamed("t1"); await settle();
    expect(steps(h.transitions, 0)).toEqual(["absent.R>held", "held.Kn>pending"]);
    await h.finish();
  });

  // R5 should 1: mixed and repeated terminals, several held records, and the
  // claim that every record settles before the owner can be retired.
  it("mixed and duplicate terminals: only the owner's sets the latch; records settle once, before retirement", async () => {
    const probes: string[] = [];
    let h!: Awaited<ReturnType<typeof harness>>;
    h = await harness({ onTransition: t => { if (t.to !== "held") probes.push(`${t.key.split(":").pop()}:${activeProbe(h)}`); } });
    await h.reserve();
    h.request(0, "t1"); h.request(1, "t9");
    h.completed("t9"); h.completed("t1"); h.completed("t9"); h.completed("t1");
    await settle();
    h.startNamed("t1"); await settle();
    expect(steps(h.transitions, 0)).toEqual(["absent.R>held", "held.Kn>dropped"]);
    expect(steps(h.transitions, 1)).toEqual(["absent.R>held", "held.Kn>dropped"]);
    expect(h.transitions.filter(t => t.event === "Kn").map(t => t.rule)).toEqual([6, 6]);
    // Both settled while the owner was still the active turn.
    expect(probes).toEqual(["0:active", "1:active"]);
    expect(activeProbe(h)).toBe("retired");
    await h.finish();
  });

  it("the same buffer without the owner's terminal: the owner's request shows, the other is rejected", async () => {
    const h = await harness();
    await h.reserve();
    h.request(0, "t1"); h.request(1, "t9");
    h.completed("t9"); h.completed("t9");
    await settle();
    h.startNamed("t1"); await settle();
    expect(steps(h.transitions, 0)).toEqual(["absent.R>held", "held.Kn>pending"]);
    expect(h.transitions.find(t => t.key.endsWith(":n:1") && t.event === "Kn")).toMatchObject({ to: "rejected", rule: 8, write: "-32601" });
    expect(activeProbe(h)).toBe("active");
    await h.finish();
  });

  it("a pending request is dropped by T before the owner is retired", async () => {
    const probes: string[] = [];
    let h!: Awaited<ReturnType<typeof harness>>;
    h = await harness({ onTransition: t => { if (t.event === "T") probes.push(activeProbe(h)); } });
    await h.reserve();
    h.startNamed("t1"); await settle();
    h.request(0); h.request(1); await settle();
    h.completed("t1"); await settle();
    expect(probes).toEqual(["active", "active"]);
    await h.finish();
  });
});

describe("gate at the transport", () => {
  it("opt-in off: turn/start carries never and a request gets -32601 without a dialog", async () => {
    const h = await harness({ approvals: false });
    const start = await h.reserve("tok", "on-request");
    expect(start.params).toMatchObject({ approvalPolicy: "never", approvalsReviewer: "user" });
    h.startNamed("t1"); await settle();
    h.request(0); await settle();
    expect(h.f.replies()).toEqual([{ id: 0, error: { code: -32601, message: "Client approval and server-request handling are disabled" } }]);
    expect(h.slots).toEqual([]);
    await h.finish();
  });

  it("opt-in on, turn submitted with never: -32601", async () => {
    const h = await harness();
    const start = await h.reserve("tok", "never");
    expect(start.params).toMatchObject({ approvalPolicy: "never" });
    h.startNamed("t1"); await settle();
    h.request(0); await settle();
    expect(h.transitions[0]).toMatchObject({ to: "rejected", rule: 9, write: "-32601" });
    await h.finish();
  });

  it("opt-in on, turn submitted with on-request: shown (positive control)", async () => {
    const h = await harness();
    const start = await h.reserve("tok", "untrusted");
    expect(start.params).toMatchObject({ approvalPolicy: "untrusted" });
    h.startNamed("t1"); await settle();
    h.request(0); await settle();
    expect(h.transitions[0]).toMatchObject({ to: "pending", rule: 10 });
    await h.finish();
  });

  it("a fileChange request carries the item's changes from the wire snapshot", async () => {
    const h = await harness();
    await h.reserve();
    h.startNamed("t1"); await settle();
    h.item("t1", "item/started", { id: "fc-1", type: "fileChange", changes: [{ path: "p5.txt", kind: "add", diff: "+hello" }] });
    h.request(0, "t1", { itemId: "fc-1", reason: null, grantRoot: null, kind: undefined, command: undefined, cwd: undefined }, FILE);
    await settle();
    expect(h.slots.at(-1)).toMatchObject({ tool_name: "codex:file_change", input: { item_id: "fc-1", changes: [{ path: "p5.txt", kind: "add", diff: "+hello" }] } });
    await h.finish();
  });
});

// The dialog's `changes` come from the requesting turn's own fileChange item:
// the key is (thread, turn, item), so an item id reused by another turn,
// before or after the start response, never supplies the displayed edit.
describe("fileChange snapshots are bound to the requesting turn", () => {
  const fc = (path: string) => ({ id: "same-item", type: "fileChange", changes: [{ path, kind: "add", diff: `+${path}` }] });
  const askFile = (h: Awaited<ReturnType<typeof harness>>, id: number, turnId: string, itemId = "same-item") =>
    h.request(id, turnId, { itemId, reason: null, grantRoot: null, kind: undefined, command: undefined, cwd: undefined }, FILE);
  const shownChanges = (h: Awaited<ReturnType<typeof harness>>) => (h.slots.at(-1)?.input as Record<string, unknown> | undefined);
  // Completes an owned earlier turn, then reserves the current one.
  async function afterOldTurn() {
    const h = await harness();
    await h.reserve("old");
    h.startNamed("t-old"); h.completed("t-old"); await settle();
    await h.reserve("tok");
    return h;
  }

  it("after the start response: a late item of the earlier turn does not supply the dialog", async () => {
    const h = await afterOldTurn();
    h.startNamed("t-new"); await settle();
    h.item("t-old", "item/started", fc("old.txt"));
    askFile(h, 5, "t-new"); await settle();
    expect(shownChanges(h)).toMatchObject({ item_id: "same-item", changes_unavailable: true });
    expect(shownChanges(h)).not.toHaveProperty("changes");
    await h.finish();
  });

  it("after the start response: a late earlier-turn item does not overwrite the current turn's", async () => {
    const h = await afterOldTurn();
    h.startNamed("t-new"); await settle();
    h.item("t-new", "item/started", fc("new.txt"));
    h.item("t-old", "item/completed", fc("old.txt"));
    askFile(h, 5, "t-new"); await settle();
    expect(shownChanges(h)).toMatchObject({ changes: [{ path: "new.txt" }] });
    await h.finish();
  });

  for (const order of ["old first", "new first"] as const) {
    it(`in the reservation window (${order}): only the named turn's item is shown`, async () => {
      const h = await afterOldTurn();
      if (order === "old first") { h.item("t-old", "item/started", fc("old.txt")); h.item("t-new", "item/started", fc("new.txt")); }
      else { h.item("t-new", "item/started", fc("new.txt")); h.item("t-old", "item/completed", fc("old.txt")); }
      askFile(h, 5, "t-new"); await settle();
      h.startNamed("t-new"); await settle();
      expect(h.transitions.find(t => t.key.endsWith(":n:5"))?.to).toBe("held");
      expect(shownChanges(h)).toMatchObject({ changes: [{ path: "new.txt" }] });
      await h.finish();
    });
  }

  it("in the reservation window: only an earlier-turn item leaves the dialog without changes", async () => {
    const h = await afterOldTurn();
    h.item("t-old", "item/started", fc("old.txt"));
    askFile(h, 5, "t-new"); await settle();
    h.startNamed("t-new"); await settle();
    expect(shownChanges(h)).toMatchObject({ changes_unavailable: true });
    await h.finish();
  });

  it("negative control: a different item id of the current turn is shown as before", async () => {
    const h = await afterOldTurn();
    h.startNamed("t-new"); await settle();
    h.item("t-new", "item/started", { ...fc("other.txt"), id: "other-item" });
    askFile(h, 5, "t-new", "other-item"); await settle();
    expect(shownChanges(h)).toMatchObject({ item_id: "other-item", changes: [{ path: "other.txt" }] });
    await h.finish();
  });

  it("other turns' items cannot fill the bound: after naming they are not stored, and window ones are pruned", async () => {
    const h = await afterOldTurn();
    for (let i = 0; i < 256; i += 1) h.item("t-old", "item/started", { ...fc("old.txt"), id: `w-${i}` });
    h.startNamed("t-new"); await settle();
    for (let i = 0; i < 256; i += 1) h.item("t-old", "item/started", { ...fc("old.txt"), id: `n-${i}` });
    h.item("t-new", "item/started", fc("new.txt"));
    askFile(h, 5, "t-new"); await settle();
    expect(shownChanges(h)).toMatchObject({ changes: [{ path: "new.txt" }] });
    await h.finish();
  });
});

describe("duplicate and reused server-request ids (r3 §D)", () => {
  for (const phase of ["held", "pending", "replied"] as const) {
    it(`a duplicate while ${phase} fails the connection with no reply carrying the id`, async () => {
      const h = await harness();
      await h.reserve();
      if (phase !== "held") { h.startNamed("t1"); await settle(); }
      h.request(0); await settle();
      if (phase === "replied") { h.decideAll(true); await settle(); }
      const before = h.f.replies().length;
      h.request(0); await settle();
      expect(h.f.replies().length).toBe(before);
      expect(h.transitions.at(-1)!.to).toBe(phase === "replied" ? "replied" : "dropped");
      if (phase !== "replied") expect(h.transitions.at(-1)!.event).toBe("F");
      if (phase === "pending") expect(h.slots.at(-1)).toBeNull();
      await h.finish();
      if (phase === "held") {
        expect(h.turnError).toBeInstanceOf(AppServerConnectionError);
        expect((h.turnError as AppServerConnectionError).kind).toBe("protocol");
      }
    });
  }

  it("an integer and a string id with the same text are different requests", async () => {
    const h = await harness();
    await h.reserve();
    h.startNamed("t1"); await settle();
    h.request(0); h.request("0"); await settle();
    expect(h.transitions.map(t => t.key.replace(/^\d+:/, ""))).toEqual(["n:0", "s:0"]);
    expect(h.transitions.map(t => t.to)).toEqual(["pending", "pending"]);
    await h.finish();
  });
});

describe("the beforeResponse bound (R5 should 2)", () => {
  it("fails the connection instead of evicting when the buffer is full", async () => {
    const h = await harness({ maxBeforeResponse: 3 });
    await h.reserve();
    h.request(0);
    for (let i = 0; i < 3; i += 1) h.item("t1");
    await settle();
    expect(h.turnError).toBeUndefined();
    h.item("t1"); await settle();
    await h.finish();
    expect(h.turnError).toBeInstanceOf(AppServerTurnStartUnknownError);
    expect((h.turnError as AppServerTurnStartUnknownError).original.kind).toBe("protocol");
    expect(steps(h.transitions, 0)).toEqual(["absent.R>held", "held.F>dropped"]);
    expect(h.f.replies()).toEqual([]);
  });
});

describe("the issue #451 start-unknown path", () => {
  it("a held request and a turn/start timeout: dropped, no write, still unknown", async () => {
    const h = await harness({ requestTimeoutMs: 50 });
    await h.reserve();
    h.request(0); await settle();
    await new Promise(resolve => setTimeout(resolve, 80));
    await h.finish();
    expect(h.turnError).toBeInstanceOf(AppServerTurnStartUnknownError);
    expect((h.turnError as AppServerTurnStartUnknownError).reason).toBe("turn_start_timeout");
    expect(steps(h.transitions, 0)).toEqual(["absent.R>held", "held.F>dropped"]);
    expect(h.f.replies()).toEqual([]);
  });

  it("a held request and a local close: dropped, no write", async () => {
    const h = await harness();
    await h.reserve();
    h.request(0); await settle();
    await h.finish();
    expect(steps(h.transitions, 0)).toEqual(["absent.R>held", "held.F>dropped"]);
    expect(h.f.replies()).toEqual([]);
  });
});

describe("every reservation window ending judges deferred evidence (r4 §A)", () => {
  it("(1) a deferred request for an unknown turn, then a JSON-RPC error: the next start is refused", async () => {
    const h = await harness({ enforceForeignTurn: true });
    await h.reserve();
    h.request(0, "t-foreign"); await settle();
    h.startError(); await settle();
    expect(h.foreign).toEqual([{ threadId: THREAD, turnId: "t-foreign" }]);
    await expect(h.transport.startTurn({ threadId: THREAD, hostTurnToken: "next", input: "x" })).rejects.toBeInstanceOf(AppServerForeignTurnError);
    expect(steps(h.transitions, 0)).toEqual(["absent.R>held", "held.Ku>rejected"]);
    await h.finish();
  });

  it("(2) the same with a deferred item/started notification", async () => {
    const h = await harness({ enforceForeignTurn: true });
    await h.reserve();
    h.item("t-foreign"); await settle();
    h.startError(); await settle();
    await expect(h.transport.startTurn({ threadId: THREAD, hostTurnToken: "next", input: "x" })).rejects.toBeInstanceOf(AppServerForeignTurnError);
    await h.finish();
  });

  for (const [label, extra] of [
    ["beforeDispatch rejects", { beforeDispatch: () => gate.promise }],
    ["onDispatch supersedes", { beforeDispatch: () => gate.promise.then(() => undefined), onDispatch: () => { throw new Error("superseded"); } }],
  ] as const) {
    it(`(3) a failure before turn/start is written (${label}): the immediate retry is refused`, async () => {
      const h = await harness({ enforceForeignTurn: true });
      gate = deferred();
      const turn = h.transport.startTurn({ threadId: THREAD, hostTurnToken: "tok", input: "x", ...extra });
      await settle();
      h.request(0, "t-foreign"); await settle();
      if (label === "beforeDispatch rejects") gate.reject(new Error("admission")); else gate.resolve();
      await expect(turn).rejects.toThrow();
      // Synchronous with the rejection: the retry reserves after the exit ran.
      await expect(h.transport.startTurn({ threadId: THREAD, hostTurnToken: "retry", input: "x" })).rejects.toBeInstanceOf(AppServerForeignTurnError);
      expect(h.turnStarts).toEqual([]);
      expect(steps(h.transitions, 0)).toEqual(["absent.R>held", "held.Ku>rejected"]);
      await h.finish();
    });
  }

  it("(4) negative control: deferred evidence naming an own turn does not trip", async () => {
    const h = await harness({ enforceForeignTurn: true });
    await h.reserve("t0");
    h.startNamed("t-own"); h.completed("t-own"); await settle();
    await h.reserve("tok");
    h.item("t-own"); await settle();
    h.startError(); await settle();
    expect(h.foreign).toEqual([]);
    await h.reserve("next");
    expect(h.turnError).toBeUndefined();
    await h.finish();
  });

  it("(5) a named start: evidence naming the new turn does not trip", async () => {
    const h = await harness({ enforceForeignTurn: true });
    await h.reserve();
    h.request(0, "t1"); h.item("t1"); await settle();
    h.startNamed("t1"); await settle();
    expect(h.foreign).toEqual([]);
    await h.finish();
  });

  it("(6) a connection failure: evidence is judged and held records drop with no write", async () => {
    const h = await harness();
    await h.reserve();
    h.request(0, "t-foreign"); await settle();
    h.f.eof(); await settle();
    await h.finish();
    expect(h.foreign).toEqual([{ threadId: THREAD, turnId: "t-foreign" }]);
    expect(steps(h.transitions, 0)).toEqual(["absent.R>held", "held.F>dropped"]);
    expect(h.f.replies()).toEqual([]);
  });

  it("(7) enforcement off: (1) reports the foreign turn and the next start proceeds", async () => {
    const h = await harness({ enforceForeignTurn: false });
    await h.reserve();
    h.request(0, "t-foreign"); await settle();
    h.startError(); await settle();
    expect(h.foreign).toEqual([{ threadId: THREAD, turnId: "t-foreign" }]);
    await h.reserve("next");
    expect(h.turnError).toBeUndefined();
    await h.finish();
  });

  it("a request on another thread is neither foreign evidence nor admitted", async () => {
    const h = await harness({ enforceForeignTurn: true });
    await h.reserve();
    h.startNamed("t1"); await settle();
    h.request(0, "t-x", { threadId: "thread-other" }); await settle();
    expect(h.foreign).toEqual([]);
    expect(h.transitions[0]).toMatchObject({ to: "rejected", rule: 3 });
    await h.finish();
  });

  it("a request for a known own turn after it completed is rejected without tripping", async () => {
    const h = await harness({ enforceForeignTurn: true });
    await h.reserve("t0");
    h.startNamed("t-own"); h.completed("t-own"); await settle();
    h.request(0, "t-own"); await settle();
    expect(h.foreign).toEqual([]);
    expect(h.transitions[0]).toMatchObject({ to: "rejected", rule: 4 });
    await h.finish();
  });
});

let gate = deferred();
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("abort ordering against operator decisions", () => {
  it("A before D: dropped, the late decision is ignored", async () => {
    const h = await harness();
    await h.reserve();
    h.startNamed("t1"); await settle();
    h.request(0); await settle();
    h.transport.abortApprovals("tok");
    h.decideAll(true);
    await settle();
    expect(steps(h.transitions, 0)).toEqual(["absent.R>pending", "pending.A>dropped"]);
    expect(h.f.replies()).toEqual([]);
    await h.finish();
  });

  it("D before A: the accept is written and the abort finds nothing", async () => {
    const h = await harness();
    await h.reserve();
    h.startNamed("t1"); await settle();
    h.request(0); await settle();
    h.decideAll(true);
    h.transport.abortApprovals("tok");
    await settle();
    expect(h.f.replies()).toEqual([{ id: 0, result: { decision: "accept" } }]);
    await h.finish();
  });

  it("D and S in the same macrotask: exactly one write", async () => {
    const h = await harness();
    await h.reserve();
    h.startNamed("t1"); await settle();
    h.request(0); await settle();
    h.resolved(0);
    h.decideAll(false);
    await settle();
    // The decision settles synchronously; S arrives on the wire after it.
    expect(h.f.replies()).toEqual([{ id: 0, result: { decision: "decline" } }]);
    expect(steps(h.transitions, 0)).toEqual(["absent.R>pending", "pending.D>replied", "replied.S>replied"]);
    await h.finish();
  });

  it("an abort for another host turn token changes nothing", async () => {
    const h = await harness();
    await h.reserve();
    h.startNamed("t1"); await settle();
    h.request(0); await settle();
    h.transport.abortApprovals("other");
    expect(steps(h.transitions, 0)).toEqual(["absent.R>pending"]);
    await h.finish();
  });
});

describe("routed methods", () => {
  it("answers a permissions-profile request with -32601 even when the gate is open", async () => {
    const h = await harness();
    await h.reserve();
    h.startNamed("t1"); await settle();
    h.request(0, "t1", {}, "item/permissions/requestApproval"); await settle();
    expect(h.transitions[0]).toMatchObject({ to: "rejected", rule: 1, write: "-32601" });
    await h.finish();
  });

});
