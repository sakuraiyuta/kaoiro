import { permitHostAccess } from "../../../scripts/test/fixtures/test-isolation.mjs";

// Opt-in native acceptance of the ACP host (design r14 section 8): the
// production CLI with a stand-in server link drives the real `agy` against a
// real provider. Run with KAOIRO_LIVE_AGY=1, `agy` on PATH and its credentials
// in the environment:
//   KAOIRO_LIVE_AGY=1 pnpm exec vitest run test/acp_native.test.ts
// The verdicts come from the gate, operator-dialog, wire and workspace
// records, never from the model's prose. The judges' negative controls run
// without the opt-in.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { ToolHost } from "@kaoiro/agent-common/dist/toolhost.js";
import { runAntigravityCli } from "../src/cli.js";
import { TOOL_CLASS_BY_NAME } from "../src/gate.js";
import { HookGateServer } from "../src/hook_gate.js";
import { AntigravityHost, type AntigravityHostOptions } from "../src/host.js";

permitHostAccess({
  kinds: ["network"],
  optIn: "KAOIRO_LIVE_AGY",
  reason: "live Antigravity provider turns",
});

const LIVE = process.env.KAOIRO_LIVE_AGY === "1";
/** The cheapest Gemini model; agy 1.5.14 offers it no thinking level. */
const MODEL = "gemini-3.1-flash-lite-preview";
const PROMPT_BUDGET = 15;
const WRITE_TOOLS = /^(write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit)$/;

/** Each record of a trial carries `seq`, one increasing count per trial, so
 *  the judges can order the gate's answers, the host's projections and the
 *  result. Session, conversation and call IDs are kept in full; only their
 *  tails are printed. */
type GateEntry =
  /** `args` is the request's arguments as JSON; it is never printed. */
  | { kind: "pre"; seq: number; tool: string; decision: "allow" | "deny"; sub: boolean; bypass: boolean; args: string; callId: string; conversation: string }
  | { kind: "stop"; seq: number; decision: "continue" | "stop"; sub: boolean; conversation: string };

/** A `tool_result` log the host projected and the link sent. */
interface ToolResultEntry {
  seq: number;
  toolUseId: string | undefined;
  /** The complete N6 values in its output; never printed. */
  values: string[];
  truncated: boolean;
}

export interface CaseRecord {
  /** The seq of each prompt sent. */
  inputs: number[];
  gate: GateEntry[];
  /** `input` is the dialog's tool input as JSON; it is never printed. */
  dialogs: { tool: string; allow: boolean; input: string }[];
  results: Record<string, unknown>[];
  /** The seq of each result, in the order of `results`. */
  resultSeqs: number[];
  toolResults: ToolResultEntry[];
  argv: string[][];
  /** The sessions the host attached to, in full. */
  sessions: string[];
  files: string[];
  permission: string | undefined;
  /** Spawned `agy` processes still alive after the case closed. */
  alive: number;
  /** Gate faults the host reported until the case closed, its last process
   *  retired and the host closed; undefined when they were not counted. */
  faults: number | undefined;
  /** Calls of the kaoiro `whoami` handler. */
  whoami: number;
  /** A random value the case placed in a workspace file and never in a prompt. */
  marker?: string;
}

export type Verdict = "pass" | "fail" | "undetermined";

type Pre = Extract<GateEntry, { kind: "pre" }>;
const pre = (r: CaseRecord, tool: RegExp) =>
  r.gate.filter((e): e is Pre => e.kind === "pre" && tool.test(e.tool));
const continued = (r: CaseRecord) => r.gate.some((e) => e.kind === "stop" && !e.sub && e.decision === "continue");
const succeeded = (result: Record<string, unknown> | undefined) => result !== undefined && result.is_error !== true;
const interrupted = (r: CaseRecord) => r.results.at(-1)?.error_detail === "interrupted";
const text = (r: CaseRecord) => String(r.results.at(-1)?.text ?? "");
const sandboxed = (args: string[]) => args.includes("--sandbox");
const verdict = (seen: boolean, ok: boolean): Verdict => (!seen ? "undetermined" : ok ? "pass" : "fail");
const N7_FILE = "n7.txt";
const N8_STARTED = "n8.started";
/** Read-class tools that wait or report task state and reach no file. */
const WAITING_TOOLS = new Set(["manage_task", "command_status", "wait", "wait_5_seconds", "finish"]);
/** A parent call that could have read a workspace file itself. */
const parentCouldRead = (e: GateEntry) =>
  e.kind === "pre" && !e.sub && e.decision === "allow" && !e.tool.startsWith("mcp_kaoiro_") &&
  !WAITING_TOOLS.has(e.tool) && TOOL_CLASS_BY_NAME.get(e.tool) !== "subagent";
/** A dialog answered `allow` for this very call: the gate hands the call's
 *  arguments to the dialog unchanged, so its input equals the recorded
 *  arguments. */
const answered = (r: CaseRecord, call: Pre, allow: boolean) =>
  r.dialogs.some((d) => d.tool === call.tool && d.allow === allow && d.input === call.args);
/** N3b and N4: an allowed command named the file, the operator approved that
 *  command's own input, and no write tool named the file. */
const commandWrote = (r: CaseRecord, file: string, bypass: boolean): Verdict => {
  const calls = pre(r, /^run_command$/).filter((c) => c.args.includes(file) && (!bypass || c.bypass));
  const approved = calls.some((c) => c.decision === "allow" && answered(r, c, true));
  const written = r.gate.some((e) => e.kind === "pre" && e.decision === "allow" && TOOL_CLASS_BY_NAME.get(e.tool) === "write" && e.args.includes(file));
  return verdict(calls.length > 0, approved && r.files.includes(file) && !written && r.argv.length > 0 && r.argv.every(sandboxed));
};

/** The fixed N6 command. Its output is random, so only this run made it. */
export const N6_COMMAND = "sleep 8; echo kaoiro-n6-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')";
const N6_VALUE = /kaoiro-n6-[0-9a-f]{16}(?![0-9a-f])/g;
const n6Values = (output: string): string[] => [...output.matchAll(N6_VALUE)].map((match) => match[0]);
const SUBAGENT_TOOLS = new Set(["define_subagent", "invoke_subagent", "manage_subagents"]);
type N6Row = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7";

export interface N6Judgement {
  verdict: Verdict;
  /** The rows evaluated, in order; the last one decided. */
  rows: Partial<Record<N6Row, Verdict>>;
  reason: string;
  /** ID tails, sequence numbers and match results; never a value. */
  ids: Record<string, unknown>;
}

const argsOf = (entry: Pre): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(entry.args);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

