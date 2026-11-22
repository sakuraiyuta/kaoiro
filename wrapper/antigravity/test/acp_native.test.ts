import { permitHostAccess } from "../../../scripts/test/fixtures/test-isolation.mjs";

// Opt-in native acceptance of the ACP host (design r14 section 8): the
// production CLI with a stand-in server link drives the real `agy` against a
// real provider. Run with KAOIRO_LIVE_AGY=1, `agy` on PATH and its credentials
// in the environment:
//   KAOIRO_LIVE_AGY=1 pnpm exec vitest run test/acp_native.test.ts
// The verdicts come from the gate, operator-dialog, wire and workspace
// records, never from the model's prose. The judges' negative controls run
// without the opt-in.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

/** `conversation` is the tail of the request's conversation ID, for the
 *  printed record. */
type GateEntry =
  /** `args` is the request's arguments as JSON; it is never printed. */
  | { kind: "pre"; tool: string; decision: "allow" | "deny"; sub: boolean; bypass: boolean; args: string; conversation?: string }
  | { kind: "stop"; decision: "continue" | "stop"; sub: boolean; conversation?: string };

export interface CaseRecord {
  gate: GateEntry[];
  dialogs: { tool: string; allow: boolean }[];
  results: Record<string, unknown>[];
  argv: string[][];
  files: string[];
  permission: string | undefined;
  /** Spawned `agy` processes still alive after the case closed. */
  alive: number;
  /** A random value the case placed in a workspace file and never in a prompt. */
  marker?: string;
  /** Tails of the session IDs the host attached to. */
  sessions?: string[];
}

export type Verdict = "pass" | "fail" | "undetermined";

const pre = (r: CaseRecord, tool: RegExp) =>
  r.gate.filter((e): e is Extract<GateEntry, { kind: "pre" }> => e.kind === "pre" && tool.test(e.tool));
const continued = (r: CaseRecord) => r.gate.some((e) => e.kind === "stop" && !e.sub && e.decision === "continue");
const succeeded = (result: Record<string, unknown> | undefined) => result !== undefined && result.is_error !== true;
const interrupted = (r: CaseRecord) => r.results.at(-1)?.error_detail === "interrupted";
const text = (r: CaseRecord) => String(r.results.at(-1)?.text ?? "");
const sandboxed = (args: string[]) => args.includes("--sandbox");
const verdict = (seen: boolean, ok: boolean): Verdict => (!seen ? "undetermined" : ok ? "pass" : "fail");
const N7_FILE = "n7.txt";
/** Read-class tools that wait or report task state and reach no file. */
const WAITING_TOOLS = new Set(["manage_task", "command_status", "wait", "wait_5_seconds", "finish"]);
/** A parent call that could have read a workspace file itself. */
const parentCouldRead = (e: GateEntry) =>
  e.kind === "pre" && !e.sub && e.decision === "allow" && !e.tool.startsWith("mcp_kaoiro_") &&
  !WAITING_TOOLS.has(e.tool) && TOOL_CLASS_BY_NAME.get(e.tool) !== "subagent";
/** A parent call matching `tool` after the parent's first Stop continue. */
const afterContinue = (r: CaseRecord, tool: RegExp) => {
  const first = r.gate.findIndex((e) => e.kind === "stop" && !e.sub && e.decision === "continue");
  return first !== -1 && r.gate.slice(first + 1).some((e) => e.kind === "pre" && !e.sub && e.decision === "allow" && tool.test(e.tool));
};

/** One judge per case: undetermined when the model never made the call the
 *  case needs, otherwise pass or fail on the records. */
