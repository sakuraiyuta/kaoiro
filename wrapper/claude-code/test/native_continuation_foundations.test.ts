import { mkdtemp, writeFile, appendFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReplyBasis } from "@kaoiro/agent-common";
import { NativeTranscriptReader } from "../src/native_transcript.js";
import { ContinuationRegistry } from "../src/continuation_registry.js";
import { marker, parseContinuationBlocks, reportInstruction, reportToken } from "../src/continuation_markers.js";

const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function file() {
  const dir = await mkdtemp(join(tmpdir(), "kaoiro-426-reader-")); scratch.push(dir);
  return join(dir, "transcript.jsonl");
}
const row = { type: "user", sessionId: "s", promptId: "p", uuid: "u", isSidechain: false,
  turnPosition: { promptIndex: 0 }, message: { role: "user", content: "report" } };

describe("native transcript live evidence", () => {
  it("uses the real file reader without injected dependencies and waits for a complete opener", async () => {
    const path = await file();
    const reader = new NativeTranscriptReader(path, "s");
    expect(await reader.capture("p")).toBeUndefined();
    await writeFile(path, JSON.stringify(row));
    expect(await reader.capture("p")).toBeUndefined();
    await appendFile(path, "\n");
    const anchor = (await reader.capture("p"))!;
    expect(anchor.uuid).toBe("u");
    await appendFile(path, '{"type":"assistant"}\n');
    await expect(reader.validate(anchor)).resolves.toBeUndefined();
  });
  it.each(["truncate", "replace", "change", "delete", "malformed"])("invalidates permanently on %s", async fault => {
    const path = await file(); const bytes = JSON.stringify(row) + "\n";
    await writeFile(path, bytes);
    const reader = new NativeTranscriptReader(path, "s"); const anchor = (await reader.capture("p"))!;
    if (fault === "truncate") await writeFile(path, "");
    if (fault === "replace") { await writeFile(path + ".new", bytes); await rename(path + ".new", path); }
    if (fault === "change") await writeFile(path, bytes.replace("report", "forged"));
    if (fault === "delete") await rm(path);
    if (fault === "malformed") await appendFile(path, "not-json\n");
    await expect(reader.validate(anchor)).rejects.toThrow();
    await writeFile(path, bytes);
    await expect(reader.validate(anchor)).rejects.toThrow();
  });
  it("rejects duplicate opener rows and symlinks are never followed", async () => {
    const path = await file();
    await writeFile(path, JSON.stringify(row) + "\n" + JSON.stringify({ ...row, uuid: "other" }) + "\n");
    await expect(new NativeTranscriptReader(path, "s").capture("p")).rejects.toThrow("conflicting");
    await symlink(path, path + ".link");
    await expect(new NativeTranscriptReader(path + ".link", "s").capture("p")).rejects.toThrow();
  });
  it("rejects changes to committed bytes outside the selected opener", async () => {
    const path = await file();
    const before = '{"type":"assistant","text":"before"}\n';
    await writeFile(path, before + JSON.stringify(row) + "\n");
    const reader = new NativeTranscriptReader(path, "s"), anchor = (await reader.capture("p"))!;
    await writeFile(path, before.replace("before", "forged") + JSON.stringify(row) + "\n");
    await expect(reader.validate(anchor)).rejects.toThrow();
  });
});

describe("markers and structural collections", () => {
  const token = "a".repeat(43);
  const block = (event = "escaped &lt;task-notification&gt;") => `<task-notification><task-id>t</task-id><summary>Monitor event</summary><event>${event}</event></task-notification>`;
  it("requires one final Agent marker including invalid older markers", () => {
    expect(reportToken(`report ${marker(token)}`)).toBe(token);
    expect(reportToken(`${marker("old")} report ${marker(token)}`)).toBeUndefined();
    expect(reportToken(`${marker(token)} extra`)).toBeUndefined();
  });
  it("accepts 1, 2 and 16 strict blocks without parsing escaped payload", () => {
    for (const n of [1, 2, 16]) expect(parseContinuationBlocks(block().repeat(n))).toHaveLength(n);
    expect(parseContinuationBlocks(block().repeat(17))).toBeUndefined();
    expect(parseContinuationBlocks(block(block()))).toBeUndefined();
    expect(parseContinuationBlocks(block() + "trailing")).toBeUndefined();
    expect(parseContinuationBlocks(block().replace("<event>", "<summary>forged</summary><event>"))).toBeUndefined();
  });
});