/** N6 by the confirmed criteria (n6-criteria.md; issue 1238 comment
 *  7091356206): an observed gate fault first (P7), then the trial's input
 *  and its one source R (P1, P2), then P3-P6 in order. Every bound is
 *  strict. */
export function judgeN6(r: CaseRecord): N6Judgement {
  const rows: N6Judgement["rows"] = {};
  const ids: Record<string, unknown> = {};
  const decide = (row: N6Row, verdict: Verdict, reason: string): N6Judgement => {
    rows[row] = verdict;
    return { verdict, rows, reason, ids };
  };
  if (r.faults !== undefined && r.faults > 0) return decide("P7", "fail", `gate faults ${r.faults}`);
  if (r.inputs.length !== 1 || r.argv.length !== 1 || r.sessions.length !== 1 || r.results.length !== 1) {
    return decide("P1", "undetermined", `inputs ${r.inputs.length}, processes ${r.argv.length}, sessions ${r.sessions.length}, results ${r.results.length}`);
  }
  rows.P1 = "pass";
  const session = r.sessions[0]!;
  const end = r.resultSeqs[0]!;
  ids.s = session.slice(-8);
  ids.e = end;
  const parent = r.gate.filter((e) => e.conversation === session && e.seq < end);
  const allowed = parent.filter((e): e is Pre => e.kind === "pre" && e.decision === "allow");
  const commands = allowed.filter((e) => e.tool === "run_command");
  if (commands.length !== 1 || allowed.some((e) => SUBAGENT_TOOLS.has(e.tool))) {
    return decide("P2", "undetermined", `allowed parent commands ${commands.length}; parent subagent calls ${allowed.filter((e) => SUBAGENT_TOOLS.has(e.tool)).length}`);
  }
  const launch = commands[0]!;
  const args = argsOf(launch);
  const wait = args.WaitMsBeforeAsync;
  if (args.CommandLine !== N6_COMMAND || typeof wait !== "number" || !Number.isInteger(wait) || wait <= 0 || wait >= 8000) {
    return decide("P2", "undetermined", "the allowed command is not the fixed background launch");
  }
  rows.P2 = "pass";
  ids.r = `${launch.callId.slice(-8)}@${launch.seq}`;
  const resume = parent.find((e) => e.kind === "stop" && e.decision === "continue" && e.seq > launch.seq);
  if (resume === undefined) return decide("P3", "fail", "no parent continue after R");
  rows.P3 = "pass";
  ids.k = resume.seq;
  const queries = parent.filter((e): e is Pre => {
    if (e.kind !== "pre" || e.tool !== "manage_task" || e.seq <= resume.seq) return false;
    const query = argsOf(e);
    return query.Action === "status" && typeof query.TaskId === "string" && query.TaskId.trim() !== "";
  });
  ids.m = queries.map((e) => `${e.decision}@${e.seq}`);
  if (queries.length === 0) return decide("P4", "undetermined", "no parent status query with a TaskId between K and E");
  if (!queries.some((e) => e.decision === "allow")) return decide("P4", "fail", "every status query between K and E was denied");
  rows.P4 = "pass";
  const projections = r.toolResults.filter((t) => t.toolUseId === launch.callId);
  ids.projections = projections.map((t) => `${t.values.length}${t.truncated ? "t" : ""}@${t.seq}`);
  if (projections.some((t) => t.seq < resume.seq && t.values.length > 0)) {
    return decide("P5", "undetermined", "R's value reached the host before K");
  }
  const values = new Set(projections.filter((t) => t.seq > resume.seq && t.seq < end).flatMap((t) => t.values));
  if (values.size !== 1) return decide("P5", "undetermined", `complete values of R between K and E: ${values.size}`);
  rows.P5 = "pass";
  const value = [...values][0]!;
  const reply = r.results[0];
  ids.reply_has_value = n6Values(String(reply?.text ?? "")).includes(value);
  if (!succeeded(reply) || ids.reply_has_value !== true) return decide("P6", "fail", "the reply is an error or lacks R's value");
  rows.P6 = "pass";
  if (r.faults === undefined) return decide("P7", "undetermined", "gate faults were not counted");
  return decide("P7", "pass", "every row holds");
}

/** The record v7 6.2 keeps beside the rows; it decides nothing. Each parent
 *  status query before E gives its TaskId an index (t1, t2, ...); each parent
 *  read that reaches a file names the index of a queried TaskId its
 *  arguments hold, or "-". Both carry the gate's actual decision and seq.
 *  No TaskId or path is printed. */
export function n6Correspondence(r: CaseRecord): { status: string[]; reads: string[]; read_count: number } {
  const session = r.sessions[0];
  const end = r.resultSeqs[0] ?? Number.POSITIVE_INFINITY;
  const parent = r.gate.filter((e): e is Pre => e.kind === "pre" && e.conversation === session && e.seq < end);
  const tasks: string[] = [];
  const status = parent.filter((e) => e.tool === "manage_task").flatMap((e) => {
    const query = argsOf(e);
    if (query.Action !== "status" || typeof query.TaskId !== "string" || query.TaskId.trim() === "") return [];
    if (!tasks.includes(query.TaskId)) tasks.push(query.TaskId);
    return [`${e.decision}@${e.seq}:t${tasks.indexOf(query.TaskId) + 1}`];
  });
  const reads = parent.filter((e) => TOOL_CLASS_BY_NAME.get(e.tool) === "read" && !WAITING_TOOLS.has(e.tool)).map((e) => {
    const index = tasks.findIndex((task) => e.args.includes(task));
    return `${e.tool}:${e.decision}@${e.seq}:${index < 0 ? "-" : `t${index + 1}`}`;
  });
  return { status, reads, read_count: reads.length };
}

/** One judge per case: undetermined when the model never made the call the
 *  case needs, otherwise pass or fail on the records. */
