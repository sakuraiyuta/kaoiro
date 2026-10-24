import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clipText, type WrapperConfig } from "@kaoiro/agent-common";
import {
  groupName,
  MAX_HISTORY,
  readGrokHistory,
  reconstructHistory,
  sessionDirectory,
} from "../src/history.js";

const config: WrapperConfig = {
  agent_id: "history-fixture", display_name: "History", server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
};
const SESSION = "01a13d7c-dd1a-7b73-ac7e-9555c05fbf62";
const T0 = 1_760_000_000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const line = (update: Record<string, unknown>, timestamp: unknown = T0, method = "session/update") =>
  JSON.stringify({ method, params: { sessionId: SESSION, update }, timestamp });
const user = (text: unknown, promptIndex?: number, t: unknown = T0) =>
  line({ sessionUpdate: "user_message_chunk", content: { type: "text", text },
    ...(promptIndex === undefined ? {} : { _meta: { promptIndex, modelId: "m" } }) }, t);
const assistant = (text: unknown, t: unknown = T0) =>
  line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, t);
const NO_INPUT = Symbol("no rawInput");
const toolCall = (id: unknown, title: unknown = "probe", rawInput: unknown = { value: 7 }, t: unknown = T0) =>
  line({ sessionUpdate: "tool_call", toolCallId: id, title, ...(rawInput === NO_INPUT ? {} : { rawInput }),
    _meta: { "x.ai/tool": { name: "n", namespace: "ns", kind: "execute" } } }, t);
const toolDone = (id: unknown, text: unknown = "result", status: unknown = "completed", t: unknown = T0) =>
  line({ sessionUpdate: "tool_call_update", toolCallId: id, status,
    content: [{ type: "content", content: { type: "text", text } }] }, t);
const toolProgress = (id: string) =>
  line({ sessionUpdate: "tool_call_update", toolCallId: id, title: "probe", rawInput: {},
    content: [{ type: "content", content: { type: "text", text: "partial" } }] });
const vendor = (variant = "hook_execution") =>
  line({ sessionUpdate: variant, runs: [] }, T0, "_x.ai/session/update");

const run = (lines: string[]) => reconstructHistory(lines, config, SESSION);
const payloads = (lines: string[]) => run(lines).envelopes.map((e) => e.payload);

