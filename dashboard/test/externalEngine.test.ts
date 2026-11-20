import "./isolation.setup";
import { describe, expect, it, vi } from "vitest";
import { externalCatalog, modelsFrom, parseHosts, type Envelope } from "../src/lib/protocol";
import { SessionEnumeration } from "../src/lib/sessionEnumeration";

const flags = ["spawn", "resume", "enumerate_sessions", "refresh_engine_catalog"] as const;
const ids = ["sample-engine", "sample-twin"];
const row = (id: string, operations: unknown) => ({ id, operations, models: [] });
function host(engines: unknown[], capabilities = ids) {
  return parseHosts({ h: { engines, capabilities, personas: [], cwd_allowlist: [] } })[0]!;
}

describe("external host operations", () => {
  it.each(Array.from({ length: 16 }, (_, i) => i))("reads only declared flags (%i)", bits => {
    const ops = { version: 1, ...Object.fromEntries(flags.map((flag, i) =>
      [flag, Boolean(bits & (1 << i))])) };
    const h = host(ids.map(id => row(id, ops)));
    for (const id of ids) expect(externalCatalog(h, id)?.operations).toEqual(ops);
  });

  it("rejects ambiguous rows, malformed selections, reserved IDs and foreign capabilities", () => {
    const ops = { version: 1, spawn: true };
    const [id, other] = ids as [string, string];
    const good = row(id, ops), bad = { ...good, models: null };
    for (const rows of [[good, bad], [bad, good], [good, good], [],
      [row(id, { version: 2 })], [row(id, { ...ops, resume: 1 })],
      [{ ...good, models: [{ value: "m", display_name: "M", effort_levels: [] }] }]]) {
      const h = host([...rows, row(other, ops)]);
      expect(externalCatalog(h, id)).toBeUndefined();
      expect(externalCatalog(h, other)?.operations?.spawn).toBe(true);
    }
    expect(externalCatalog(host([good], [other]), id)).toBeUndefined();
    for (const reserved of ["claude-code", "codex", "antigravity", "grok", "claude"]) {
      const h = host([row(reserved, ops)], [reserved]);
      expect(h.capabilities).toEqual([reserved]);
      expect(externalCatalog(h, reserved)).toBeUndefined();
    }
  });

  it("removes ambiguous live models and invalid effort lists before rendering", () => {
    const models = ["m", "", "m", "a", "b"].map(value => ({
      value, display_name: value, effort_levels: value === "a" ? ["one", "one"] : [1, "two"],
    }));
    expect(modelsFrom({ ext: { models } } as unknown as Envelope, true)).toEqual([
      { value: "a", display_name: "a", effort_levels: ["one"] },
      { value: "b", display_name: "b", effort_levels: [] },
    ]);
  });
});

it.each([true, false])("waits for both list and ack (list first: %s)", async listFirst => {
  const lists = new SessionEnumeration();
  let ack!: () => void;
  const send = vi.fn(() => new Promise<void>(resolve => { ack = resolve; }));
  const list = { host_id: "h", engine: "sample", cwd: "/a", sessions: [] };
  const completed = vi.fn();
  const result = lists.read("h", "sample", "/a", send, "retry").then(completed);
  for (const other of [{ cwd: "/b" }, { engine: "other" }, { host_id: "other" }]) {
    lists.receive({ ...list, ...other });
  }
  if (listFirst) lists.receive(list); else ack();
  await expect(lists.read("h", "sample", undefined, send, "retry")).rejects.toThrow("retry");
  expect(completed).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  if (listFirst) ack(); else lists.receive(list);
  await result;
  expect(completed).toHaveBeenCalledWith(list);
  const old = lists.read("h", "sample", undefined, send, "retry");
  lists.reset();
  await expect(old).rejects.toThrow("retry");
});