export const JUDGES: Record<string, (r: CaseRecord) => Verdict> = {
  // An operator rejection of this command is a hook deny; the turn goes on.
  N1: (r) => {
    const calls = pre(r, /^run_command$/).filter((c) => c.args.includes("kaoiro-n1"));
    const rejected = calls.some((c) => answered(r, c, false));
    return verdict(calls.length > 0, rejected && calls.every((c) => c.decision === "deny") && succeeded(r.results.at(-1)));
  },
  // read-only: every write is denied and nothing is written.
  N2: (r) => {
    const writes = pre(r, WRITE_TOOLS);
    return verdict(writes.length > 0, writes.every((c) => c.decision === "deny") && !r.files.includes("n2.txt") && succeeded(r.results.at(-1)));
  },
  // workspace-write with the network off: a command is denied without a dialog.
  N3a: (r) => {
    const calls = pre(r, /^run_command$/);
    return verdict(calls.length > 0, calls.every((c) => c.decision === "deny") && r.dialogs.length === 0 && !r.files.includes("n3a.txt") && r.argv.every(sandboxed));
  },
  // With the network on, the operator approves this command and it writes the
  // file under --sandbox.
  N3b: (r) => commandWrote(r, "n3b.txt", false),
  // BypassSandbox asks like the shell row; approved, it runs.
  N4: (r) => commandWrote(r, "n4.txt", true),
  // A kaoiro tool is allowed by the gate with no operator dialog and runs.
  N5: (r) => {
    const calls = pre(r, /^mcp_kaoiro_whoami$/);
    // One allowed call and exactly one dispatch of its handler.
    return verdict(calls.length > 0, calls.length === 1 && calls[0]!.decision === "allow" && r.dialogs.length === 0 && r.whoami === 1 && succeeded(r.results.at(-1)));
  },
  N6: (r) => judgeN6(r).verdict,
  // A subagent's report reaches the reply while the prompt is held: the
  // subagent read the marker file, the parent could not, and the reply has it.
  N7: (r) => {
    const started = pre(r, /subagent/).some((c) => !c.sub && c.decision === "allow");
    const reported = r.gate.some((e) => e.kind === "pre" && e.sub && e.decision === "allow" && e.args.includes(N7_FILE));
    const marker = r.marker;
    const seen = started && reported && !r.gate.some(parentCouldRead) && marker !== undefined;
    return verdict(seen, marker !== undefined && continued(r) && succeeded(r.results.at(-1)) && text(r).includes(marker));
  },
  // An interrupt while a subagent's command runs ends the turn and every
  // spawned agy. The command creates its file before it sleeps, and the
  // interrupt waits for that file.
  N8: (r) => verdict(
    r.files.includes(N8_STARTED) && r.gate.some((e) => e.kind === "pre" && e.sub && e.tool === "run_command" && e.decision === "allow"),
    interrupted(r) && r.alive === 0,
  ),
  // An interrupt while the Stop hook holds the prompt ends the turn and every process.
  N9: (r) => verdict(continued(r), interrupted(r) && r.alive === 0),
  // A permission switch: the second turn runs on a new process without --sandbox, applied.
  N10: (r) => verdict(r.results.length === 2, r.argv.length === 2 && sandboxed(r.argv[0]!) && !sandboxed(r.argv[1]!) && r.permission === "applied" && r.results.every(succeeded)),
};

function sample(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    inputs: [1], gate: [], dialogs: [], results: [{ text: "ok" }], resultSeqs: [99], toolResults: [],
    argv: [["acp", "--sandbox"]], sessions: ["session-parent"], files: [], permission: undefined, alive: 0,
    faults: 0, whoami: 0, ...overrides,
  };
}

const call = (tool: string, decision: "allow" | "deny", extra: Partial<Pre> = {}): GateEntry =>
  ({ kind: "pre", seq: 0, tool, decision, sub: false, bypass: false, args: "{}", callId: "call", conversation: "session-parent", ...extra });
const cmd = (decision: "allow" | "deny", extra: Partial<Pre> = {}): GateEntry => call("run_command", decision, extra);
const proceed: GateEntry = { kind: "stop", seq: 0, decision: "continue", sub: false, conversation: "session-parent" };
const n7Read = call("read_file", "allow", { sub: true, args: JSON.stringify({ Path: `/w/${N7_FILE}` }) });
const named = (file: string, extra: Record<string, unknown> = {}) => JSON.stringify({ CommandLine: `echo ok > ${file}`, ...extra });

/** Per judge: a passing record, records that must fail, and records it
 *  cannot judge. N6 has its own table below. */