describe("normalization", () => {
  it("rebuilds a tool-call turn in order with ids, input and result", () => {
    const result = run([
      user("do it", 0, T0), toolCall("c1", "probe", { value: 7 }, T0 + 1), toolProgress("c1"),
      toolDone("c1", "output", "completed", T0 + 2), assistant("do", T0 + 3), assistant("ne", T0 + 4),
    ]);
    expect(result.envelopes.map((e) => e.payload)).toEqual([
      { kind: "user", text: "do it" },
      { kind: "tool_use", tool_name: "probe", tool_use_id: "c1", input: { value: 7 } },
      { kind: "tool_result", output: "output", tool_use_id: "c1", tool_name: "probe" },
      { kind: "assistant", text: "done" },
    ]);
    expect(result.envelopes.map((e) => e.ts)).toEqual([iso(T0), iso(T0 + 1), iso(T0 + 2), iso(T0 + 3)]);
    expect(result.envelopes.every((e) => e.type === "log" && e.state === "idle" && e.session_id === SESSION)).toBe(true);
    expect(result.skipped).toEqual({});
  });

  it("converts integer epoch seconds to ISO time and never to milliseconds", () => {
    expect(run([assistant("x", 1_700_000_000)]).envelopes[0]!.ts).toBe("2023-11-14T22:13:20.000Z");
  });

  it("joins chunks of one message, keeping the time of the first", () => {
    const result = run([assistant("a", T0), assistant("b", T0 + 5), assistant("c", T0 + 9)]);
    expect(result.envelopes.map((e) => [e.ts, e.payload])).toEqual([[iso(T0), { kind: "assistant", text: "abc" }]]);
  });

  it("splits user messages by prompt index and joins chunks of the same index", () => {
    expect(payloads([user("a", 0), user("b", 0), user("c", 1)])).toEqual([
      { kind: "user", text: "ab" }, { kind: "user", text: "c" },
    ]);
  });

  it("does not end a join on a skipped line", () => {
    expect(payloads([
      assistant("a"), line({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "t" } }),
      vendor(), "not json", toolProgress("x"), assistant("b"),
    ])).toEqual([{ kind: "assistant", text: "ab" }]);
  });

  it("ends a join on a recognized record of another kind", () => {
    expect(payloads([assistant("a"), user("u", 0), assistant("b")])).toEqual([
      { kind: "assistant", text: "a" }, { kind: "user", text: "u" }, { kind: "assistant", text: "b" },
    ]);
  });

  it("defaults a missing rawInput to an empty object and drops an oversized input", () => {
    expect(payloads([toolCall("c1", "probe", NO_INPUT)])).toEqual([
      { kind: "tool_use", tool_name: "probe", tool_use_id: "c1", input: {} },
    ]);
    expect(payloads([toolCall("c1", "probe", { big: "x".repeat(20_000) })])).toEqual([
      { kind: "tool_use", tool_name: "probe", tool_use_id: "c1", truncated: true },
    ]);
  });

  it("maps a failed update, joins its text items and keeps an empty result", () => {
    const joined = line({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", content: [
      { type: "content", content: { type: "text", text: "one" } },
      { type: "content", content: { type: "image", data: "" } },
      { type: "content", content: { type: "text", text: "two" } },
      "junk",
    ] });
    const empty = line({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed" });
    expect(payloads([toolCall("c1"), joined, empty])).toEqual([
      { kind: "tool_use", tool_name: "probe", tool_use_id: "c1", input: { value: 7 } },
      { kind: "tool_result", output: "one\ntwo", tool_use_id: "c1", tool_name: "probe" },
      { kind: "tool_result", output: "", tool_use_id: "c2" },
    ]);
  });

  it("skips an inter-agent turn that the structured envelope already shows", () => {
    const framed = '[Inter-agent message — to reply, call send_to_agent with conversation_id="c"]\nbody';
    expect(payloads([user(framed, 0), assistant("reply")])).toEqual([{ kind: "assistant", text: "reply" }]);
  });

  it("keeps only the newest entries", () => {
    const lines = Array.from({ length: MAX_HISTORY + 50 }, (_, i) => [user(`u${i}`, i), assistant(`a${i}`)]).flat();
    const result = run(lines);
    expect(result.envelopes).toHaveLength(MAX_HISTORY);
    expect(result.envelopes.at(-1)!.payload).toEqual({ kind: "assistant", text: `a${MAX_HISTORY + 49}` });
  });
});

