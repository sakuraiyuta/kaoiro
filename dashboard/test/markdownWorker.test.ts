import "./isolation.setup";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownWorker, type LexerPort } from "../src/lib/markdownWorker";
import { handleLexRequest, lexMarkdown, type LexMessage, type LexRequest } from "../src/lib/markdownTokens";

class Port {
  onmessage: LexerPort["onmessage"] = null;
  onerror: LexerPort["onerror"] = null;
  onmessageerror: LexerPort["onmessageerror"] = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  send(data: LexMessage) { this.onmessage?.call(this as unknown as Worker, { data } as MessageEvent); }
  get id() { return (this.postMessage.mock.lastCall![0] as LexRequest).id; }
  start(id = this.id) { this.send({ id, kind: "started" }); }
  succeed(id = this.id) { this.send({ id, ...lexMarkdown("**OK**") }); }
}
// Vitest's fake timers leave queueMicrotask real; this waits for the
// service's deferred dispatch, which was queued first.
const microtask = () => new Promise<void>((resolve) => queueMicrotask(resolve));
let service: MarkdownWorker;
let ports: Port[];
const makePort = () => { const p = new Port(); ports.push(p); return p as LexerPort; };
beforeEach(() => { vi.useFakeTimers(); ports = []; service = new MarkdownWorker(makePort); });
afterEach(() => { service.dispose(); vi.useRealTimers(); });

it("starts one timer only on the current start; accepts current late delivery", () => {
  const receive = vi.fn();
  service.request({}, "ok", receive);
  const port = ports[0]!;
  vi.advanceTimersByTime(2000);
  expect(receive).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  port.start(port.id + 1);
  expect(vi.getTimerCount()).toBe(0);
  port.start();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(999);
  port.start();
  expect(vi.getTimerCount()).toBe(1);
  // Change clock age without dispatching the expired timer callback.
  vi.setSystemTime(Date.now() + 3000);
  port.succeed();
  expect(receive.mock.lastCall?.[0].kind).toBe("tokens");
  expect(vi.getTimerCount()).toBe(0);
  expect(port.onmessage).toBeNull();
  expect(port.terminate).not.toHaveBeenCalled();
});

it("times out at 1000 ms, ignores retired callbacks and recovers", () => {
  const a = vi.fn(), b = vi.fn();
  service.request({}, "hostile", a);
  service.request({}, "normal", b);
  const old = ports[0]!, callback = old.onmessage!;
  old.start();
  vi.advanceTimersByTime(999); old.start();
  expect(old.terminate).not.toHaveBeenCalled();
  expect(ports).toHaveLength(1);
  expect(a).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  // Settlement happens at 1,000 ms; the successor keeps the result in the window.
  expect(old.terminate).toHaveBeenCalledTimes(1);
  expect(ports).toHaveLength(2);
  expect(a).not.toHaveBeenCalled();
  vi.advanceTimersByTime(50);
  expect(a).toHaveBeenCalledWith({ kind: "plain", reason: "timeout" });
  callback.call(old as unknown as Worker, { data: { id: ports[1]!.id,
    ...lexMarkdown("stale") } } as MessageEvent);
  expect(b).not.toHaveBeenCalled();
  ports[1]!.succeed();
  expect(b.mock.lastCall?.[0].kind).toBe("tokens");
});

it("retains FIFO latest owners, cancels active/pending and reuses idle worker", async () => {
  const a = {}, b = {}, c = {}, results: string[] = [];
  const cancelA = service.request(a, "a", () => results.push("a"));
  const cancelOldB = service.request(b, "old-b", () => results.push("old"));
  service.request(c, "c", () => results.push("c"));
  service.request(b, "new-b", () => results.push("b"));
  cancelOldB();
  cancelA();
  expect(ports[0]!.terminate).toHaveBeenCalledOnce();
  await microtask();
  expect(ports[1]!.postMessage.mock.lastCall?.[0].text).toBe("c");
  ports[1]!.succeed(); ports[1]!.succeed();
  expect(results).toEqual(["c", "b"]);
  expect(ports).toHaveLength(2);
  const cancelPending = service.request(a, "active", () => results.push("active"));
  service.request(b, "pending", () => results.push("pending"))();
  cancelPending();
  expect(ports[1]!.onmessage).toBeNull();
  service.request({}, "new", () => {});
  await microtask();
  ports[2]!.succeed();
  service.request({}, "reuse", () => {});
  expect(ports).toHaveLength(3);
  ports[2]!.succeed();
  service.dispose();
  expect(ports[2]!.terminate).toHaveBeenCalledOnce();
});

it("replaces an active owner, ignores its old cancel and wrong result IDs", async () => {
  const owner = {}, receive = vi.fn();
  const oldCancel = service.request(owner, "old", receive);
  service.request(owner, "new", receive);
  await microtask();
  oldCancel();
  ports[1]!.succeed(ports[0]!.id);
  expect(receive).not.toHaveBeenCalled();
  ports[1]!.succeed();
  expect(receive).toHaveBeenCalledOnce();
  expect(ports[0]!.terminate).toHaveBeenCalledOnce();
});