const CONTROLS: Record<string, { pass: CaseRecord; fail: CaseRecord[]; undetermined: CaseRecord[] }> = {
  N1: {
    pass: sample({ gate: [cmd("deny", { args: named("kaoiro-n1") })], dialogs: [{ tool: "run_command", allow: false, input: named("kaoiro-n1") }] }),
    fail: [
      sample({ gate: [cmd("allow", { args: named("kaoiro-n1") })], dialogs: [{ tool: "run_command", allow: false, input: named("kaoiro-n1") }] }),
      sample({ gate: [cmd("deny", { args: named("kaoiro-n1") })], dialogs: [] }),
      // The rejection was of another command.
      sample({ gate: [cmd("deny", { args: named("kaoiro-n1") })], dialogs: [{ tool: "run_command", allow: false, input: named("other") }] }),
      // ... of another command that names the same token.
      sample({ gate: [cmd("deny", { args: named("kaoiro-n1") })], dialogs: [{ tool: "run_command", allow: false, input: JSON.stringify({ CommandLine: "cat kaoiro-n1" }) }] }),
      sample({ gate: [cmd("deny", { args: named("kaoiro-n1") })], dialogs: [{ tool: "run_command", allow: false, input: named("kaoiro-n1") }], results: [{ is_error: true }] }),
    ],
    undetermined: [sample(), sample({ gate: [cmd("deny", { args: named("other") })] })],
  },
  N2: {
    pass: sample({ gate: [call("write_file", "deny")] }),
    fail: [
      sample({ gate: [call("write_file", "allow")] }),
      sample({ gate: [call("write_file", "deny")], files: ["n2.txt"] }),
    ],
    undetermined: [sample({ gate: [cmd("deny")] })],
  },
  N3a: {
    pass: sample({ gate: [cmd("deny")] }),
    fail: [
      sample({ gate: [cmd("deny")], dialogs: [{ tool: "run_command", allow: false, input: "{}" }] }),
      sample({ gate: [cmd("deny")], files: ["n3a.txt"] }),
      sample({ gate: [cmd("deny")], argv: [["acp"]] }),
    ],
    undetermined: [sample()],
  },
  N3b: {
    pass: sample({
      gate: [cmd("allow", { args: named("n3b.txt") }), call("read_file", "allow", { args: JSON.stringify({ Path: "/w/n3b.txt" }) })],
      dialogs: [{ tool: "run_command", allow: true, input: named("n3b.txt") }],
      files: ["n3b.txt"],
    }),
    fail: [
      sample({ gate: [cmd("allow", { args: named("n3b.txt") })], dialogs: [], files: ["n3b.txt"] }),
      // The approval was of another command.
      sample({ gate: [cmd("allow", { args: named("n3b.txt") })], dialogs: [{ tool: "run_command", allow: true, input: named("other") }], files: ["n3b.txt"] }),
      // ... of another command that names the same file.
      sample({ gate: [cmd("allow", { args: named("n3b.txt") })], dialogs: [{ tool: "run_command", allow: true, input: JSON.stringify({ CommandLine: "cat n3b.txt" }) }], files: ["n3b.txt"] }),
      sample({ gate: [cmd("allow", { args: named("n3b.txt") })], dialogs: [{ tool: "run_command", allow: true, input: named("n3b.txt") }] }),
      // The file came from a write tool.
      sample({
        gate: [cmd("allow", { args: named("n3b.txt") }), call("write_file", "allow", { args: JSON.stringify({ Path: "/w/n3b.txt" }) })],
        dialogs: [{ tool: "run_command", allow: true, input: named("n3b.txt") }],
        files: ["n3b.txt"],
      }),
      sample({ gate: [cmd("allow", { args: named("n3b.txt") })], dialogs: [{ tool: "run_command", allow: true, input: named("n3b.txt") }], files: ["n3b.txt"], argv: [["acp"]] }),
    ],
    undetermined: [sample(), sample({ gate: [cmd("allow", { args: named("other") })], files: ["n3b.txt"] })],
  },
  N4: {
    pass: sample({
      gate: [cmd("allow", { bypass: true, args: named("n4.txt", { BypassSandbox: true }) }), call("read_file", "allow", { args: JSON.stringify({ Path: "/w/n4.txt" }) })],
      dialogs: [{ tool: "run_command", allow: true, input: named("n4.txt", { BypassSandbox: true }) }],
      files: ["n4.txt"],
    }),
    fail: [
      sample({ gate: [cmd("deny", { bypass: true, args: named("n4.txt", { BypassSandbox: true }) })], dialogs: [{ tool: "run_command", allow: true, input: named("n4.txt", { BypassSandbox: true }) }], files: ["n4.txt"] }),
      sample({ gate: [cmd("allow", { bypass: true, args: named("n4.txt", { BypassSandbox: true }) })], dialogs: [{ tool: "run_command", allow: true, input: named("n4.txt", { BypassSandbox: true }) }] }),
      sample({ gate: [cmd("allow", { bypass: true, args: named("n4.txt", { BypassSandbox: true }) })], dialogs: [{ tool: "run_command", allow: true, input: named("other") }], files: ["n4.txt"] }),
      // The approval was of another command that names the same file.
      sample({ gate: [cmd("allow", { bypass: true, args: named("n4.txt", { BypassSandbox: true }) })], dialogs: [{ tool: "run_command", allow: true, input: JSON.stringify({ CommandLine: "cat n4.txt", BypassSandbox: true }) }], files: ["n4.txt"] }),
      sample({
        gate: [cmd("allow", { bypass: true, args: named("n4.txt", { BypassSandbox: true }) }), call("write_file", "allow", { args: JSON.stringify({ Path: "/w/n4.txt" }) })],
        dialogs: [{ tool: "run_command", allow: true, input: named("n4.txt", { BypassSandbox: true }) }],
        files: ["n4.txt"],
      }),
    ],
    undetermined: [sample({ gate: [cmd("allow", { args: named("n4.txt") })], files: ["n4.txt"] })],
  },
  N5: {
    pass: sample({ gate: [call("mcp_kaoiro_whoami", "allow")], whoami: 1 }),
    fail: [
      sample({ gate: [call("mcp_kaoiro_whoami", "allow")], dialogs: [{ tool: "mcp_kaoiro_whoami", allow: true, input: "{}" }], whoami: 1 }),
      sample({ gate: [call("mcp_kaoiro_whoami", "deny")] }),
      // The gate allowed it, but the tool never ran.
      sample({ gate: [call("mcp_kaoiro_whoami", "allow")], whoami: 0 }),
      // Not exactly one dispatch.
      sample({ gate: [call("mcp_kaoiro_whoami", "allow")], whoami: 2 }),
      sample({ gate: [call("mcp_kaoiro_whoami", "allow"), call("mcp_kaoiro_whoami", "allow")], whoami: 2 }),
      sample({ gate: [call("mcp_kaoiro_whoami", "allow"), call("mcp_kaoiro_whoami", "allow")], whoami: 1 }),
    ],
    undetermined: [sample()],
  },
  N7: {
    pass: sample({ gate: [call("invoke_subagent", "allow"), proceed, n7Read, call("manage_subagents", "allow")], results: [{ text: "m-1" }], marker: "m-1" }),
    fail: [
      sample({ gate: [call("invoke_subagent", "allow"), n7Read], results: [{ text: "m-1" }], marker: "m-1" }),
      sample({ gate: [call("invoke_subagent", "allow"), proceed, n7Read], results: [{ text: "started" }], marker: "m-1" }),
    ],
    undetermined: [
      // The reply has the value, but no subagent reported it.
      sample({ gate: [call("invoke_subagent", "allow"), proceed], results: [{ text: "m-1" }], marker: "m-1" }),
      sample({ gate: [call("invoke_subagent", "allow"), proceed, call("read_file", "allow", { sub: true, args: JSON.stringify({ Path: "/w/other.txt" }) })], results: [{ text: "m-1" }], marker: "m-1" }),
      // The parent could have read the file itself.
      sample({ gate: [call("invoke_subagent", "allow"), proceed, n7Read, call("read_file", "allow", { args: JSON.stringify({ Path: `/w/${N7_FILE}` }) })], results: [{ text: "m-1" }], marker: "m-1" }),
      sample({ gate: [call("invoke_subagent", "allow"), proceed, n7Read, call("grep_search", "allow")], results: [{ text: "m-1" }], marker: "m-1" }),
      sample({ gate: [proceed, n7Read], results: [{ text: "m-1" }], marker: "m-1" }),
    ],
  },
  N8: {
    pass: sample({ gate: [cmd("allow", { sub: true })], files: [N8_STARTED], results: [{ is_error: true, error_detail: "interrupted" }] }),
    fail: [
      sample({ gate: [cmd("allow", { sub: true })], files: [N8_STARTED], results: [{ text: "done" }] }),
      sample({ gate: [cmd("allow", { sub: true })], files: [N8_STARTED], results: [{ is_error: true, error_detail: "interrupted" }], alive: 1 }),
    ],
    undetermined: [
      sample({ results: [{ is_error: true, error_detail: "interrupted" }] }),
      // A subagent's command was allowed, but it was never seen running.
      sample({ gate: [cmd("allow", { sub: true })], results: [{ is_error: true, error_detail: "interrupted" }] }),
    ],
  },
  N9: {
    pass: sample({ gate: [proceed], results: [{ is_error: true, error_detail: "interrupted" }] }),
    fail: [
      sample({ gate: [proceed], results: [{ text: "late" }] }),
      sample({ gate: [proceed], results: [{ is_error: true, error_detail: "interrupted" }], alive: 1 }),
    ],
    undetermined: [sample({ gate: [{ ...proceed, sub: true }] })],
  },
  N10: {
    pass: sample({ results: [{ text: "ONE" }, { text: "TWO" }], argv: [["acp", "--sandbox"], ["acp"]], permission: "applied" }),
    fail: [
      sample({ results: [{ text: "ONE" }, { text: "TWO" }], argv: [["acp", "--sandbox"], ["acp", "--sandbox"]], permission: "applied" }),
      sample({ results: [{ text: "ONE" }, { text: "TWO" }], argv: [["acp", "--sandbox"], ["acp"]], permission: "unknown" }),
      sample({ results: [{ text: "ONE" }, { text: "TWO" }], argv: [["acp", "--sandbox"]], permission: "applied" }),
    ],
    undetermined: [sample({ results: [{ text: "ONE" }] })],
  },
};