export const JUDGES: Record<string, (r: CaseRecord) => Verdict> = {
  // An operator rejection is a hook deny with a reason; the turn goes on.
  N1: (r) => {
    const calls = pre(r, /^run_command$/);
    return verdict(calls.length > 0, r.dialogs.some((d) => !d.allow) && calls.every((c) => c.decision === "deny") && succeeded(r.results.at(-1)));
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
  // With the network on, the operator approves and the command runs under --sandbox.
  N3b: (r) => {
    const calls = pre(r, /^run_command$/);
    return verdict(calls.length > 0, r.dialogs.some((d) => d.tool === "run_command" && d.allow) && calls.some((c) => c.decision === "allow") && r.files.includes("n3b.txt") && r.argv.length > 0 && r.argv.every(sandboxed));
  },
  // BypassSandbox asks like the shell row; approved, it runs.
  N4: (r) => {
    const calls = pre(r, /^run_command$/).filter((c) => c.bypass);
    return verdict(calls.length > 0, r.dialogs.some((d) => d.allow) && calls.some((c) => c.decision === "allow") && r.files.includes("n4.txt"));
  },
  // A kaoiro tool is allowed by the gate with no operator dialog.
  N5: (r) => {
    const calls = pre(r, /^mcp_kaoiro_whoami$/);
    return verdict(calls.length > 0, calls.every((c) => c.decision === "allow") && r.dialogs.length === 0 && succeeded(r.results.at(-1)));
  },
  // The Stop hook holds the prompt until a background command's output
  // reaches the reply. A reply without the parent reading the task after a
  // continue does not show where its text came from.
  N6: (r) => {
    if (pre(r, /^run_command$/).length === 0) return "undetermined";
    if (!continued(r)) return "fail";
    if (!afterContinue(r, /^(manage_task|read_file)$/)) return "undetermined";
    return succeeded(r.results.at(-1)) && text(r).includes("kaoiro-n6-done") ? "pass" : "fail";
  },
  // A subagent's report reaches the reply while the prompt is held: the
  // subagent read the marker file, the parent could not, and the reply has it.
  N7: (r) => {
    const started = pre(r, /subagent/).some((c) => !c.sub && c.decision === "allow");
    const reported = r.gate.some((e) => e.kind === "pre" && e.sub && e.decision === "allow" && e.args.includes(N7_FILE));
    const marker = r.marker;
    const seen = started && reported && !r.gate.some(parentCouldRead) && marker !== undefined;
    return verdict(seen, marker !== undefined && continued(r) && succeeded(r.results.at(-1)) && text(r).includes(marker));
  },
  // An interrupt while a subagent runs ends the turn and every process.
  N8: (r) => verdict(r.gate.some((e) => e.sub), interrupted(r) && r.alive === 0),
  // An interrupt while the Stop hook holds the prompt ends the turn and every process.
  N9: (r) => verdict(continued(r), interrupted(r) && r.alive === 0),
  // A permission switch: the second turn runs on a new process without --sandbox, applied.
  N10: (r) => verdict(r.results.length === 2, r.argv.length === 2 && sandboxed(r.argv[0]!) && !sandboxed(r.argv[1]!) && r.permission === "applied" && r.results.every(succeeded)),
};

function sample(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return { gate: [], dialogs: [], results: [{ text: "ok" }], argv: [["acp", "--sandbox"]], files: [], permission: undefined, alive: 0, ...overrides };
}

const call = (tool: string, decision: "allow" | "deny", extra: Partial<Extract<GateEntry, { kind: "pre" }>> = {}): GateEntry =>
  ({ kind: "pre", tool, decision, sub: false, bypass: false, args: "{}", ...extra });
const cmd = (decision: "allow" | "deny", extra: Partial<Extract<GateEntry, { kind: "pre" }>> = {}): GateEntry => call("run_command", decision, extra);
const proceed: GateEntry = { kind: "stop", decision: "continue", sub: false };
const n7Read = call("read_file", "allow", { sub: true, args: JSON.stringify({ Path: `/w/${N7_FILE}` }) });

/** Per judge: a passing record, records that must fail, and records it
 *  cannot judge. */
const CONTROLS: Record<string, { pass: CaseRecord; fail: CaseRecord[]; undetermined: CaseRecord[] }> = {
  N1: {
    pass: sample({ gate: [cmd("deny")], dialogs: [{ tool: "run_command", allow: false }] }),
    fail: [
      sample({ gate: [cmd("allow")], dialogs: [{ tool: "run_command", allow: false }] }),
      sample({ gate: [cmd("deny")], dialogs: [] }),
      sample({ gate: [cmd("deny")], dialogs: [{ tool: "run_command", allow: false }], results: [{ is_error: true }] }),
    ],
    undetermined: [sample()],
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
      sample({ gate: [cmd("deny")], dialogs: [{ tool: "run_command", allow: false }] }),
      sample({ gate: [cmd("deny")], files: ["n3a.txt"] }),
      sample({ gate: [cmd("deny")], argv: [["acp"]] }),
    ],
    undetermined: [sample()],
  },
  N3b: {
    pass: sample({ gate: [cmd("allow")], dialogs: [{ tool: "run_command", allow: true }], files: ["n3b.txt"] }),
    fail: [
      sample({ gate: [cmd("allow")], dialogs: [], files: ["n3b.txt"] }),
      sample({ gate: [cmd("allow")], dialogs: [{ tool: "run_command", allow: true }] }),
      sample({ gate: [cmd("allow")], dialogs: [{ tool: "run_command", allow: true }], files: ["n3b.txt"], argv: [["acp"]] }),
    ],
    undetermined: [sample()],
  },
  N4: {
    pass: sample({ gate: [cmd("allow", { bypass: true })], dialogs: [{ tool: "run_command", allow: true }], files: ["n4.txt"] }),
    fail: [
      sample({ gate: [cmd("deny", { bypass: true })], dialogs: [{ tool: "run_command", allow: true }], files: ["n4.txt"] }),
      sample({ gate: [cmd("allow", { bypass: true })], dialogs: [{ tool: "run_command", allow: true }] }),
    ],
    undetermined: [sample({ gate: [cmd("allow")], files: ["n4.txt"] })],
  },
  N5: {
    pass: sample({ gate: [call("mcp_kaoiro_whoami", "allow")] }),
    fail: [
      sample({ gate: [call("mcp_kaoiro_whoami", "allow")], dialogs: [{ tool: "mcp_kaoiro_whoami", allow: true }] }),
      sample({ gate: [call("mcp_kaoiro_whoami", "deny")] }),
    ],
    undetermined: [sample()],
  },
  N6: {
    pass: sample({ gate: [cmd("allow"), proceed, call("manage_task", "allow"), call("read_file", "allow"), proceed], results: [{ text: "kaoiro-n6-done" }] }),
    fail: [
      sample({ gate: [cmd("allow"), call("manage_task", "allow")], results: [{ text: "kaoiro-n6-done" }] }),
      sample({ gate: [cmd("allow"), proceed, call("manage_task", "allow")], results: [{ text: "waiting" }] }),
    ],
    undetermined: [
      sample(),
      // Held, but the parent never read the task: the reply may echo the prompt.
      sample({ gate: [cmd("allow"), proceed], results: [{ text: "kaoiro-n6-done" }] }),
      sample({ gate: [cmd("allow"), call("read_file", "allow"), proceed], results: [{ text: "kaoiro-n6-done" }] }),
    ],
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
    pass: sample({ gate: [cmd("allow", { sub: true })], results: [{ is_error: true, error_detail: "interrupted" }] }),
    fail: [
      sample({ gate: [cmd("allow", { sub: true })], results: [{ text: "done" }] }),
      sample({ gate: [cmd("allow", { sub: true })], results: [{ is_error: true, error_detail: "interrupted" }], alive: 1 }),
    ],
    undetermined: [sample({ results: [{ is_error: true, error_detail: "interrupted" }] })],
  },
  N9: {
    pass: sample({ gate: [{ kind: "stop", decision: "continue", sub: false }], results: [{ is_error: true, error_detail: "interrupted" }] }),
    fail: [
      sample({ gate: [{ kind: "stop", decision: "continue", sub: false }], results: [{ text: "late" }] }),
      sample({ gate: [{ kind: "stop", decision: "continue", sub: false }], results: [{ is_error: true, error_detail: "interrupted" }], alive: 1 }),
    ],
    undetermined: [sample({ gate: [{ kind: "stop", decision: "continue", sub: true }] })],
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

describe("Antigravity ACP native acceptance: the judges (negative controls)", () => {
  it("has controls for every judge", () => {
    expect(Object.keys(CONTROLS).sort()).toEqual(Object.keys(JUDGES).sort());
  });

  for (const [id, control] of Object.entries(CONTROLS)) {
    it(`${id}: passes the passing record, fails each failing one, and cannot judge a run without the call`, () => {
      const judge = JUDGES[id]!;
      expect(judge(control.pass)).toBe("pass");
      for (const record of control.fail) expect(judge(record)).toBe("fail");
      for (const record of control.undetermined) expect(judge(record)).toBe("undetermined");
    });
  }
});

const PERSONA = "You are running inside an automated integration test. Follow each instruction exactly, do not ask questions, and keep replies short.";

interface CaseSpec {
  id: string;
  config: Partial<WrapperConfig>;
  prompts: string[];
  /** The operator's answer to a permission dialog for this tool. */
  allow?: (tool: string) => boolean;
  interruptWhen?: (record: CaseRecord) => boolean;
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
  const record: CaseRecord = { gate: [], dialogs: [], results: [], argv: [], files: [], permission: undefined, alive: 0 };
  if (spec.seed !== undefined) {
    record.marker = randomBytes(12).toString("hex");
    for (const [name, content] of Object.entries(spec.seed(record.marker))) writeFileSync(join(root, name), content);
  }
  const sessions = new Set<string>();
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
    setSessionId: (id: string) => { sessions.add(id); },
    send: (envelope: Envelope) => {
      if (envelope.type === "result") record.results.push(envelope.payload as Record<string, unknown>);
      if (envelope.type === "permission_request") {
        const payload = envelope.payload as { request_id: string; tool_name: string };
        const allow = spec.allow?.(payload.tool_name) ?? false;
        record.dialogs.push({ tool: payload.tool_name, allow });
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
    toolHostListen: async (descriptors, options) => {
      const toolHost = await ToolHost.listen(descriptors, options);
      for (const header of toolHost.mcpServer().headers) bearers.add(header.value.replace(/^Bearer /, ""));
      return toolHost;
    },
    // The production handlers decide; this only records their answers.
    gateServerListen: (options) => HookGateServer.listen({
      ...options,
      handlers: {
        preToolUse: async (request, signal) => {
          const answer = await options.handlers.preToolUse(request, signal);
          record.gate.push({ kind: "pre", tool: request.name, decision: answer.decision, sub: !sessions.has(request.conversationId), bypass: request.args.BypassSandbox === true, args: JSON.stringify(request.args), conversation: request.conversationId.slice(-8) });
          return answer;
        },
        stop: (request) => {
          const answer = options.handlers.stop(request);
          record.gate.push({ kind: "stop", decision: answer.decision, sub: !sessions.has(request.conversationId), conversation: request.conversationId.slice(-8) });
          return answer;
        },
      },
    }),
  };
  const run = runAntigravityCli({
    parseCliArgs: () => ({ configPath: "live.json" }),
    loadConfig: () => ({ ...config }),
    probeSshAgentIdentities: async () => "unknown",
    createHost: (cfg, options) => new AntigravityHost(cfg, { ...options, ...hostOptions }),
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
      callbacks!.onInstruction(prompt);
      await waitFor(() => record.results.length > index, 420_000, () => {
        if (!interruptSent && spec.interruptWhen?.(record) === true) {
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
    record.sessions = [...sessions].map((id) => id.slice(-8));
  }
  return record;
}

function summary(id: string, record: CaseRecord, judged: Verdict, attempts: number): string {
  const last = record.results.at(-1);
  return JSON.stringify({
    case: id,
    verdict: judged,
    attempts,
    gate: record.gate.map((e) => `${e.kind === "pre" ? `${e.tool}:${e.decision}${e.sub ? ":sub" : ""}${e.bypass ? ":bypass" : ""}` : `stop:${e.decision}${e.sub ? ":sub" : ""}`}@${e.conversation ?? "?"}`),
    sessions: record.sessions,
    ...(record.marker === undefined ? {} : {
      marker_file_calls: record.gate.filter((e) => e.kind === "pre" && e.args.includes(N7_FILE)).map((e) => `${(e as { tool: string }).tool}${e.sub ? ":sub" : ""}@${e.conversation ?? "?"}`),
      marker_in_reply: text(record).includes(record.marker),
    }),
    dialogs: record.dialogs.map((d) => `${d.tool}:${d.allow ? "allow" : "reject"}`),
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
    prompts: ["Use run_command to start this command in the background without waiting for it: sleep 8; echo kaoiro-n6-done. Then wait until it has finished and reply with its output."],
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
    interruptWhen: (r) => r.gate.some((e) => e.sub),
    prompts: ["Start a subagent whose task is to run the command sleep 120 with run_command and wait for it. Wait for the subagent's report."],
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

describe.skipIf(!LIVE)("Antigravity ACP native acceptance (KAOIRO_LIVE_AGY=1)", () => {
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
      expect(judged).not.toBe("fail");
    }, 900_000);
  }
});