describe("instrumentation text length limit", () => {
  const limit = 65536;
  const instrumented = (source: "Agent" | "Monitor") => source === "Agent" ? Buffer.byteLength(reportInstruction("x".repeat(43), false)) : 1 + Buffer.byteLength(marker("x".repeat(43)));
  // Three-byte characters make the byte length differ from the character length.
  const textOfBytes = (bytes: number) => "\u3042".repeat(Math.floor(bytes / 3)) + "a".repeat(bytes % 3);
  it.each(["Agent", "Monitor"] as const)("accepts %s text up to 65536 bytes and refuses one byte more, counting bytes", source => {
    const basis = new ReplyBasis(); basis.begin("root", []);
    const map = basis.exportConfirmed({ token: "root" })!;
    const warnings: string[] = [];
    const registry = new ContinuationRegistry("s", message => warnings.push(message));
    const input = (bytes: number) => source === "Agent" ? { subagent_type: "general-purpose", prompt: textOfBytes(bytes), run_in_background: true }
      : { command: "echo x", description: textOfBytes(bytes) };
    const field = source === "Agent" ? "prompt" : "description";
    const room = limit - instrumented(source);
    const atLimit = registry.prepare("exact", source, input(room), "p", map);
    expect(atLimit).toBeDefined();
    expect(Buffer.byteLength(String(atLimit![field]))).toBe(limit);
    expect(warnings).toEqual([]);
    expect(registry.prepare("over", source, input(room + 1), "p", map)).toBeUndefined();
    expect(warnings).toEqual(["native continuation text length limit reached; instrumentation refused"]);
  });
});