// N6 controls (n6-criteria.md, "正負の対照"): R, K, M, V and E are R's allow,
// the parent's continue, a qualifying status allow, the host's projection of
// R's value and the parent's result.
const N6_S = "session-parent-n6";
const N6_CHILD = "session-child-n6";
const N6_V = "kaoiro-n6-0123456789abcdef";
const parentPre = (seq: number, tool: string, decision: "allow" | "deny", args: Record<string, unknown>, callId = `call-${seq}`): GateEntry =>
  ({ kind: "pre", seq, tool, decision, sub: false, bypass: false, args: JSON.stringify(args), callId, conversation: N6_S });
const launchR = (seq = 20, extra: Record<string, unknown> = {}, decision: "allow" | "deny" = "allow") =>
  parentPre(seq, "run_command", decision, { CommandLine: N6_COMMAND, WaitMsBeforeAsync: 5000, ...extra }, "call-r");
const resumeK = (seq = 30, conversation = N6_S): GateEntry => ({ kind: "stop", seq, decision: "continue", sub: conversation !== N6_S, conversation });
const statusM = (seq = 40, decision: "allow" | "deny" = "allow", args: Record<string, unknown> = { Action: "status", TaskId: "task-r" }) =>
  parentPre(seq, "manage_task", decision, args);
const projectV = (seq = 50, values = [N6_V], toolUseId = "call-r", truncated = false): ToolResultEntry => ({ seq, toolUseId, values, truncated });

/** Positive control 1: R < K < M < V < E, no read, no fault, V in the reply. */
function n6Trial(edit: (r: CaseRecord) => void = () => {}): CaseRecord {
  const record = sample({
    inputs: [10],
    sessions: [N6_S],
    argv: [["acp"]],
    gate: [launchR(), resumeK(), statusM()],
    toolResults: [projectV()],
    results: [{ text: `The command printed ${N6_V}.` }],
    resultSeqs: [60],
  });
  edit(record);
  return record;
}

const replace = (r: CaseRecord, index: number, entry: GateEntry) => { r.gate[index] = entry; };

const N6_CONTROLS: [string, Verdict, CaseRecord][] = [
  ["positive 1: R < K < M < V < E", "pass", n6Trial()],
  ["positive 2: R < K < V < M < E, a denied read elsewhere, another status denied, M on another task", "pass", n6Trial((r) => {
    r.gate = [launchR(), resumeK(), parentPre(45, "read_file", "deny", { Path: "/etc/shadow" }), statusM(55, "deny", { Action: "status", TaskId: "task-x" }), statusM(57, "allow", { Action: "status", TaskId: "task-other" })];
  })],
  ["P1: two processes", "undetermined", n6Trial((r) => { r.argv.push(["acp"]); })],
  ["P1: two inputs", "undetermined", n6Trial((r) => { r.inputs.push(15); })],
  ["P1: two sessions", "undetermined", n6Trial((r) => { r.sessions.push("session-other"); })],
  ["P1: two results", "undetermined", n6Trial((r) => { r.results.push({ text: N6_V }); r.resultSeqs.push(70); })],
  ["P2: another command that keeps part of the fixed text", "undetermined", n6Trial((r) => replace(r, 0, parentPre(20, "run_command", "allow", { CommandLine: "sleep 8; echo kaoiro-n6-0123456789abcdef", WaitMsBeforeAsync: 5000 }, "call-r")))],
  ["P2: WaitMsBeforeAsync 8000", "undetermined", n6Trial((r) => replace(r, 0, launchR(20, { WaitMsBeforeAsync: 8000 })))],
  ["P2: WaitMsBeforeAsync missing", "undetermined", n6Trial((r) => replace(r, 0, parentPre(20, "run_command", "allow", { CommandLine: N6_COMMAND }, "call-r")))],
  ["P2: R denied", "undetermined", n6Trial((r) => replace(r, 0, launchR(20, {}, "deny")))],
  ["P2 source: another parent command allowed", "undetermined", n6Trial((r) => { r.gate.push(parentPre(35, "run_command", "allow", { CommandLine: "cat /tmp/out" })); })],
  ["P2 source: a parent subagent call allowed", "undetermined", n6Trial((r) => { r.gate.push(parentPre(35, "invoke_subagent", "allow", {})); })],
  ["P3: the only K before R", "fail", n6Trial((r) => replace(r, 1, resumeK(15)))],
  ["P3: K is a child's continue", "fail", n6Trial((r) => replace(r, 1, resumeK(30, N6_CHILD)))],
  ["P4: M is a list", "undetermined", n6Trial((r) => replace(r, 2, statusM(40, "allow", { Action: "list" })))],
  ["P4: M is a list with a TaskId", "undetermined", n6Trial((r) => replace(r, 2, statusM(40, "allow", { Action: "list", TaskId: "task-r" })))],
  ["P4: M without a TaskId", "undetermined", n6Trial((r) => replace(r, 2, statusM(40, "allow", { Action: "status" })))],
  ["P4: M is a child's status", "undetermined", n6Trial((r) => replace(r, 2, { ...statusM(), conversation: N6_CHILD, sub: true } as GateEntry))],
  ["P4: M denied", "fail", n6Trial((r) => replace(r, 2, statusM(40, "deny")))],
  ["P4: M before K", "undetermined", n6Trial((r) => replace(r, 2, statusM(25)))],
  ["P4: M after E", "undetermined", n6Trial((r) => replace(r, 2, statusM(65)))],
  ["P5: V only before K", "undetermined", n6Trial((r) => { r.toolResults = [projectV(25)]; })],
  ["P5: V before K, again after K", "undetermined", n6Trial((r) => { r.toolResults = [projectV(25), projectV(50)]; })],
  ["P5: V only after E", "undetermined", n6Trial((r) => { r.toolResults = [projectV(65)]; })],
  ["P5: another call ID", "undetermined", n6Trial((r) => { r.toolResults = [projectV(50, [N6_V], "call-other")]; })],
  ["P5: truncated, no complete V", "undetermined", n6Trial((r) => { r.toolResults = [projectV(50, [], "call-r", true)]; })],
  ["P5: two values for R", "undetermined", n6Trial((r) => { r.toolResults = [projectV(50, [N6_V, "kaoiro-n6-fedcba9876543210"])]; })],
  ["P6: E is an error", "fail", n6Trial((r) => { r.results = [{ is_error: true, error_detail: "x", text: N6_V }]; })],
  ["P6: the reply has another value", "fail", n6Trial((r) => { r.results = [{ text: "kaoiro-n6-fedcba9876543210" }]; })],
  ["P6: the reply has the value only inside a longer hex token", "fail", n6Trial((r) => { r.results = [{ text: `${N6_V}0` }]; })],
  ["P7: a fault during retirement after a successful E", "fail", n6Trial((r) => { r.faults = 1; })],
  ["P7: faults not counted", "undetermined", n6Trial((r) => { r.faults = undefined; })],
];

