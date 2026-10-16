import { peerFixture } from "./fixtures/native_peer_opener.js";
import { describe, expect, it } from "vitest";
import { ReplyBasis, type DetachedReplyBasis, type Envelope } from "@kaoiro/agent-common";
import { ContinuationRegistry } from "../src/continuation_registry.js";
import { ContinuationProofs } from "../src/continuation_proof.js";
import { marker, escapeNativeScalar } from "../src/continuation_markers.js";
import type { NativeAnchor } from "../src/native_transcript.js";

function rig() {
  const basis = new ReplyBasis(); basis.begin("root", []);
  const snapshot = basis.exportConfirmed({ token: "root" })!;
  const registry = new ContinuationRegistry("s");
  const proofs = new ContinuationProofs(registry, basis);
  const launch = (id: string, source: "Agent" | "Monitor" | "Bash" | "Workflow", map = snapshot, ws = false) => {
    const input = source === "Monitor" ? { description: "a & <watch>", ...(ws ? { ws: { url: "ws://example.invalid", headers: { local: "test" } } } : { command: "echo event" }) } :
      source === "Agent" ? { prompt: "report", subagent_type: "general-purpose", run_in_background: true } : { command: "echo done", run_in_background: true };
    registry.observeCall(id, source, input);
    const effective = registry.prepare(id, source, input, "parent", map) ?? input;
    const start = { type: "system", subtype: "task_started", session_id: "s", task_id: id, run_id: "run-" + id, tool_use_id: id,
      task_type: source === "Monitor" ? ws ? "monitor_ws" : "local_bash" : source === "Agent" ? "local_agent" : source === "Bash" ? "local_bash" : "local_workflow",
      ...(ws || source === "Workflow" ? {} : { is_backgrounded: true }), description: (effective as { description?: string }).description, prompt: (effective as { prompt?: string }).prompt };
    registry.observeFrame(start);
    if (source === "Monitor") registry.outcome(id, effective, { taskId: id });
    if (source === "Agent") registry.outcome(id, effective, { isAsync: true, status: "async_launched", agentId: id, prompt: (effective as { prompt: string }).prompt });
    return { cap: registry.byTask(id), effective, start };
  };
  const event = (id: string) => `<task-notification><task-id>${id}</task-id><summary>Monitor event: "a &amp; &lt;watch&gt; ${marker(registry.byTask(id)!.token)}"</summary><event>payload</event></task-notification>`;
  const completion = (id: string, summary = "finished") => {
    const run = registry.source(id)!;
    registry.observeFrame({ type: "system", subtype: "task_notification", session_id: "s", task_id: id,
      run_id: run.runId, tool_use_id: id, status: "completed", output_file: "/tmp/output", summary });
    return `<task-notification><task-id>${id}</task-id><tool-use-id>${id}</tool-use-id><output-file>/tmp/output</output-file><status>completed</status><summary>${escapeNativeScalar(summary)}</summary></task-notification>`;
  };
  const prove = (prompt: string, map = snapshot, origin: Record<string, unknown> = { kind: "task-notification", producer: "session-task" }, uuid = "occurrence") => {
    const peer = origin.kind === "peer" ? peerFixture(prompt, String(origin.from)) : undefined;
    const anchor: NativeAnchor = { uuid, promptId: "p", digest: "owned-test", row: {
      promptSource: "system", turnOrigin: origin.kind === "peer" ? "peer" : "task_notification", origin,
      message: { role: "user", content: peer?.row.message.content ?? prompt } } };
    return proofs.prove(anchor, peer?.hook ?? prompt, map);
  };
  const agentCompletion = (id: string, report: string, output = true) => {
    completion(id, report);
    return `<task-notification><task-id>${id}</task-id><tool-use-id>${id}</tool-use-id>` +
      (output ? "<output-file>/tmp/output</output-file>" : "") + '<status>completed</status><summary>Agent "child" finished</summary>' +
      `<note>Agent may resume</note><result>${escapeNativeScalar(report)}</result>` +
      '<usage><subagent_tokens>1</subagent_tokens><tool_uses>0</tool_uses><duration_ms>1</duration_ms></usage></task-notification>';
  };
  const agentOrigin = (id: string) => ({ kind: "task-notification", producer: "session-task", runId: "run-" + id });
  return { basis, registry, proofs, snapshot, launch, event, completion, prove, agentCompletion, agentOrigin };
}