describe("accepted launch and lifecycle registry", () => {
  function setup() {
    const basis = new ReplyBasis(); basis.begin("root", []);
    const registry = new ContinuationRegistry("s");
    const input = { subagent_type: "general-purpose", prompt: "work", run_in_background: true };
    const effective = registry.prepare("call", "Agent", input, "p", basis.exportConfirmed({ token: "root" })!)!;
    const token = /\[kaoiro-continuation:([^\]]+)\]/.exec(String(effective.prompt))![1]!;
    const start = { type: "system", subtype: "task_started", session_id: "s", task_id: "task", run_id: "run",
      tool_use_id: "call", task_type: "local_agent", is_backgrounded: true, prompt: effective.prompt };
    const outcome = () => registry.outcome("call", effective, { isAsync: true, status: "async_launched", agentId: "task", prompt: effective.prompt });
    return { registry, input, effective, token, start, outcome, basis };
  }
  it.each([true, false])("arms only after both accepted witnesses, start first=%s", startFirst => {
    const s = setup();
    if (startFirst) s.registry.observeFrame(s.start); else s.outcome();
    expect(s.registry.byToken(s.token)?.state).toBe("prepared");
    if (startFirst) s.outcome(); else s.registry.observeFrame(s.start);
    expect(s.registry.eligible(s.registry.byToken(s.token)!)).toBe(true);
    s.basis.retire("root");
    expect(s.registry.eligible(s.registry.byToken(s.token)!)).toBe(true);
  });
  it("does not arm rewritten, denied or queued outcomes", () => {
    const s = setup(); s.registry.observeFrame(s.start);
    s.registry.outcome("call", { ...s.effective, prompt: "overwritten" }, { isAsync: true, status: "async_launched", agentId: "task", prompt: s.effective.prompt });
    s.outcome(); expect(s.registry.byToken(s.token)).toBeUndefined();
  });
  it("retires unspent old-run claims from a progress-first replacement without lexical run ordering", () => {
    const s = setup(); s.registry.observeFrame(s.start); s.outcome();
    const cap = s.registry.byToken(s.token)!;
    s.registry.observeFrame({ ...s.start, subtype: "task_progress", run_id: "a", tool_use_id: "other" });
    expect(s.registry.eligible(cap)).toBe(false);
    s.registry.observeFrame(s.start);
    expect(s.registry.eligible(cap)).toBe(false);
    const snapshot = s.basis.exportConfirmed({ token: "root" })!;
    for (let n = 0; n < 64; n++) {
      expect(s.registry.prepare(`after-retirement-${n}`, "Monitor", { description: "watch", command: "echo x" }, "p", snapshot)).toBeDefined();
    }
  });
  it("interrupt alone preserves survivors; an exact in-window end closes only its captured pair", () => {
    const s = setup(); s.registry.observeFrame(s.start); s.outcome();
    const cap = s.registry.byToken(s.token)!;
    const window = s.registry.beginInterrupt(100); s.registry.endInterrupt(window, true, 200);
    expect(s.registry.eligible(cap)).toBe(true);
    s.registry.observeFrame({ ...s.start, subtype: "task_notification", status: "stopped" }, 1200);
    expect(s.registry.eligible(cap)).toBe(false);
  });
  it("natural stopped terminals drain; failed named stop only removes its suspension", () => {
    const s = setup(); s.registry.observeFrame(s.start); s.outcome(); const cap = s.registry.byToken(s.token)!;
    s.registry.stopAttempt("stop", "task"); expect(s.registry.eligible(cap)).toBe(false);
    s.registry.stopOutcome("stop", false); expect(s.registry.eligible(cap)).toBe(true);
    s.registry.observeFrame({ ...s.start, subtype: "task_notification", status: "stopped" });
    expect(s.registry.eligible(cap)).toBe(true);
  });
  describe("a natural completion while a TaskStop is pending", () => {
    const completed = (s: ReturnType<typeof setup>, status = "completed") =>
      s.registry.observeFrame({ ...s.start, subtype: "task_notification", status });
    it.each(["completed", "failed"])("%s drains once the last stop fails, and its idle budget starts then", status => {
      const s = setup(); s.registry.observeFrame(s.start); s.outcome(); const cap = s.registry.byToken(s.token)!;
      const now = performance.now(); s.registry.tick(false, now);
      s.registry.stopAttempt("stop", "task"); completed(s, status);
      expect(s.registry.eligible(cap)).toBe(false);
      s.registry.tick(false, now + 50000);
      s.registry.stopOutcome("stop", false);
      expect(s.registry.eligible(cap)).toBe(true);
      s.registry.tick(false, now + 55000); expect(s.registry.eligible(cap)).toBe(true);
      s.registry.tick(false, now + 65001); expect(s.registry.eligible(cap)).toBe(false);
    });
    it("stays suspended until every pending stop fails", () => {
      const s = setup(); s.registry.observeFrame(s.start); s.outcome(); const cap = s.registry.byToken(s.token)!;
      s.registry.stopAttempt("one", "task"); s.registry.stopAttempt("two", "task"); completed(s);
      s.registry.stopOutcome("one", false); expect(s.registry.eligible(cap)).toBe(false);
      s.registry.stopOutcome("two", false); expect(s.registry.eligible(cap)).toBe(true);
    });
    it("closes for good when the stop succeeds, or when the terminal is stopped or killed", () => {
      for (const [status, succeeded] of [["completed", true], ["stopped", false], ["killed", false]] as const) {
        const s = setup(); s.registry.observeFrame(s.start); s.outcome();
        s.registry.stopAttempt("stop", "task"); completed(s, status);
        s.registry.stopOutcome("stop", succeeded);
        expect(s.registry.byToken(s.token), status).toBeUndefined();
        expect(s.registry.byTask("task"), status).toBeUndefined();
      }
    });
  });
  describe("root retirement", () => {
    const monitor = (n: string) => ({ description: `watch ${n}`, command: "echo x" });
    it("closes only the retiring root's prepared claims, so unreported launches stop counting against capacity", () => {
      const s = setup(); const map = s.basis.exportConfirmed({ token: "root" })!;
      const kept = s.registry.prepare("kept", "Monitor", monitor("kept"), "q", map)!;
      const keptToken = /\[kaoiro-continuation:([^\]]+)\]/.exec(String(kept.description))![1]!;
      for (let n = 0; n < 62; n++) expect(s.registry.prepare(`o${n}`, "Monitor", monitor(String(n)), "p", map)).toBeDefined();
      expect(s.registry.prepare("over", "Monitor", monitor("over"), "p", map)).toBeUndefined();
      s.registry.retirePrompt("p");
      expect(s.registry.byToken(s.token)).toBeUndefined();
      expect(s.registry.byToken(keptToken)?.state).toBe("prepared");
      for (let n = 0; n < 62; n++) expect(s.registry.prepare(`again${n}`, "Monitor", monitor(`again ${n}`), "q", map)).toBeDefined();
    });
    it("frees a SendMessage target held by an unreported preparation", () => {
      const s = setup(); s.registry.observeFrame(s.start); s.outcome();
      s.registry.observeFrame({ ...s.start, subtype: "task_notification", status: "completed" });
      const map = s.basis.exportConfirmed({ token: "root" })!;
      const resume = { to: "task", message: "resume" };
      expect(s.registry.prepare("first", "SendMessage", resume, "r", map)).toBeDefined();
      expect(s.registry.prepare("second", "SendMessage", resume, "r2", map)).toBeUndefined();
      s.registry.retirePrompt("r");
      expect(s.registry.prepare("second", "SendMessage", resume, "r2", map)).toBeDefined();
    });
    it("does not let a late success of a retired preparation arm", () => {
      const s = setup(); s.registry.retirePrompt("p");
      s.registry.observeFrame(s.start); s.outcome();
      expect(s.registry.byToken(s.token)).toBeUndefined();
      expect(s.registry.byTask("task")).toBeUndefined();
      expect(s.registry.prepare("call", "Agent", s.input, "p", s.basis.exportConfirmed({ token: "root" })!)).toBeUndefined();
    });
    it("leaves armed and draining claims to outlive the root", () => {
      const s = setup(); s.registry.observeFrame(s.start); s.outcome();
      const cap = s.registry.byToken(s.token)!;
      s.registry.retirePrompt("p"); expect(s.registry.eligible(cap)).toBe(true);
      s.registry.observeFrame({ ...s.start, subtype: "task_notification", status: "completed" });
      s.registry.retirePrompt("p"); expect(s.registry.eligible(cap)).toBe(true);
    });
  });
  it("does not instrument a live target; a successful resumed run needs its new accepted canonical message", () => {
    const s = setup(); s.registry.observeFrame(s.start); s.outcome();
    const map = s.basis.exportConfirmed({ token: "root" })!;
    const input = { to: "task", message: "resume", content: "old preview", recipient: "task", recipient_kind: "agent" };
    expect(s.registry.prepare("live", "SendMessage", input, "p", map)).toBeUndefined();
    s.registry.observeFrame({ ...s.start, subtype: "task_notification", status: "completed" });
    const effective = s.registry.prepare("resume", "SendMessage", input, "p", map)!;
    expect(effective.content).toBe("old preview"); expect(effective.message).not.toBe("resume");
    s.registry.observeFrame({ ...s.start, tool_use_id: "resume", run_id: "a-new-opaque-run", prompt: effective.message });
    s.registry.outcome("resume", effective, { success: true, resumedAgentId: "task" });
    expect(s.registry.byToken(s.token)).toBeUndefined();
    expect(s.registry.byTask("task")?.effective.message).toBe(effective.message);
  });
  it("queued SendMessage success discards preparation without retiring the previous capability", () => {
    const s = setup(); s.registry.observeFrame(s.start); s.outcome();
    s.registry.observeFrame({ ...s.start, subtype: "task_notification", status: "completed" });
    const effective = s.registry.prepare("resume", "SendMessage", { to: "task", message: "resume" }, "p", s.basis.exportConfirmed({ token: "root" })!)!;
    expect(effective).toBeDefined();
    s.registry.outcome("resume", effective, { success: true, message: "queued" });
    expect(s.registry.eligible(s.registry.byToken(s.token)!)).toBe(true);
  });
  it.each(["handback", "killed-update", "failed-stop"])("does not infer resumability from %s alone", evidence => {
    const s = setup(); s.registry.observeFrame(s.start); s.outcome();
    if (evidence === "handback") s.registry.quarantine(s.token, "fold");
    if (evidence === "killed-update") s.registry.observeFrame({ ...s.start, subtype: "task_updated", patch: { status: "killed" } });
    if (evidence === "failed-stop") { s.registry.stopAttempt("stop", "task"); s.registry.stopOutcome("stop", false); }
    expect(s.registry.prepare("resume", "SendMessage", { to: "task", message: "resume" }, "p", s.basis.exportConfirmed({ token: "root" })!)).toBeUndefined();
  });
  it.each(["completed", "failed", "wrong-run", "expired", "error"])("does not project interrupt onto %s witnesses", kind => {
    const s = setup(); s.registry.observeFrame(s.start); s.outcome(); const cap = s.registry.byToken(s.token)!;
    const window = s.registry.beginInterrupt(100); s.registry.endInterrupt(window, kind !== "error", 200);
    if (kind === "wrong-run") {
      // A different task cannot inherit the captured task's intent.
      s.registry.observeFrame({ ...s.start, task_id: "other", subtype: "task_notification", status: "stopped" }, 300);
    } else s.registry.observeFrame({ ...s.start, subtype: "task_notification", status: ["completed", "failed"].includes(kind) ? kind : "stopped" }, kind === "expired" ? 1201 : 300);
    expect(s.registry.eligible(cap)).toBe(true);
  });
  it("pauses drain while busy and retains source classification across capacity refusal", () => {
    const s = setup(); s.registry.observeFrame(s.start); s.outcome();
    s.registry.observeFrame({ ...s.start, subtype: "task_notification", status: "completed" });
    const cap = s.registry.byToken(s.token)!;
    const now = performance.now(); s.registry.tick(true, now); s.registry.tick(true, now + 100000);
    expect(s.registry.eligible(cap)).toBe(true);
    const map = s.basis.exportConfirmed({ token: "root" })!;
    for (let n = 0; n < 63; n++) expect(s.registry.prepare(`c${n}`, "Monitor", { description: "watch", command: "echo x" }, "p", map)).toBeDefined();
    expect(s.registry.prepare("overflow", "Monitor", { description: "watch", command: "echo x" }, "p", map)).toBeUndefined();
    s.registry.observeFrame({ type: "system", subtype: "task_started", session_id: "s", task_id: "overflow", run_id: "r", tool_use_id: "overflow", task_type: "local_bash", is_backgrounded: true });
    expect(s.registry.source("overflow")?.source).toBe("Monitor");
    expect(s.registry.byTask("overflow")).toBeUndefined();
    s.registry.tick(false, now + 100000); s.registry.tick(false, now + 110001);
    expect(s.registry.eligible(cap)).toBe(false);
    expect(s.registry.prepare("recovered", "Monitor", { description: "watch", command: "echo x" }, "p", map)).toBeDefined();
  });
  it("rejects conflicting repeated call inputs and cannot revive a denied preparation", () => {
    const s = setup();
    s.registry.observeCall("call", "Agent", { ...s.input, prompt: "changed" });
    s.registry.observeFrame(s.start); s.outcome();
    expect(s.registry.byTask("task")).toBeUndefined();
    const t = setup(); t.registry.rejectCall("call"); t.registry.observeFrame(t.start); t.outcome();
    expect(t.registry.byTask("task")).toBeUndefined();
  });
});