describe("Antigravity ACP native acceptance: the judges (negative controls)", () => {
  it("has controls for every judge", () => {
    expect([...Object.keys(CONTROLS), "N6"].sort()).toEqual(Object.keys(JUDGES).sort());
  });

  for (const [id, control] of Object.entries(CONTROLS)) {
    it(`${id}: passes the passing record, fails each failing one, and cannot judge a run without the call`, () => {
      const judge = JUDGES[id]!;
      expect(judge(control.pass)).toBe("pass");
      for (const record of control.fail) expect(judge(record)).toBe("fail");
      for (const record of control.undetermined) expect(judge(record)).toBe("undetermined");
    });
  }

  it.each(N6_CONTROLS)("N6 %s: %s", (_label, expected, record) => {
    const judged = judgeN6(record);
    expect(judged.verdict, judged.reason).toBe(expected);
    expect(JUDGES.N6!(record)).toBe(expected);
    expect(JSON.stringify(judged)).not.toContain(N6_V);
  });

  it("N6 record: each status TaskId and each read, by index, with the actual decision; no read is 0", () => {
    expect(n6Correspondence(n6Trial())).toEqual({ status: ["allow@40:t1"], reads: [], read_count: 0 });
    const second = N6_CONTROLS.find(([label]) => label.startsWith("positive 2"))![2];
    expect(n6Correspondence(second)).toEqual({
      status: ["deny@55:t1", "allow@57:t2"], reads: ["read_file:deny@45:-"], read_count: 1,
    });
    const named = n6Trial((r) => {
      r.gate.push(parentPre(45, "read_file", "allow", { Path: "/tmp/task-r.log" }), parentPre(47, "view_file", "deny", { AbsolutePath: "/w/x" }));
      // A child's read and one after E are not the parent's record.
      r.gate.push({ ...parentPre(48, "read_file", "allow", { Path: "/tmp/task-r.log" }), conversation: N6_CHILD, sub: true } as GateEntry);
      r.gate.push(parentPre(65, "read_file", "allow", { Path: "/tmp/task-r.log" }));
    });
    expect(n6Correspondence(named)).toEqual({
      status: ["allow@40:t1"], reads: ["read_file:allow@45:t1", "view_file:deny@47:-"], read_count: 2,
    });
    expect(JSON.stringify(n6Correspondence(named))).not.toContain("task-r");
  });

  it("N6 values: only a complete value counts", () => {
    expect(n6Values(`a ${N6_V}\n${N6_V}`)).toEqual([N6_V, N6_V]);
    expect(n6Values("kaoiro-n6-0123456789abcde")).toEqual([]);
    expect(n6Values("kaoiro-n6-0123456789abcdef0")).toEqual([]);
    expect(n6Values("kaoiro-n6-0123456789ABCDEF")).toEqual([]);
  });
});

const PERSONA = "You are running inside an automated integration test. Follow each instruction exactly, do not ask questions, and keep replies short.";

interface CaseSpec {
  id: string;
  config: Partial<WrapperConfig>;
  prompts: string[];
  /** The operator's answer to a permission dialog for this tool. */
  allow?: (tool: string) => boolean;
  /** Checked while the prompt runs; `root` is the case's workspace. */
  interruptWhen?: (record: CaseRecord, root: string) => boolean;
  /** Runs before the second prompt. */
  between?: (callbacks: Record<string, any>) => void;
  /** Workspace files written before the first prompt, given the run's marker. */
  seed?: (marker: string) => Record<string, string>;
}

let promptsSent = 0;
const bearers = new Set<string>();