describe("atomic native continuation proof", () => {
  it.each([1, 2, 16])("admits %i independently proved Monitor blocks as one atomic receipt", count => {
    const r = rig();
    const prompt = Array.from({ length: count }, (_, n) => { r.launch(String(n), "Monitor"); return r.event(String(n)); }).join("\n");
    const result = r.prove(prompt);
    expect("proof" in result).toBe(true);
    if ("proof" in result) { expect(result.proof.commit()).toBe(true); expect(result.proof.commit()).toBe(true); }
  });
  it.each([false, true])("accepts command/ws Monitor completions without marker or final event, ws=%s", ws => {
    const r = rig(); r.launch("m", "Monitor", r.snapshot, ws);
    const prompt = r.completion("m");
    const result = r.prove(prompt, r.snapshot, { kind: "task-notification" });
    expect("proof" in result).toBe(true);
    if ("proof" in result) expect(result.proof.commit()).toBe(true);
    expect(r.prove(prompt)).toHaveProperty("reason", "native_completion_unproved");
  });
  it("rejects an invalid sibling without consuming a valid completion", () => {
    const r = rig(); r.launch("m", "Monitor");
    const prompt = r.completion("m");
    expect(r.prove(prompt + '<task-notification><task-id>unknown</task-id><summary>bad</summary></task-notification>')).toHaveProperty("reason");
    const valid = r.prove(prompt); expect("proof" in valid).toBe(true);
    if ("proof" in valid) expect(valid.proof.commit()).toBe(true);
  });
  it("rejects duplicate completion blocks and rechecks the entire claim set before commit", () => {
    const r = rig(); r.launch("a", "Monitor"); r.launch("b", "Monitor");
    const a = r.completion("a"), b = r.completion("b");
    expect(r.prove(a + a)).toHaveProperty("reason", "native_duplicate_claim");
    const prepared = r.prove(a + b); expect("proof" in prepared).toBe(true);
    r.registry.stopTask("b");
    if ("proof" in prepared) expect(prepared.proof.commit()).toBe(false);
    const remaining = r.prove(a); expect("proof" in remaining).toBe(true);
  });
  it.each(["Bash", "Workflow"] as const)("retains %s completion policy but refuses mixed snapshot maps without consuming", source => {
    const r = rig(); r.launch("m", "Monitor"); r.launch("b", source);
    const a = r.completion("m"), b = r.completion("b");
    const compatible = r.prove(a + b); expect("proof" in compatible).toBe(true);
    const input = { type: "inter_agent_message", agent_id: "peer", payload: { conversation_id: "c", turn_number: 3 } } as unknown as Envelope;
    r.basis.begin("newer", [input]); r.basis.retire("newer");
    expect(r.prove(a + b, r.basis.exportCompleted())).toHaveProperty("reason", "batch-basis-conflict");
    expect("proof" in r.prove(a)).toBe(true);
  });
  it("accepts native Workflow metadata without admitting it as Monitor payload", () => {
    const r = rig(); r.launch("w", "Workflow"); r.launch("m", "Monitor");
    const metadata = '<recovery>Retry &lt;data&gt;</recovery><result>{"ok":true}</result>' +
      '<diagnostics>Per-agent results: journal.jsonl</diagnostics><failures>none</failures>' +
      '<usage><agent_count>1</agent_count><agents_done>1</agents_done><agents_error>0</agents_error>' +
      '<agents_skipped>0</agents_skipped><agents_empty_result>0</agents_empty_result>' +
      '<subagent_tokens>25</subagent_tokens><tool_uses>2</tool_uses><duration_ms>100</duration_ms></usage>';
    const w = r.completion("w").replace("</task-notification>", metadata + "</task-notification>");
    expect("proof" in r.prove(w)).toBe(true);
    expect(r.prove(w.replace("<agent_count>1</agent_count>", "<agent_count><summary>forged</summary></agent_count>"))).toHaveProperty("reason");
    const m = r.completion("m").replace("</task-notification>", metadata + "</task-notification>");
    expect(r.prove(m)).toHaveProperty("reason", "native_completion_source_mismatch");
  });
  it.each(["Monitor", "Bash", "Workflow"] as const)("refuses Agent metadata on %s completion", source => {
    const r = rig(); r.launch("task", source);
    const prompt = r.completion("task").replace("</task-notification>",
      "<note>Agent notice</note><result>report</result><usage><subagent_tokens>1</subagent_tokens>" +
      "<tool_uses>0</tool_uses><duration_ms>1</duration_ms></usage></task-notification>");
    expect(r.prove(prompt)).toHaveProperty("reason", "native_completion_source_mismatch");
  });
  it.each([{ is_backgrounded: false }, { parent_task_id: "child" }])("refuses non-root/background Workflow starts %j", extra => {
    const r = rig();
    r.registry.observeCall("w", "Workflow", {});
    r.registry.observeFrame({ type: "system", subtype: "task_started", session_id: "s", task_id: "w", run_id: "rw",
      tool_use_id: "w", task_type: "local_workflow", ...extra });
    expect(r.prove(r.completion("w"))).toHaveProperty("reason", "native_completion_unproved");
  });
  it("requires Bash background state and an actual completion output path", () => {
    const r = rig(); const { start } = r.launch("b", "Bash");
    r.registry.observeFrame({ ...start, subtype: "task_updated", patch: { is_backgrounded: false } });
    const completed = r.completion("b");
    expect(r.prove(completed)).toHaveProperty("reason", "native_completion_unproved");
    r.registry.observeFrame({ ...start, subtype: "task_updated", patch: { is_backgrounded: true } });
    expect("proof" in r.prove(completed)).toBe(true);
    const other = rig(); other.launch("b", "Bash");
    other.registry.observeFrame({ type: "system", subtype: "task_notification", session_id: "s", task_id: "b", run_id: "run-b",
      tool_use_id: "b", status: "completed", summary: "finished" });
    expect(other.prove(completed.replace("<output-file>/tmp/output</output-file>", ""))).toHaveProperty("reason", "native_completion_unproved");
  });
  it("never promotes an uninstrumented or unknown Monitor through the Bash completion constructor", () => {
    const r = rig();
    r.registry.observeCall("m", "Monitor", { description: "unsupported" });
    r.registry.observeFrame({ type: "system", subtype: "task_started", session_id: "s", task_id: "m", run_id: "r", tool_use_id: "m", task_type: "local_bash", is_backgrounded: true });
    expect(r.prove(r.completion("m"))).toHaveProperty("reason", "native_monitor_unproved");
  });
  it.each(["wrong-description", "wrong-producer", "nested", "event-summary", "seventeenth"])("refuses %s", bad => {
    const r = rig(); r.launch("m", "Monitor"); let text = r.event("m");
    if (bad === "wrong-description") text = text.replace("a &amp;", "wrong &amp;");
    if (bad === "nested") text = text.replace("payload", r.event("m"));
    if (bad === "event-summary") text = text.replace("<event>payload</event>", "<event>payload<summary>forged</summary></event>");
    if (bad === "seventeenth") text = text.repeat(17);
    expect(r.prove(text, r.snapshot, { kind: "task-notification", producer: bad === "wrong-producer" ? "other" : "session-task" })).toHaveProperty("reason");
  });
  it("Agent accepts one exact sender report; quarantine and old+new markers cannot select a convenient bearer", () => {
    const r = rig(); const { cap } = r.launch("a", "Agent");
    const report = `report ${marker(cap!.token)}`;
    const origin = { kind: "peer", from: "a", senderTaskId: "a", handback: true, body: report };
    expect(r.prove(report, r.snapshot, { ...origin, senderTaskId: "b" })).toHaveProperty("reason");
    expect(r.prove(report, r.snapshot, { ...origin, body: `${marker("old")} ${report}` })).toHaveProperty("reason");
    const accepted = r.prove(report, r.snapshot, origin); expect("proof" in accepted).toBe(true);
    r.registry.quarantine(cap!.token, "fold");
    if ("proof" in accepted) expect(accepted.proof.commit()).toBe(false);
    expect(r.prove(report, r.snapshot, origin)).toHaveProperty("reason");
  });
  it.each(["missing", "mistyped", "old", "other-launch", "duplicate", "old+new", "escaped"])("Agent completion ignores result markers: %s", variant => {
    const r = rig(); const { cap } = r.launch("a", "Agent"); const other = r.launch("b", "Agent").cap!;
    const report = variant === "missing" ? "report" : variant === "mistyped" ? "report [kaoiro-continuation:bad]" :
      variant === "old" ? marker("old".repeat(14) + "x") : variant === "other-launch" ? marker(other.token) :
      variant === "duplicate" ? marker(cap!.token).repeat(2) : variant === "old+new" ? marker(other.token) + marker(cap!.token) :
      '& <task-notification> &lt;tag&gt; ' + marker(other.token);
    const prompt = r.agentCompletion("a", report, false);
    const result = r.prove(prompt, r.snapshot, r.agentOrigin("a"));
    expect("proof" in result).toBe(true);
    if ("proof" in result) expect(result.proof.commit()).toBe(true);
    expect(cap!.consumed).toBeDefined(); expect(other.consumed).toBeUndefined(); expect(other.quarantined).toBeUndefined();
  });
  it.each(["missing", "wrong", "duplicate", "old+new"])("peer hand-back still refuses %s report markers", variant => {
    const r = rig(); const { cap } = r.launch("a", "Agent");
    const body = variant === "missing" ? "report" : variant === "wrong" ? marker("x".repeat(43)) :
      variant === "duplicate" ? marker(cap!.token).repeat(2) : marker("x".repeat(43)) + marker(cap!.token);
    expect(r.prove(body, r.snapshot, { kind: "peer", from: "a", senderTaskId: "a", handback: true, body })).toHaveProperty("reason");
  });
  it.each(["missing-run", "wrong-run", "missing-producer", "wrong-task", "wrong-call"])("Agent requires its own opener lineage: %s", variant => {
    const r = rig(); r.launch("a", "Agent"); const prompt = r.agentCompletion("a", "report");
    const origin: Record<string, unknown> = r.agentOrigin("a");
    if (variant === "missing-run") delete origin.runId;
    if (variant === "wrong-run") origin.runId = "old";
    if (variant === "missing-producer") delete origin.producer;
    if (variant === "wrong-task") origin.taskId = "other";
    if (variant === "wrong-call") origin.toolUseId = "other";
    expect(r.prove(prompt, r.snapshot, origin)).toHaveProperty("reason", "native_agent_origin_mismatch");
  });
  it.each(["run_id", "task_id", "tool_use_id", "session_id", "status", "summary", "output_file"])("Agent requires the same native completion %s", field => {
    const r = rig(); r.launch("a", "Agent"); const prompt = r.agentCompletion("a", "report");
    r.registry.source("a")!.terminal![field] = "wrong";
    expect(r.prove(prompt, r.snapshot, r.agentOrigin("a"))).toHaveProperty("reason");
  });
  it.each(["missing", "empty", "non-string"])("Agent completion needs a known native output_file even when the notice omits it: %s", kind => {
    const control = rig(); control.launch("a", "Agent");
    expect("proof" in control.prove(control.agentCompletion("a", "report", false), control.snapshot, control.agentOrigin("a"))).toBe(true);
    const r = rig(); r.launch("a", "Agent"); const prompt = r.agentCompletion("a", "report", false);
    const terminal = r.registry.source("a")!.terminal!;
    if (kind === "missing") delete terminal.output_file;
    if (kind === "empty") terminal.output_file = "";
    if (kind === "non-string") terminal.output_file = 7;
    expect(r.prove(prompt, r.snapshot, r.agentOrigin("a"))).toHaveProperty("reason", "native_agent_completion_unproved");
  });
  it("Agent block call cannot differ from the completion's accepted call", () => {
    const r = rig(); r.launch("a", "Agent");
    const prompt = r.agentCompletion("a", "report").replace("<tool-use-id>a</tool-use-id>", "<tool-use-id>other</tool-use-id>");
    expect(r.prove(prompt, r.snapshot, r.agentOrigin("a"))).toHaveProperty("reason");
  });
  it.each(["callId", "taskId", "runId", "sessionId"])("Agent capability cannot borrow another accepted %s", field => {
    const r = rig(); const { cap } = r.launch("a", "Agent"); const prompt = r.agentCompletion("a", "report");
    Object.assign(cap!, { [field]: "wrong" });
    expect(r.prove(prompt, r.snapshot, r.agentOrigin("a"))).toHaveProperty("reason");
  });
  it.each(["usage", "worktree", "note", "report", "output"])("Agent refuses contradictory native metadata or report: %s", field => {
    const r = rig(); r.launch("a", "Agent"); let prompt = r.agentCompletion("a", "report");
    const terminal = r.registry.source("a")!.terminal!;
    if (field === "usage") terminal.usage = { total_tokens: 2, tool_uses: 0, duration_ms: 1 };
    if (field === "worktree") {
      terminal.worktreeBranch = "other";
      prompt = prompt.replace("</task-notification>", '<worktree><worktreePath>/workspace/a</worktreePath><worktreeBranch>topic</worktreeBranch></worktree></task-notification>');
    }
    if (field === "note") terminal.note = "wrong";
    if (field === "report") prompt = prompt.replace("<result>report", "<result>wrong");
    if (field === "output") prompt = prompt.replace("/tmp/output", "/tmp/wrong");
    expect(r.prove(prompt, r.snapshot, r.agentOrigin("a"))).toHaveProperty("reason");
  });
  it.each([true, false])("peer and completion atomically share one slot, peer first=%s", peerFirst => {
    const r = rig(); const { cap } = r.launch("a", "Agent");
    const report = `report ${marker(cap!.token)}`, prompt = r.agentCompletion("a", report);
    const peerOrigin = { kind: "peer", from: "a", senderTaskId: "a", handback: true, body: report };
    const peer = r.prove(report, r.snapshot, peerOrigin, "peer-occurrence");
    const completion = r.prove(prompt, r.snapshot, r.agentOrigin("a"), "completion-occurrence");
    expect("proof" in peer && "proof" in completion).toBe(true);
    if ("proof" in peer && "proof" in completion) {
      const first = peerFirst ? peer : completion, second = peerFirst ? completion : peer;
      expect(first.proof.commit()).toBe(true); expect(first.proof.commit()).toBe(true); expect(second.proof.commit()).toBe(false);
    }
    expect(r.prove(report, r.snapshot, peerOrigin, "new-peer")).toHaveProperty("reason");
    expect(r.prove(prompt, r.snapshot, r.agentOrigin("a"), "new-completion")).toHaveProperty("reason");
  });
  it("completion folds quarantine only their tuple-selected launch, never result markers", () => {
    const r = rig(); const a = r.launch("a", "Agent").cap!, b = r.launch("b", "Agent").cap!;
    const prompt = r.agentCompletion("a", marker(b.token));
    const prepared = r.prove(prompt, r.snapshot, r.agentOrigin("a")); expect("proof" in prepared).toBe(true);
    r.proofs.reserveCompletionFold(prompt, "fold");
    expect(a.quarantined).toBe("fold"); expect(b.quarantined).toBeUndefined();
    if ("proof" in prepared) expect(prepared.proof.commit()).toBe(false);
    expect(r.prove(prompt, r.snapshot, r.agentOrigin("a"))).toHaveProperty("reason");
    const report = marker(a.token);
    expect(r.prove(report, r.snapshot, { kind: "peer", from: "a", senderTaskId: "a", handback: true, body: report })).toHaveProperty("reason");
  });
  it("Agent batches reject duplicate slots and mixed maps without partial consumption", () => {
    const r = rig(); const { cap } = r.launch("a", "Agent"); r.launch("b", "Bash");
    const prompt = r.agentCompletion("a", "report"), bash = r.completion("b");
    expect(r.prove(prompt + prompt, r.snapshot, r.agentOrigin("a"))).toHaveProperty("reason", "native_duplicate_claim");
    r.basis.begin("newer", [{ type: "inter_agent_message", agent_id: "peer", payload: { conversation_id: "c", turn_number: 3 } } as unknown as Envelope]);
    r.basis.retire("newer");
    expect(r.prove(prompt + bash, r.basis.exportCompleted(), r.agentOrigin("a"))).toHaveProperty("reason", "batch-basis-conflict");
    expect(cap!.consumed).toBeUndefined();
    const valid = r.prove(prompt + bash, r.snapshot, r.agentOrigin("a")); expect("proof" in valid).toBe(true);
    if ("proof" in valid) expect(valid.proof.commit()).toBe(true);
  });
  describe("one origin run per prompt", () => {
    it("refuses Agent completions of different runs on one map, consuming neither", () => {
      const r = rig(); const a = r.launch("a", "Agent").cap!, b = r.launch("b", "Agent").cap!;
      const both = r.agentCompletion("a", "report a") + r.agentCompletion("b", "report b");
      expect(r.prove(both, r.snapshot, r.agentOrigin("a"))).toHaveProperty("reason", "native_agent_origin_mismatch");
      expect(r.prove(both, r.snapshot, r.agentOrigin("b"))).toHaveProperty("reason", "native_agent_origin_mismatch");
      expect(a.consumed).toBeUndefined(); expect(b.consumed).toBeUndefined();
    });
    it("accepts one Agent completion whose run is the origin, alone or beside a Monitor event", () => {
      const r = rig(); const a = r.launch("a", "Agent").cap!; r.launch("m", "Monitor");
      const report = r.agentCompletion("a", "report a");
      const alone = r.prove(report, r.snapshot, r.agentOrigin("a"), "alone"), mixed = r.prove(report + r.event("m"), r.snapshot, r.agentOrigin("a"), "mixed");
      expect("proof" in alone && "proof" in mixed).toBe(true);
      if ("proof" in mixed) { expect(mixed.proof.commit()).toBe(true); expect(a.consumed).toBeDefined(); }
    });
  });
  it("reactivation selects the SendMessage call even when run2 repeats run1's marker", () => {
    const r = rig(); const old = r.launch("a", "Agent"); r.agentCompletion("a", "old report");
    const effective = r.registry.prepare("resume", "SendMessage", { to: "a", message: "resume" }, "new-parent", r.snapshot)!;
    r.registry.observeFrame({ ...old.start, run_id: "run-two", tool_use_id: "resume", prompt: effective.message });
    r.registry.outcome("resume", effective, { success: true, resumedAgentId: "a" });
    const cap = r.registry.byExecution("resume", "a", "run-two")!;
    expect(cap).toBeDefined(); expect(cap.token).not.toBe(old.cap!.token);
    const report = marker(old.cap!.token);
    r.registry.observeFrame({ type: "system", subtype: "task_notification", session_id: "s", task_id: "a", run_id: "run-two",
      tool_use_id: "resume", status: "completed", output_file: "/tmp/output", summary: report });
    const prompt = `<task-notification><task-id>a</task-id><tool-use-id>resume</tool-use-id><status>completed</status><summary>Agent finished</summary><result>${report}</result></task-notification>`;
    const result = r.prove(prompt, r.snapshot, { kind: "task-notification", producer: "session-task", runId: "run-two" });
    expect("proof" in result).toBe(true);
    if ("proof" in result) expect(result.proof.commit()).toBe(true);
    expect(cap.consumed).toBeDefined(); expect(old.cap!.quarantined).toBeUndefined();
  });
});