describe("what is skipped", () => {
  it.each([
    ["a string timestamp", assistant("x", "1760000000")],
    ["a float timestamp", assistant("x", 1_760_000_000.5)],
    ["a millisecond timestamp", assistant("x", 1_760_000_000_000)],
    ["a negative timestamp", assistant("x", -5)],
    ["a missing timestamp", JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "x" } } } })],
  ])("skips a line with %s and counts it", (_name, text) => {
    const result = run([text]);
    expect(result.envelopes).toEqual([]);
    expect(result.skipped).toEqual({ bad_timestamp: 1 });
  });

  it.each([
    ["text that is not a string", user(42)],
    ["a non-text chunk", line({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "" } })],
  ])("counts %s as an invalid chunk", (_name, text) => {
    expect(run([text])).toEqual({ envelopes: [], skipped: { invalid_chunk: 1 } });
  });

  it.each([
    ["a numeric tool call id", toolCall(7)],
    ["an empty tool call id", toolCall("")],
    ["a title that is not a string", toolCall("c1", 5)],
    ["a rawInput array", toolCall("c1", "probe", [1])],
    ["a null rawInput", toolCall("c1", "probe", null)],
    ["a scalar rawInput", toolCall("c1", "probe", "text")],
    ["a final update without an id", toolDone(undefined)],
  ])("counts %s as an invalid tool record", (_name, text) => {
    expect(run([text])).toEqual({ envelopes: [], skipped: { invalid_tool: 1 } });
  });

  it("counts invalid JSON and wrong shapes, and ignores Grok's own records and other methods", () => {
    const result = run([
      "{not json", "[]", "null", JSON.stringify({ method: 3, params: {} }), JSON.stringify({ method: "session/update" }),
      line({ sessionUpdate: 5 }), line({}), JSON.stringify({ method: "session/update", params: { update: 7 }, timestamp: T0 }),
      vendor("turn_completed"), vendor(), line({ sessionUpdate: "agent_message_chunk" }, T0, "session/other"),
      line({ sessionUpdate: "future_variant", content: "x" }), line({ sessionUpdate: "available_commands_update" }),
      line({ sessionUpdate: "session_info_update" }),
    ]);
    expect(result.envelopes).toEqual([]);
    expect(result.skipped).toEqual({ invalid_json: 1, invalid_shape: 7 });
  });

  it("ignores a Grok record even when it has the shape of a chunk", () => {
    const disguised = line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FROM_VENDOR" } },
      T0, "_x.ai/session/update");
    expect(run([assistant("a"), disguised]).skipped).toEqual({});
    expect(payloads([assistant("a"), disguised])).toEqual([{ kind: "assistant", text: "a" }]);
  });

  it("keeps the entries before and after a bad line", () => {
    expect(payloads([user("u", 0), "garbage{", assistant("a")])).toEqual([
      { kind: "user", text: "u" }, { kind: "assistant", text: "a" },
    ]);
  });

  it("bounds a join of very many chunks", () => {
    const chunk = "x".repeat(10_000);
    const result = run(Array.from({ length: 200 }, () => assistant(chunk)));
    expect(result.envelopes).toHaveLength(1);
    expect(result.envelopes[0]!.payload).toEqual({ kind: "assistant", text: "x".repeat(16 * 1024), truncated: true });
  });

  it("never builds a string past the join bound, however many chunks follow", () => {
    // 600 lines of about 1 MB would be 600 MB joined, past V8's string limit,
    // so an unbounded join fails where the bounded one stays at 16 KiB.
    function* chunks() {
      for (let i = 0; i < 600; i += 1) yield assistant("x".repeat(999_000));
    }
    const result = reconstructHistory(chunks(), config, SESSION);
    expect(result.skipped).toEqual({});
    expect(result.envelopes.map((e) => e.payload)).toEqual([
      { kind: "assistant", text: "x".repeat(16 * 1024), truncated: true },
    ]);
  }, 60_000);

  describe.each([
    ["assistant", (text: string, t = T0) => assistant(text, t)],
    ["user", (text: string, t = T0) => user(text, 0, t)],
  ] as const)("a %s message past the bound", (kind, chunk) => {
    const entry = (text: string, truncated: boolean) =>
      ({ kind, text, ...(truncated ? { truncated: true } : {}) });
    const body = "\u{1F600}".repeat(5000);
    const clipped = "\u{1F600}".repeat(4096);
    // Three UTF-16 units per chunk cuts every other surrogate pair in two.
    const split = (text: string) => Array.from({ length: Math.ceil(text.length / 3) },
      (_, i) => chunk(text.slice(i * 3, i * 3 + 3)));

    it("is clipped to the same 16 KiB whether or not a chunk splits a surrogate pair", () => {
      expect(payloads([chunk(body)])).toEqual([entry(clipped, true)]);
      expect(payloads(split(body))).toEqual([entry(clipped, true)]);
    });

    it("keeps a message of exactly 16 KiB whole, however it is chunked", () => {
      expect(payloads(split("\u{1F600}".repeat(4096)))).toEqual([entry(clipped, false)]);
    });

    it("says it left text out when more text follows a full join", () => {
      expect(payloads([chunk("x".repeat(16 * 1024)), chunk("y")])).toEqual([entry("x".repeat(16 * 1024), true)]);
      expect(payloads([chunk("x".repeat(16 * 1024)), chunk("")])).toEqual([entry("x".repeat(16 * 1024), false)]);
    });

    it("clips like the live path when a full join ends in half a surrogate pair (issue #653)", () => {
      const first = `${"x".repeat(16381)}\ud83d`;
      const live = clipText(`${first}\ude00y`);
      expect(live).toEqual({ text: "x".repeat(16381), truncated: true });
      expect(payloads([chunk(first), chunk("\ude00y")])).toEqual([entry(live.text, true)]);
    });
  });

  it("clips a long user message the way the live path does", () => {
    expect(payloads([user("y".repeat(20_000), 0)])).toEqual([
      { kind: "user", text: "y".repeat(16 * 1024), truncated: true },
    ]);
  });
});