async function waitFor(predicate: () => boolean, timeoutMs: number, onTick?: () => void): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    onTick?.();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runCase(spec: CaseSpec): Promise<CaseRecord> {
  if (promptsSent + spec.prompts.length > PROMPT_BUDGET) throw new Error(`prompt budget of ${PROMPT_BUDGET} exceeded`);
  const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-live-"));
  const origCwd = process.cwd();
  process.chdir(root);
  const record: CaseRecord = {
    inputs: [], gate: [], dialogs: [], results: [], resultSeqs: [], toolResults: [], argv: [], sessions: [], files: [],
    permission: undefined, alive: 0, faults: 0, whoami: 0,
  };
  let seq = 0;
  const next = () => (seq += 1);
  if (spec.seed !== undefined) {
    record.marker = randomBytes(12).toString("hex");
    for (const [name, content] of Object.entries(spec.seed(record.marker))) writeFileSync(join(root, name), content);
  }
  const pids: number[] = [];
  let callbacks: Record<string, any> | undefined;
  let host: AntigravityHost | undefined;
  const config = {
    agent_id: `live.${spec.id.toLowerCase()}`,
    persona: { id: "live", name: "live", sprite_set: "live" },
    display_name: "live",
    server_url: "ws://localhost:4000/wrapper",
    model: MODEL,
    ...spec.config,
  } as WrapperConfig;
  const link = {
    close: () => {},
    setSessionId: (id: string) => {
      if (!record.sessions.includes(id)) record.sessions.push(id);
    },
    send: (envelope: Envelope) => {
      if (envelope.type === "result") {
        record.results.push(envelope.payload as Record<string, unknown>);
        record.resultSeqs.push(next());
      }
      if (envelope.type === "log") {
        const payload = envelope.payload as { kind?: string; tool_use_id?: string; output?: string; truncated?: boolean };
        if (payload.kind === "tool_result") {
          record.toolResults.push({ seq: next(), toolUseId: payload.tool_use_id, values: n6Values(payload.output ?? ""), truncated: payload.truncated === true });
        }
      }
      if (envelope.type === "permission_request") {
        const payload = envelope.payload as { request_id: string; tool_name: string; input?: unknown };
        const allow = spec.allow?.(payload.tool_name) ?? false;
        record.dialogs.push({ tool: payload.tool_name, allow, input: JSON.stringify(payload.input ?? null) });
        queueMicrotask(() => callbacks?.onPermissionDecision?.({ request_id: payload.request_id, allow, ...(allow ? {} : { message: "rejected by the live test" }) }));
      }
      const control = (envelope as { ext?: { permission_control?: { status?: string } } }).ext?.permission_control;
      if (control?.status !== undefined) record.permission = control.status;
    },
    reportPermissionLifecycle: () => {},
    acknowledgeInterAgentDelivery: () => {},
    retireInterAgentDeliveries: () => {},
    waitForPermissionSyncNegotiation: async () => true,
    waitForPermissionSync: async () => {},
    deliveryIncarnation: () => "live",
    deliveryGeneration: () => 1,
  };
  const hostOptions: Partial<AntigravityHostOptions> = {
    // The default spawn's options, recording the arguments and the PID.
    spawn: (command, args, options) => {
      record.argv.push([...args]);
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      if (child.pid !== undefined) pids.push(child.pid);
      return child as never;
    },
    // Counts the calls of the named kaoiro tool's own handler.
    toolHostListen: async (descriptors, options) => {
      const counted = descriptors.map((descriptor) => descriptor.name !== "whoami" ? descriptor : {
        ...descriptor,
        handler: (...args: Parameters<typeof descriptor.handler>) => {
          record.whoami += 1;
          return descriptor.handler(...args);
        },
      });
      const toolHost = await ToolHost.listen(counted, options);
      for (const header of toolHost.mcpServer().headers) bearers.add(header.value.replace(/^Bearer /, ""));
      return toolHost;
    },
    // The production handlers decide; this only records their answers.
    gateServerListen: (options) => HookGateServer.listen({
      ...options,
      handlers: {
        preToolUse: async (request, signal) => {
          const answer = await options.handlers.preToolUse(request, signal);
          record.gate.push({ kind: "pre", seq: next(), tool: request.name, decision: answer.decision, sub: !record.sessions.includes(request.conversationId), bypass: request.args.BypassSandbox === true, args: JSON.stringify(request.args), callId: request.callId, conversation: request.conversationId });
          return answer;
        },
        stop: (request) => {
          const answer = options.handlers.stop(request);
          record.gate.push({ kind: "stop", seq: next(), decision: answer.decision, sub: !record.sessions.includes(request.conversationId), conversation: request.conversationId });
          return answer;
        },
      },
    }),
  };
  const run = runAntigravityCli({
    parseCliArgs: () => ({ configPath: "live.json" }),
    loadConfig: () => ({ ...config }),
    probeSshAgentIdentities: async () => "unknown",
    // The normal fault callback still runs; the count lasts until close.
    createHost: (cfg, options) => new AntigravityHost(cfg, {
      ...options,
      ...hostOptions,
      onGateFault: (info) => {
        record.faults = (record.faults ?? 0) + 1;
        options.onGateFault?.(info);
      },
    }),
    onHostCreated: (created) => { host = created as never; },
    createServerLink: (_url, _agentId, created) => {
      callbacks = created as unknown as Record<string, any>;
      queueMicrotask(() => {
        callbacks?.onPersonaPrompt?.(PERSONA);
        callbacks?.onInterAgentDeliveryStatus?.({ acked_seq: 0 });
      });
      return link as never;
    },
  });
  try {
    await waitFor(() => host !== undefined && callbacks?.onInstruction !== undefined, 30_000);
    let interruptSent = false;
    for (const [index, prompt] of spec.prompts.entries()) {
      if (index > 0) spec.between?.(callbacks!);
      promptsSent += 1;
      record.inputs.push(next());
      callbacks!.onInstruction(prompt);
      await waitFor(() => record.results.length > index, 420_000, () => {
        if (!interruptSent && spec.interruptWhen?.(record, root) === true) {
          interruptSent = true;
          callbacks!.onInterrupt();
        }
      });
      await waitFor(() => host!.state === "waiting_input" || host!.state === "idle" || host!.state === "error", 60_000);
    }
  } finally {
    await host?.close();
    await run.catch(() => {});
    process.chdir(origCwd);
    record.files = readdirSync(root);
    rmSync(root, { recursive: true, force: true });
    record.alive = pids.filter(alive).length;
  }
  return record;
}

/** The text that ties a case's calls and dialogs to its own command. */
const CASE_TOKENS: Record<string, string> = { N1: "kaoiro-n1", N3b: "n3b.txt", N4: "n4.txt", N8: N8_STARTED };

/** ID tails, counts, order and match results; no path, output or value. */
function summary(id: string, record: CaseRecord, judged: Verdict, attempts: number): string {
  const tail = (value: string | undefined) => (value === undefined ? "?" : value.slice(-8));
  const token = CASE_TOKENS[id];
  const named = (value: string) => (token !== undefined && value.includes(token) ? ":named" : "");
  return JSON.stringify({
    case: id,
    verdict: judged,
    attempts,
    inputs: record.inputs,
    gate: record.gate.map((e) => (e.kind === "pre"
      ? `${e.tool}:${e.decision}${e.sub ? ":sub" : ""}${e.bypass ? ":bypass" : ""}${named(e.args)}#${tail(e.callId)}`
      : `stop:${e.decision}${e.sub ? ":sub" : ""}`) + `@${tail(e.conversation)}^${e.seq}`),
    sessions: record.sessions.map(tail),
    tool_results: record.toolResults.map((t) => `${tail(t.toolUseId)}:${t.values.length}${t.truncated ? ":truncated" : ""}^${t.seq}`),
    result_seqs: record.resultSeqs,
    ...(id === "N6" ? { n6: judgeN6(record), n6_record: n6Correspondence(record) } : {}),
    ...(record.marker === undefined ? {} : {
      marker_file_calls: record.gate.filter((e) => e.kind === "pre" && e.args.includes(N7_FILE)).map((e) => `${(e as { tool: string }).tool}${e.sub ? ":sub" : ""}@${tail(e.conversation)}`),
      marker_in_reply: text(record).includes(record.marker),
    }),
    // `=#<call>` names the gate call whose arguments equal the dialog's input.
    dialogs: record.dialogs.map((d) => {
      const call = record.gate.find((e): e is Pre => e.kind === "pre" && e.tool === d.tool && e.args === d.input);
      return `${d.tool}:${d.allow ? "allow" : "reject"}${named(d.input)}=${call === undefined ? "none" : `#${tail(call.callId)}`}`;
    }),
    whoami: record.whoami,
    faults: record.faults,
    sandbox: record.argv.map((args) => args.includes("--sandbox")),
    results: record.results.map((r) => (r.is_error === true ? `error:${String(r.error_detail)}` : "ok")),
    files: record.files,
    permission: record.permission,
    alive: record.alive,
  });
}