describe("a TaskStop on one Monitor leaves another source usable", () => {
  it.each(["pending", "success"].flatMap(outcome => [[outcome, "command", "command"], [outcome, "command", "ws"], [outcome, "ws", "command"], [outcome, "ws", "ws"]]))(
    "%s stop on a %s Monitor keeps a %s Monitor's claim and its proved lease", (outcome, targetKind, otherKind) => {
      const r = rig(); r.launch("target", "Monitor", r.snapshot, targetKind === "ws"); r.launch("other", "Monitor", r.snapshot, otherKind === "ws");
      const targetEvent = r.event("target"), otherEvent = r.event("other");
      const lease = r.prove(otherEvent, r.snapshot, undefined, "before-stop");
      expect("proof" in lease).toBe(true);
      r.registry.stopAttempt("stop", "target");
      if (outcome === "success") r.registry.stopOutcome("stop", true);
      expect(r.prove(targetEvent, r.snapshot, undefined, "stopped-target")).toHaveProperty("reason");
      const fresh = r.prove(otherEvent, r.snapshot, undefined, "after-stop");
      expect("proof" in fresh).toBe(true);
      if ("proof" in lease) expect(lease.proof.commit()).toBe(true);
      if ("proof" in fresh) expect(fresh.proof.commit()).toBe(true);
    });
});