it.each(["constructor", "post", "error", "messageerror"])(
  "disables startup/transport failures until disposal: %s", (fault) => {
    const create = vi.fn(() => {
      if (fault === "constructor") throw Error("blocked");
      const p = makePort();
      if (fault === "post") p.postMessage = () => { throw Error("clone"); };
      return p;
    });
    service.dispose(); service = new MarkdownWorker(create);
    const receive = vi.fn();
    service.request({}, "first", receive);
    service.request({}, "second", receive);
    const port = ports[0];
    if (fault === "error") port!.onerror!.call(port as unknown as Worker, {} as ErrorEvent);
    if (fault === "messageerror") port!.onmessageerror!.call(port as unknown as Worker, {} as MessageEvent);
    service.request({}, "third", receive);
    expect(receive.mock.calls.map(([r]) => r)).toEqual(Array(3).fill({ kind: "plain", reason: "unavailable" }));
    expect(create).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    if (port) expect(port.onmessage).toBeNull();
  },
);

it("releases a refused job and its timer before a fresh worker", () => {
  service.request({}, "deep", vi.fn());
  ports[0]!.start();
  ports[0]!.send({ id: ports[0]!.id, kind: "plain", reason: "depth" });
  expect(ports[0]!.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  service.request({}, "normal", vi.fn());
  ports[1]!.succeed();
});

it("applies backlog results together 50 ms after the first, in order; idle at once", () => {
  const applied: string[] = [];
  for (const t of ["a", "b", "c"]) service.request({}, t, () => applied.push(t));
  ports[0]!.succeed();
  vi.advanceTimersByTime(20);
  ports[0]!.succeed();
  vi.advanceTimersByTime(29);
  expect(applied).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(applied).toEqual(["a", "b"]);
  ports[0]!.succeed();
  expect(applied).toEqual(["a", "b", "c"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("re-arms the window for a result settled after it fires", () => {
  const applied: string[] = [];
  for (const t of ["a", "b", "c"]) service.request({}, t, () => applied.push(t));
  ports[0]!.succeed();
  vi.advanceTimersByTime(50);
  expect(applied).toEqual(["a"]);
  ports[0]!.succeed();
  vi.advanceTimersByTime(49);
  expect(applied).toEqual(["a"]);
  vi.advanceTimersByTime(1);
  expect(applied).toEqual(["a", "b"]);
});

it("drops cancelled and replaced ready results and still applies others", () => {
  const a = {}, b = {}, applied: string[] = [];
  const cancelA = service.request(a, "a", () => applied.push("a"));
  service.request(b, "b", () => applied.push("b"));
  service.request({}, "c", () => applied.push("c"));
  ports[0]!.succeed();
  ports[0]!.succeed();
  cancelA();
  service.request(b, "new-b", () => applied.push("new-b"));
  vi.advanceTimersByTime(50);
  expect(applied).toEqual([]);
  ports[0]!.succeed();
  vi.advanceTimersByTime(50);
  ports[0]!.succeed();
  expect(applied).toEqual(["c", "new-b"]);
});

it("applies nothing settled before disposal", () => {
  const receive = vi.fn();
  service.request({}, "a", receive);
  service.request({}, "b", receive);
  ports[0]!.succeed();
  service.dispose();
  expect(vi.getTimerCount()).toBe(0);
  service.request({}, "late", receive);
  vi.advanceTimersByTime(100);
  expect(receive.mock.calls).toEqual([[{ kind: "plain", reason: "unavailable" }]]);
});

it("starts one worker per task after owners terminate the active job", async () => {
  const applied: string[] = [];
  const cancels = ["t0", "t1", "t2", "t3"].map((t) =>
    service.request({}, t, () => applied.push(t)));
  for (const cancel of cancels) cancel();
  const late = {};
  service.request(late, "late", () => applied.push("late"));
  expect(ports).toHaveLength(1);
  expect(ports[0]!.terminate).toHaveBeenCalledOnce();
  await microtask();
  expect(ports).toHaveLength(2);
  expect(ports[1]!.postMessage.mock.lastCall?.[0].text).toBe("late");
  for (const t of ["r1", "r2", "r3"]) service.request(late, t, () => applied.push(t));
  expect(ports).toHaveLength(2);
  await microtask();
  expect(ports).toHaveLength(3);
  expect(ports[2]!.postMessage.mock.lastCall?.[0].text).toBe("r3");
  ports[2]!.succeed();
  expect(applied).toEqual(["r3"]);
});

it("runs the actual handler and depth boundary without a DOM", () => {
  const send = vi.fn();
  handleLexRequest({ id: 7, text: "> ".repeat(32) + "ok" }, send);
  expect(send.mock.calls[0]![0]).toEqual({ id: 7, kind: "started" });
  expect(send.mock.calls[1]![0].kind).toBe("tokens");
  expect(lexMarkdown("> ".repeat(33) + "ok")).toEqual({ kind: "plain", reason: "depth" });
  expect(lexMarkdown(">".repeat(100000))).toEqual({ kind: "plain", reason: "lexer" });
});