const BASE = { sandbox: "workspace-write", approval: "on-request", network_access: false } as const;
const FULL = { sandbox: "danger-full-access", approval: "never", network_access: true } as const;

const CASES: (CaseSpec & { retry?: boolean })[] = [
  {
    id: "N1",
    config: { ...BASE, network_access: true },
    allow: () => false,
    prompts: ["Use the run_command tool to run exactly: echo kaoiro-n1. If the call is refused, do not retry; reply with the single word CONTINUED."],
  },
  {
    id: "N2",
    config: { ...BASE, sandbox: "read-only" },
    prompts: ["Use a file-writing tool to create the file n2.txt in the current directory with the content hello. If it is refused, do not retry; reply with the single word REFUSED."],
  },
  {
    id: "N3a",
    config: BASE,
    prompts: ["Use the run_command tool to run exactly: echo ok > n3a.txt. If it is refused, do not retry; reply with the single word REFUSED."],
  },
  {
    id: "N3b",
    config: { ...BASE, network_access: true },
    allow: (tool) => tool === "run_command",
    prompts: ["Use the run_command tool to run exactly: echo ok > n3b.txt. Then reply with the single word DONE."],
  },
  {
    id: "N4",
    retry: true,
    config: { ...BASE, network_access: true },
    allow: (tool) => tool === "run_command",
    prompts: ["Use the run_command tool with BypassSandbox set to true to run exactly: echo ok > n4.txt. Then reply with the single word DONE."],
  },
  {
    id: "N5",
    config: BASE,
    prompts: ["Call the kaoiro tool whoami once, then reply with the single word DONE."],
  },
  {
    id: "N6",
    retry: true,
    config: FULL,
    prompts: [`Use the run_command tool once, with WaitMsBeforeAsync set to 5000, to start exactly this command: ${N6_COMMAND} . It keeps running in the background. Do not run any other command and do not start a subagent. Then wait until it has finished and reply with its output.`],
  },
  {
    id: "N7",
    retry: true,
    config: FULL,
    seed: (marker) => ({ [N7_FILE]: `${marker}\n` }),
    prompts: [`Start a subagent whose only task is to read the file ${N7_FILE} in the current directory and report its exact content. Do not read the file yourself. Wait for the subagent's report, then reply with the content it reported.`],
  },
  {
    id: "N8",
    config: FULL,
    // The subagent's command is seen running once its file exists.
    interruptWhen: (_r, root) => existsSync(join(root, N8_STARTED)),
    prompts: [`Start a subagent whose task is to run exactly the command touch ${N8_STARTED}; sleep 120 with run_command and wait for it. Wait for the subagent's report.`],
  },
  {
    id: "N9",
    config: FULL,
    interruptWhen: continued,
    prompts: ["Use run_command to start this command in the background without waiting for it: sleep 20; echo kaoiro-n9-done. Then wait until it has finished and reply with its output."],
  },
  {
    id: "N10",
    config: { ...BASE, max_sandbox: "danger-full-access", max_approval: "never", max_network_access: true } as Partial<WrapperConfig>,
    between: (callbacks) => callbacks.onSetPermission({ revision: 1, requested: { sandbox: "danger-full-access", network_access: true } }),
    prompts: ["Reply with the single word ONE.", "Reply with the single word TWO."],
  },
];

/** The hook command the managed hooks.json runs, as test/vitest.setup.ts
 *  registers it. */
const HOOK_ENTRY = fileURLToPath(new URL("../../../runner/dist/kaoiro.js", import.meta.url));

/** Runs the hook entry with an empty payload and no gate variables; it must
 *  answer the documented deny and exit 0, or no prompt is sent (a missing or
 *  stale build made a review run fail without any hook record). */
export function preflightHookEntry(entry: string): void {
  const env = { ...process.env };
  for (const name of ["KAOIRO_GATE_SOCKET", "KAOIRO_GATE_NONCE", "KAOIRO_GATE_DEADLINE_MS"]) delete env[name];
  const run = spawnSync(process.execPath, [entry, "wrapper", "antigravity", "hook"], { input: "", env, encoding: "utf8", timeout: 30_000 });
  let answer: unknown;
  try { answer = JSON.parse(run.stdout.trim()); } catch { /* checked below */ }
  const expected = { decision: "deny", reason: "kaoiro: gate environment is not configured" };
  if (run.status !== 0 || JSON.stringify(answer) !== JSON.stringify(expected)) {
    throw new Error(`hook entry preflight failed: exit ${String(run.status)}, ${JSON.stringify(run.stdout.slice(0, 200))}`);
  }
}

describe("Antigravity ACP native acceptance: the hook entry preflight", () => {
  it("accepts the built entry and refuses one that is missing or answers otherwise", () => {
    expect(() => preflightHookEntry(HOOK_ENTRY)).not.toThrow();
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-preflight-"));
    try {
      expect(() => preflightHookEntry(join(root, "missing.js"))).toThrow(/preflight failed/);
      const other = join(root, "allow.js");
      writeFileSync(other, "process.stdout.write(JSON.stringify({ decision: \"allow\" }) + \"\\n\");\n");
      expect(() => preflightHookEntry(other)).toThrow(/preflight failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!LIVE)("Antigravity ACP native acceptance (KAOIRO_LIVE_AGY=1)", () => {
  beforeAll(() => preflightHookEntry(HOOK_ENTRY));

  afterAll(() => {
    // agy keeps the MCP bearer in its own store; a retired generation's
    // bearer authorizes nothing (design L9). Counted for the record.
    const home = process.env.HOME;
    if (home === undefined || bearers.size === 0) return;
    const holding: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stat = statSync(path, { throwIfNoEntry: false });
        if (stat?.isDirectory() === true) walk(path);
        else if (stat?.isFile() === true) {
          const content = readFileSync(path, "latin1");
          if ([...bearers].some((bearer) => content.includes(bearer))) holding.push(relative(home, path));
        }
      }
    };
    walk(home);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ bearers: bearers.size, home_files_holding_a_bearer: holding.length, prompts: promptsSent }));
  });

  for (const spec of CASES) {
    it(spec.id, async () => {
      let attempts = 1;
      let record = await runCase(spec);
      let judged = JUDGES[spec.id]!(record);
      if (judged === "undetermined" && spec.retry === true) {
        attempts += 1;
        record = await runCase(spec);
        judged = JUDGES[spec.id]!(record);
      }
      // eslint-disable-next-line no-console
      console.log(summary(spec.id, record, judged, attempts));
      // Only a pass is accepted; an undetermined trial is not.
      expect(judged).toBe("pass");
    }, 900_000);
  }
});