describe("the file and its directory", () => {
  const scratch: string[] = [];
  afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function grokHome() {
    const home = mkdtempSync(join(tmpdir(), "kaoiro-grok-history-"));
    scratch.push(home);
    return home;
  }
  function put(home: string, group: string, content: string, id = SESSION) {
    const dir = join(home, "sessions", group, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "updates.jsonl"), content);
    return dir;
  }
  const cwd = "/work/project";
  const env = (home: string) => ({ GROK_HOME: home });
  const text = (...lines: string[]) => lines.join("\n") + "\n";

  it("reads GROK_HOME's session under the URL-encoded cwd", () => {
    const home = grokHome();
    put(home, "%2Fwork%2Fproject", text(user("hi", 0), assistant("yo")));
    expect(readGrokHistory(cwd, SESSION, config, env(home)).map((e) => e.payload)).toEqual([
      { kind: "user", text: "hi" }, { kind: "assistant", text: "yo" },
    ]);
  });

  it("falls back to the home directory when GROK_HOME is unset", () => {
    const home = grokHome();
    put(join(home, ".grok"), "%2Fwork%2Fproject", text(assistant("yo")));
    expect(readGrokHistory(cwd, SESSION, config, { HOME: home }).map((e) => e.payload)).toEqual([
      { kind: "assistant", text: "yo" },
    ]);
  });

  it.each([
    ["a space", "/work/my project", "%2Fwork%2Fmy%20project"],
    ["parentheses and a quote", "/work/it's (x)", "%2Fwork%2Fit%27s%20%28x%29"],
    ["a bang and a star", "/work/a!b*c", "%2Fwork%2Fa%21b%2Ac"],
    ["a tilde and a dot", "/work/~me/.cache", "%2Fwork%2F~me%2F.cache"],
    ["non-ASCII text", "/work/日本", "%2Fwork%2F%E6%97%A5%E6%9C%AC"],
  ])("names the group with Grok's own encoding for %s", (_name, directory, expected) => {
    expect(groupName(directory)).toBe(expected);
    const home = grokHome();
    put(home, expected, text(assistant("found")));
    expect(readGrokHistory(directory, SESSION, config, env(home))).toHaveLength(1);
  });

  it("finds a long cwd's slug group through its .cwd file, matched exactly", () => {
    const home = grokHome();
    const long = "/" + Array.from({ length: 8 }, (_, i) => `${"d".repeat(40)}${i}`).join("/");
    expect(Buffer.byteLength(groupName(long))).toBeGreaterThan(255);
    const dir = put(home, "0f1e2d3c4b5a6978-8796a5b4c3d2e1f0", text(assistant("slug")));
    writeFileSync(join(dir, "..", ".cwd"), long);
    const unrelated = put(home, "ffffffffffffffff-eeeeeeeeeeeeeeee", text(assistant("other")));
    writeFileSync(join(unrelated, "..", ".cwd"), "/some/other/cwd");
    expect(readGrokHistory(long, SESSION, config, env(home)).map((e) => e.payload)).toEqual([
      { kind: "assistant", text: "slug" },
    ]);
    expect(readGrokHistory(long + "x", SESSION, config, env(home))).toEqual([]);
  });

  it("does not match a .cwd file that differs by a trailing newline", () => {
    const home = grokHome();
    const dir = put(home, "0f1e2d3c4b5a6978-8796a5b4c3d2e1f0", text(assistant("slug")));
    writeFileSync(join(dir, "..", ".cwd"), "/work/slug\n");
    expect(readGrokHistory("/work/slug", SESSION, config, env(home))).toEqual([]);
  });

  it("gives [] for a missing file, a missing session, an unsafe id and an unreadable home", () => {
    const home = grokHome();
    mkdirSync(join(home, "sessions", "%2Fwork%2Fproject", SESSION), { recursive: true });
    expect(readGrokHistory(cwd, SESSION, config, env(home))).toEqual([]);
    expect(readGrokHistory(cwd, "02222222-2222-7222-8222-222222222222", config, env(home))).toEqual([]);
    // A real directory outside the group, reachable only through a hostile id.
    put(home, "secret-group", text(assistant("SECRET")), "secret-session");
    for (const id of ["../secret-group/secret-session", "../x", "a/b", "", "a".repeat(129), "has.dot"]) {
      expect(sessionDirectory(cwd, id, env(home))).toBeUndefined();
    }
    expect(readGrokHistory(cwd, "../secret-group/secret-session", config, env(home))).toEqual([]);
    expect(readGrokHistory(cwd, SESSION, config, env(join(home, "absent")))).toEqual([]);
  });

  it("refuses a cwd that is not absolute, whose group name would leave the sessions directory", () => {
    const home = grokHome();
    // `<home>/<id>/updates.jsonl` is what a cwd of ".." would reach.
    const outside = join(home, SESSION);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "updates.jsonl"), text(assistant("OUTSIDE")));
    mkdirSync(join(home, "sessions"), { recursive: true });
    for (const bad of ["..", ".", "", "relative/dir", "../escape"]) {
      expect(sessionDirectory(bad, SESSION, env(home)), bad).toBeUndefined();
      expect(readGrokHistory(bad, SESSION, config, env(home)), bad).toEqual([]);
    }
  });

  it("does not leave the sessions directory through a hostile cwd", () => {
    const home = grokHome();
    put(home, "%2Fwork%2Fproject", text(assistant("x")));
    expect(readGrokHistory("/work/project/../../etc", SESSION, config, env(home))).toEqual([]);
  });

  it("keeps the prefix of a file that ends in garbage", () => {
    const home = grokHome();
    put(home, "%2Fwork%2Fproject", text(user("u", 0), assistant("a")) + "{\"method\":\"session/up");
    const stderr = vi.spyOn(process.stderr, "write");
    expect(readGrokHistory(cwd, SESSION, config, env(home)).map((e) => e.payload)).toEqual([
      { kind: "user", text: "u" }, { kind: "assistant", text: "a" },
    ]);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("skipped lines: invalid_json=1");
    stderr.mockRestore();
  });

  it("skips a line over 1 MiB and counts it, without its content on stderr", () => {
    const home = grokHome();
    const huge = assistant("SECRET_BODY_MARKER" + "z".repeat(1024 * 1024 + 10));
    put(home, "%2Fwork%2Fproject", text(user("u", 0), huge, assistant("a")));
    const stderr = vi.spyOn(process.stderr, "write");
    expect(readGrokHistory(cwd, SESSION, config, env(home)).map((e) => e.payload)).toEqual([
      { kind: "user", text: "u" }, { kind: "assistant", text: "a" },
    ]);
    const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(written).toContain("oversize_line=1");
    expect(written).not.toContain("SECRET_BODY_MARKER");
    stderr.mockRestore();
  });

  it("reads only the last 8 MiB and starts at a line boundary", () => {
    const home = grokHome();
    const filler = assistant("f".repeat(900_000));
    const old = Array.from({ length: 12 }, () => filler);
    const content = text(user("OLDEST", 0), ...old, user("NEWEST", 1), assistant("tail"));
    expect(Buffer.byteLength(content)).toBeGreaterThan(8 * 1024 * 1024);
    put(home, "%2Fwork%2Fproject", content);
    const stderr = vi.spyOn(process.stderr, "write");
    const texts = readGrokHistory(cwd, SESSION, config, env(home)).map((e) => JSON.stringify(e.payload));
    expect(texts.some((t) => t.includes("OLDEST"))).toBe(false);
    expect(texts.some((t) => t.includes("NEWEST"))).toBe(true);
    // The cut falls inside a line; that partial line must not be counted as damage.
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain("skipped lines");
    stderr.mockRestore();
  });

  it("keeps the first line of the window when it starts exactly on a boundary", () => {
    const home = grokHome();
    const dropped = assistant("A");
    const kept = assistant("SECOND");
    const base = JSON.stringify({ method: "_x.ai/session/update", params: { pad: "" }, timestamp: T0 });
    const vendorLine = (bytes: number) => base.replace('"pad":""', `"pad":"${"p".repeat(bytes - base.length)}"`);
    // The file is 8 MiB plus the first line, so the window begins at the second line.
    let remaining = 8 * 1024 * 1024 - (Buffer.byteLength(kept) + 1);
    const filler: string[] = [];
    while (remaining > 900_000 + 1 + 200) { filler.push(vendorLine(900_000)); remaining -= 900_001; }
    filler.push(vendorLine(remaining - 1));
    const content = text(dropped, kept, ...filler);
    expect(Buffer.byteLength(content)).toBe(8 * 1024 * 1024 + Buffer.byteLength(dropped) + 1);
    put(home, "%2Fwork%2Fproject", content);
    const texts = readGrokHistory(cwd, SESSION, config, env(home)).map((e) => JSON.stringify(e.payload));
    expect(texts).toEqual(['{"kind":"assistant","text":"SECOND"}']);
  });
});