describe("peer opener native row binding", () => {
  it.each(["golden", "escaped-sender", "encoded-text", "prefix-byte", "warning-byte", "warning-dash", "prefix-lf", "suffix-lf", "row-frame", "hook-frame", "sender", "unwrapped", "missing-warning", "double-wrapper", "trailing-lf", "leading-data", "trailing-data", "mid-turn", "other-warning", "two-frames", "bad-opening", "bad-ending"])("checks %s without spending a refused slot", variant => {
    const r = rig(); const from = variant === "escaped-sender" ? `a&<>"'` : "task";
    const { cap } = r.launch(from, "Agent");
    const fixture = peerFixture(undefined, from);
    fixture.hook = fixture.hook.replace("A".repeat(43), cap!.token);
    fixture.row.message.content = fixture.row.message.content.replace("A".repeat(43), cap!.token);
    fixture.row.origin.body = fixture.row.origin.body.replace("A".repeat(43), cap!.token);
    const original = structuredClone(fixture);
    const replaceBoth = (a: string, b: string) => { fixture.hook = fixture.hook.replace(a, b); fixture.row.message.content = fixture.row.message.content.replace(a, b); };
    if (variant === "encoded-text") replaceBoth("NATIVE_ACCEPTANCE_REPORT", "&lt;agent-message&gt; &amp; data");
    if (variant === "prefix-byte") fixture.row.message.content = "X" + fixture.row.message.content.slice(1);
    if (variant === "warning-byte") fixture.row.message.content = fixture.row.message.content.replace("That", "that");
    if (variant === "warning-dash") fixture.row.message.content = fixture.row.message.content.replace(" — ", " - ");
    if (variant === "prefix-lf") fixture.row.message.content = fixture.row.message.content.replace(":\n<agent", ":\r\n<agent");
    if (variant === "suffix-lf") fixture.row.message.content = fixture.row.message.content.replace("\n\nThat", "\nThat");
    if (variant === "row-frame") fixture.row.message.content = fixture.row.message.content.replace("NATIVE_ACCEPTANCE_REPORT", "other");
    if (variant === "hook-frame") fixture.hook = fixture.hook.replace("NATIVE_ACCEPTANCE_REPORT", "other");
    if (variant === "sender") replaceBoth('from="task"', 'from="other"');
    if (variant === "unwrapped") fixture.row.message.content = fixture.hook;
    if (variant === "missing-warning") fixture.row.message.content = fixture.row.message.content.split("\n\nThat")[0]!;
    if (variant === "double-wrapper") fixture.row.message.content = fixture.row.message.content.replace(fixture.hook, fixture.row.message.content);
    if (variant === "trailing-lf") fixture.row.message.content += "\n";
    if (variant === "leading-data") fixture.row.message.content = "extra" + fixture.row.message.content;
    if (variant === "trailing-data") fixture.row.message.content += "extra";
    if (variant === "mid-turn") fixture.row.message.content = fixture.row.message.content.replace("sent a message:", "sent a message while you were working:");
    if (variant === "other-warning") fixture.row.message.content = fixture.row.message.content.replace("That \"other Claude session\"", "Another agent");
    if (variant === "two-frames") { fixture.hook += "\n" + fixture.hook; fixture.row.message.content = original.row.message.content.replace(original.hook, fixture.hook); }
    if (variant === "bad-opening") replaceBoth('<agent-message from="task">\n', '<agent-message from="task">');
    if (variant === "bad-ending") replaceBoth("\n</agent-message>", "</agent-message>");
    const result = r.proofs.prove({ uuid: "opener", promptId: "return", digest: "test", row: fixture.row }, fixture.hook, r.snapshot);
    if (["golden", "escaped-sender", "encoded-text"].includes(variant)) {
      expect(result).toHaveProperty("proof"); if ("proof" in result) expect(result.proof.commit()).toBe(true);
    } else {
      expect(result).toHaveProperty("reason", "native_opener_mismatch"); expect(cap!.consumed).toBeUndefined();
      expect(r.proofs.prove({ uuid: "opener", promptId: "return", digest: "test", row: original.row }, original.hook, r.snapshot)).toHaveProperty("proof");
    }
  });
  it("refuses a peer wrapper on a task notification", () => {
    const r = rig(); r.launch("task", "Agent");
    const prompt = r.agentCompletion("task", "done"); const fixture = peerFixture();
    const row = { ...fixture.row, turnOrigin: "task_notification", origin: r.agentOrigin("task"),
      message: { role: "user", content: fixture.row.message.content.replace(fixture.hook, prompt) } };
    expect(r.proofs.prove({ uuid: "opener", promptId: "return", digest: "test", row }, prompt, r.snapshot)).toHaveProperty("reason", "native_opener_mismatch");
  });
});
