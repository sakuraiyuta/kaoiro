import "../../../scripts/test/fixtures/test-isolation.mjs";
// issue #595: a Bash call moved to the background by its timeout, a Workflow
// completion, and XML-escaped notification text. Frame shapes and order copy
// native traces from SDK 0.3.293 / CLI 2.1.293 (paths replaced).

import { describe, expect, it } from "vitest";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentHost } from "../src/host.js";
import type { AgentHostOptions } from "../src/host.js";
import { INTER_AGENT_TOOL_FQN } from "@kaoiro/agent-common";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { completionSummary } from "./fixtures/completion_summaries.js";

const config: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const S = "s1";
const signal = { signal: new AbortController().signal };
const msg = (shape: unknown): SDKMessage => shape as SDKMessage;
let resultIndex = 0;
const result = (extra: Record<string, unknown> = {}): SDKMessage =>
  msg({ type: "result", subtype: "success", session_id: S, result_index: resultIndex++, ...extra });

type QueryFn = NonNullable<AgentHostOptions["queryFn"]>;
type QueryArgs = { prompt: AsyncIterable<SDKUserMessage>; options: Options };

interface Task {
  id: string;
  run?: string | undefined;
  tool: string;
  output: string;
  summary: string;
  session?: string;
}

const BASH: Task = {
  id: "buvd5ljie", run: "0mv7eh1qr-a8f3d566", tool: "toolu_bg", output: "/tmp/run/tasks/buvd5ljie.output",
  summary: "Background command \"printf START; sleep 7; printf OWNED_BG_DONE\" completed (exit code 0)",
};
const WORKFLOW: Task = {
  id: "w72gllf6m", run: "0mv7egycl-dcc7202c", tool: "toolu_wf", output: "/tmp/run/tasks/w72gllf6m.output",
  summary: "Dynamic workflow \"Owned read only workflow\" completed",
};
const AGENT: Task = {
  id: "adf90fb7830efb4c3", run: "0mv7ek0aa-0d1f2e3a", tool: "toolu_agent", output: "/tmp/run/tasks/adf90fb7830efb4c3.output",
  summary: "OWNED <xml> & tail > end",
};

const omit = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

const started = (task: Task, type: string, extra: Record<string, unknown> = {}): SDKMessage => msg(omit({
  type: "system", subtype: "task_started", task_id: task.id, run_id: task.run, tool_use_id: task.tool,
  description: "task", task_type: type, uuid: `start-${task.id}`, session_id: task.session ?? S, ...extra,
}));
const bashStarted = (task: Task, backgrounded: boolean, extra: Record<string, unknown> = {}): SDKMessage =>
  started(task, "local_bash", { is_backgrounded: backgrounded, ...extra });
const workflowStarted = (task: Task, extra: Record<string, unknown> = {}): SDKMessage =>
  started(task, "local_workflow", { workflow_name: "owned-probe", prompt: "export const meta = {};", ...extra });
const agentStarted = (task: Task, backgrounded: boolean): SDKMessage =>
  started(task, "local_agent", { is_backgrounded: backgrounded, subagent_type: "general-purpose" });
const backgroundTasks = (tasks: Array<{ task: Task; type: string }>): SDKMessage => msg({
  type: "system", subtype: "background_tasks_changed", session_id: S, uuid: "bg",
  tasks: tasks.map(({ task, type }) => omit({ task_id: task.id, run_id: task.run, task_type: type, description: "task" })),
});
const updated = (task: Task, patch: Record<string, unknown>, extra: Record<string, unknown> = {}): SDKMessage => msg(omit({
  type: "system", subtype: "task_updated", task_id: task.id, run_id: task.run, patch, uuid: `update-${task.id}`,
  session_id: task.session ?? S, ...extra,
}));
const notified = (task: Task, extra: Record<string, unknown> = {}): SDKMessage => msg(omit({
  type: "system", subtype: "task_notification", task_id: task.id, run_id: task.run, tool_use_id: task.tool,
  status: "completed", output_file: task.output, summary: task.summary, uuid: `note-${task.id}`,
  session_id: task.session ?? S, ...extra,
}));

const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The hook prompt the CLI builds, in its measured field order. */
const notePrompt = (task: Task, fields: { summary?: string; output?: string | null; result?: string; diagnostics?: boolean; id?: string; tool?: string } = {}): string =>
  "<task-notification>\n" +
  `<task-id>${fields.id ?? task.id}</task-id>\n` +
  `<tool-use-id>${fields.tool ?? task.tool}</tool-use-id>\n` +
  (fields.output === null ? "" : `<output-file>${fields.output ?? task.output}</output-file>\n`) +
  "<status>completed</status>\n" +
  `<summary>${fields.summary ?? escape(task.summary)}</summary>\n` +
  (fields.result === undefined ? "" : `<result>${fields.result}</result>\n`) +
  (fields.diagnostics ? "<diagnostics>Per-agent results: /tmp/run/journal.jsonl</diagnostics>\n" : "") +
  "</task-notification>";
const workflowPrompt = (fields: Parameters<typeof notePrompt>[1] = {}): string =>
  notePrompt(WORKFLOW, { result: "{\"ok\":true}", diagnostics: true, ...fields });
const agentPrompt = (task: Task, shownResult: string): string =>
  notePrompt(task, { summary: "Agent \"task\" finished", result: shownResult });

/** The measured Bash promotion: started(false), the level frame,
 * updated(true), a status patch, then the notification. A foreground Bash
 * keeps the turn live and completes with an empty output file. */
const bashPromotion = (task: Task = BASH): SDKMessage[] => [
  bashStarted(task, false),
  backgroundTasks([{ task, type: "local_bash" }]),
  updated(task, { is_backgrounded: true }),
  updated(task, { status: "completed", end_time: 1 }),
  notified(task),
  backgroundTasks([]),
  bashStarted({ ...task, id: "bm930wqnd", run: "0mv7eh5s7-a2636c6f", tool: "toolu_fg" }, false),
  notified({ ...task, id: "bm930wqnd", run: "0mv7eh5s7-a2636c6f", tool: "toolu_fg", output: "", summary: "sleep 4" }),
];

/** The measured Workflow launch: the level frame first, then a start without
 * is_backgrounded, progress, a status patch and the notification. */
const workflowLaunch = (task: Task = WORKFLOW): SDKMessage[] => [
  backgroundTasks([{ task, type: "local_workflow" }]),
  workflowStarted(task),
  msg({ type: "system", subtype: "task_progress", task_id: task.id, run_id: task.run, tool_use_id: task.tool,
    description: "OWNED_WORKFLOW_CHILD", usage: { total_tokens: 0, tool_uses: 0, duration_ms: 1 }, session_id: S, uuid: "progress" }),
];
const workflowDone = (task: Task = WORKFLOW, extra: Record<string, unknown> = {}): SDKMessage[] => [
  updated(task, { status: "completed", end_time: 1 }),
  notified(task, { usage: { total_tokens: 100, tool_uses: 0, duration_ms: 2758 }, ...extra }),
  backgroundTasks([]),
];

interface Outcome {
  starts: Array<{ token: string; kind: string | undefined }>;
  bound: { token?: string } | undefined;
  child: unknown;
  warnings: string[];
}

/** One wrapper turn launches the work. In "fold" mode the notification hook
 * reuses its prompt ID while it is live; in "idle" mode the root turn ends
 * first and the notification opens a fresh prompt ID. `late` frames arrive
 * after that root result. */
async function admit(scenario: {
  mode: "fold" | "idle";
  frames: SDKMessage[];
  late?: SDKMessage[];
  prompt: string;
  promptSession?: string;
  hooks?: number;
}): Promise<Outcome> {
  const outcome: Outcome = { starts: [], bound: undefined, child: undefined, warnings: [] };
  let host!: AgentHost;
  let bound: Promise<{ token?: string } | undefined> | undefined;
  let child: Promise<unknown> | undefined;
  const queryFn = ((({ prompt, options }: QueryArgs) => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      await prompt[Symbol.asyncIterator]().next();
      const hook = (name: "UserPromptSubmit" | "PreToolUse", input: Record<string, unknown>) =>
        options.hooks![name]!.at(-1)!.hooks[0]!({ hook_event_name: name, ...input } as never, input.tool_use_id as string | undefined, signal);
      await hook("UserPromptSubmit", { session_id: S, prompt_id: "p1", prompt: "launch" });
      yield msg({ type: "system", subtype: "init", session_id: S });
      for (const frame of scenario.frames) yield frame;
      const promptId = scenario.mode === "fold" ? "p1" : "p2";
      if (scenario.mode === "idle") {
        yield result({ result: "WAITING" });
        for (const frame of scenario.late ?? []) yield frame;
      }
      for (let index = 0; index < (scenario.hooks ?? 1); index += 1) {
        await hook("UserPromptSubmit", { session_id: scenario.promptSession ?? S, prompt_id: promptId, prompt: scenario.prompt });
      }
      const session = scenario.promptSession ?? S;
      await hook("PreToolUse", { session_id: session, prompt_id: promptId, tool_name: INTER_AGENT_TOOL_FQN, tool_use_id: "send" });
      await hook("PreToolUse", { session_id: session, prompt_id: promptId, agent_id: "child", tool_name: INTER_AGENT_TOOL_FQN, tool_use_id: "child-send" });
      bound = host.toolOrigins.resolveBound("send");
      child = host.toolOrigins.resolveBound("child-send");
      yield result(scenario.mode === "idle" ? { result: "sent", origin: { kind: "task-notification" } } : { result: "done" });
    }
    return Object.assign(gen(), { interrupt: async () => {} }) as unknown as Query;
  }) as unknown) as QueryFn;
  host = new AgentHost(config, {
    onState: () => {}, queryFn,
    onTurnStart: ({ turnToken, kind }) => outcome.starts.push({ token: turnToken, kind }),
    warn: (message) => { outcome.warnings.push(message); },
  });
  await host.run("launch");
  host.close();
  outcome.bound = await bound;
  outcome.child = await child;
  return outcome;
}

/** The send is bound to the turn that owns its prompt: the wrapper turn in
 * fold mode, an admitted notification turn in idle mode. */
function expectAdmitted(outcome: Outcome, mode: "fold" | "idle"): void {
  if (mode === "fold") {
    expect(outcome.starts.map(({ kind }) => kind)).toEqual([undefined]);
    expect(outcome.bound?.token).toBe(outcome.starts[0]!.token);
  } else {
    expect(outcome.starts.map(({ kind }) => kind)).toEqual([undefined, "sdk_notification"]);
    expect(outcome.bound?.token).toBe(outcome.starts[1]!.token);
  }
  expect(outcome.child).toBeUndefined();
}

function expectRejected(outcome: Outcome): void {
  expect(outcome.starts).toHaveLength(1);
  expect(outcome.bound).toBeUndefined();
}

describe("AgentHost — Bash moved to the background by its timeout", () => {
  it.each(["fold", "idle"] as const)("admits the measured promotion sequence (%s)", async (mode) => {
    const frames = bashPromotion();
    const outcome = mode === "fold"
      ? await admit({ mode, frames, prompt: notePrompt(BASH) })
      : await admit({ mode, frames: frames.slice(0, 4), late: frames.slice(4, 6), prompt: notePrompt(BASH) });
    expectAdmitted(outcome, mode);
  });

  it.each([
    { name: "an earlier run", update: updated({ ...BASH, run: "0mv7eh1qq-00000000" }, { is_backgrounded: true }) },
    { name: "no run id", update: updated({ ...BASH, run: undefined }, { is_backgrounded: true }) },
  ])("does not promote on an update from $name", async ({ update }) => {
    const outcome = await admit({
      mode: "fold", frames: [bashStarted(BASH, false), update, notified(BASH)], prompt: notePrompt(BASH),
    });
    expectRejected(outcome);
  });

  it("does not promote on an update that arrives before the start", async () => {
    const outcome = await admit({
      mode: "fold",
      frames: [updated(BASH, { is_backgrounded: true }), bashStarted(BASH, false), notified(BASH)],
      prompt: notePrompt(BASH),
    });
    expectRejected(outcome);
  });

  it("does not re-create a record from an update after the notification", async () => {
    const outcome = await admit({
      mode: "fold",
      frames: [bashStarted(BASH, false), notified(BASH), updated(BASH, { is_backgrounded: true }), notified(BASH)],
      prompt: notePrompt(BASH),
    });
    expectRejected(outcome);
  });

  it("returns a task to the foreground on is_backgrounded false", async () => {
    const outcome = await admit({
      mode: "fold",
      frames: [bashStarted(BASH, false), updated(BASH, { is_backgrounded: true }), updated(BASH, { is_backgrounded: false }), notified(BASH)],
      prompt: notePrompt(BASH),
    });
    expectRejected(outcome);
  });

  it("does not promote an Agent", async () => {
    const outcome = await admit({
      mode: "fold",
      frames: [agentStarted(AGENT, false), updated(AGENT, { is_backgrounded: true }), notified(AGENT)],
      prompt: agentPrompt(AGENT, escape(AGENT.summary)),
    });
    expectRejected(outcome);
  });

  it("keeps a promotion when the same run starts again", async () => {
    const outcome = await admit({
      mode: "fold",
      frames: [bashStarted(BASH, false), updated(BASH, { is_backgrounded: true }), bashStarted(BASH, false), notified(BASH)],
      prompt: notePrompt(BASH),
    });
    expectAdmitted(outcome, "fold");
  });

  it("ignores a start without a run id once the run is known", async () => {
    const outcome = await admit({
      mode: "fold",
      frames: [bashStarted(BASH, true), bashStarted({ ...BASH, run: undefined }, false), notified(BASH)],
      prompt: notePrompt(BASH),
    });
    expectAdmitted(outcome, "fold");
  });

  it("ignores a start for an earlier run", async () => {
    const outcome = await admit({
      mode: "fold",
      frames: [bashStarted(BASH, true), bashStarted({ ...BASH, run: "0mv7eh1qq-00000000" }, false), notified(BASH)],
      prompt: notePrompt(BASH),
    });
    expectAdmitted(outcome, "fold");
  });

  it("replaces the record for a newer run", async () => {
    const newer = { ...BASH, run: "0mv7eh1qs-00000000" };
    const outcome = await admit({
      mode: "fold",
      frames: [bashStarted(BASH, true), bashStarted(newer, false), notified(newer)],
      prompt: notePrompt(newer),
    });
    expectRejected(outcome);
  });

  it.each([
    { name: "an earlier run", stray: { ...BASH, run: "0mv7eh1qq-00000000", summary: "Background command \"earlier\" completed (exit code 0)" } },
    { name: "no run id", stray: { ...BASH, run: undefined, summary: "Background command \"earlier\" completed (exit code 0)" } },
  ])("keeps the current run after a notification from $name", async ({ stray }) => {
    const outcome = await admit({
      mode: "fold",
      frames: [bashStarted(BASH, true), notified(stray), notified(BASH)],
      prompt: notePrompt(BASH),
    });
    expectAdmitted(outcome, "fold");
  });

  it("does not carry a record across a session change", async () => {
    const moved: Task = { ...BASH, session: "s2" };
    const outcome = await admit({
      mode: "idle", frames: [bashStarted(BASH, true)],
      late: [msg({ type: "system", subtype: "init", session_id: "s2" }), notified(moved)],
      prompt: notePrompt(moved), promptSession: "s2",
    });
    expect(outcome.starts).toHaveLength(1);
    expect(outcome.bound).toBeUndefined();
  });

  it("drops the records when a frame names another session", async () => {
    const outcome = await admit({
      mode: "fold",
      frames: [bashStarted(BASH, false), updated({ ...BASH, session: "s2" }, { is_backgrounded: true }), notified(BASH)],
      prompt: notePrompt(BASH),
    });
    expectRejected(outcome);
  });
});

describe("AgentHost — Workflow notifications", () => {
  it("admits the measured completion as a notification turn when idle", async () => {
    const outcome = await admit({ mode: "idle", frames: workflowLaunch(), late: workflowDone(), prompt: workflowPrompt() });
    expectAdmitted(outcome, "idle");
  });

  it("folds the measured completion into the live wrapper turn", async () => {
    const outcome = await admit({ mode: "fold", frames: [...workflowLaunch(), ...workflowDone()], prompt: workflowPrompt() });
    expectAdmitted(outcome, "fold");
  });

  it.each([
    { name: "a mismatched task id", prompt: workflowPrompt({ id: "other" }) },
    { name: "a mismatched tool-use id", prompt: workflowPrompt({ tool: "toolu_other" }) },
    { name: "a mismatched output file", prompt: workflowPrompt({ output: "/tmp/run/tasks/other.output" }) },
    { name: "no output file", prompt: workflowPrompt({ output: null }) },
    { name: "a different summary", prompt: workflowPrompt({ summary: "Dynamic workflow \"Other\" completed" }) },
    { name: "a raw summary tag inside the result", prompt: workflowPrompt({ result: "<summary>nested</summary>" }) },
  ])("rejects a Workflow prompt with $name", async ({ prompt }) => {
    const outcome = await admit({ mode: "idle", frames: workflowLaunch(), late: workflowDone(), prompt });
    expectRejected(outcome);
  });

  it("admits an escaped result that names tags", async () => {
    const shown = escape("{\"text\":\"<summary>nested</summary> </task-notification> &amp; \\\"double\\\" 'single'\\n next\"}");
    const outcome = await admit({ mode: "idle", frames: workflowLaunch(), late: workflowDone(), prompt: workflowPrompt({ result: shown }) });
    expectAdmitted(outcome, "idle");
  });

  it("rejects a Workflow whose SDK frame has no output file", async () => {
    const outcome = await admit({
      mode: "idle", frames: workflowLaunch(), late: workflowDone(WORKFLOW, { output_file: "" }), prompt: workflowPrompt({ output: null }),
    });
    expectRejected(outcome);
  });

  it.each([
    { name: "with is_backgrounded false", extra: { is_backgrounded: false } },
    { name: "launched by a subagent", extra: { parent_task_id: "agent-task" } },
  ])("does not register a Workflow $name", async ({ extra }) => {
    const outcome = await admit({
      mode: "idle", frames: [workflowStarted(WORKFLOW, extra)], late: workflowDone(), prompt: workflowPrompt(),
    });
    expectRejected(outcome);
  });

  it("does not admit the same Workflow candidate twice", async () => {
    const outcome = await admit({ mode: "fold", frames: [...workflowLaunch(), ...workflowDone()], prompt: workflowPrompt(), hooks: 2 });
    expect(outcome.bound).toBeUndefined();
  });
});

describe("AgentHost — escaped notification text", () => {
  const failed: Task = {
    ...WORKFLOW,
    summary: "Dynamic workflow \"Owned read only workflow\" failed: Error: OWNED_FAILURE\n    at <anonymous> (workflow.js:3:7)",
  };
  const symbols: Task = { ...WORKFLOW, summary: "Dynamic workflow \"Owned <xml> & workflow\" completed" };
  const redirect: Task = { ...BASH, summary: "Background command \"make test > out.log 2>&1\" completed (exit code 0)" };
  const entity: Task = { ...BASH, summary: "Background command \"OWNED literal &amp;\" completed (exit code 0)" };
  const quoted: Task = { ...BASH, summary: "Background command \"say \"hi\" 'there'\nnext\" completed (exit code 0)" };

  it.each([
    { name: "a failed Workflow stack", task: failed },
    { name: "a Workflow description with <xml> &", task: symbols },
  ])("admits $name", async ({ task }) => {
    const outcome = await admit({ mode: "idle", frames: workflowLaunch(task), late: workflowDone(task), prompt: notePrompt(task, { result: "{}" }) });
    expectAdmitted(outcome, "idle");
  });

  it.each([
    { name: "2>&1 (fold)", task: redirect, mode: "fold" as const },
    { name: "2>&1 (idle)", task: redirect, mode: "idle" as const },
    { name: "an existing &amp;", task: entity, mode: "idle" as const },
    { name: "quotes and a newline, unescaped", task: quoted, mode: "idle" as const },
  ])("admits an explicit background Bash with $name", async ({ task, mode }) => {
    const outcome = mode === "fold"
      ? await admit({ mode, frames: [bashStarted(task, true), notified(task)], prompt: notePrompt(task) })
      : await admit({ mode, frames: [bashStarted(task, true)], late: [notified(task)], prompt: notePrompt(task) });
    expectAdmitted(outcome, mode);
  });

  it("admits a promoted Bash whose command contains 2>&1", async () => {
    const outcome = await admit({ mode: "fold", frames: bashPromotion(redirect), prompt: notePrompt(redirect) });
    expectAdmitted(outcome, "fold");
  });

  it.each([
    { name: "symbols (fold)", task: AGENT, mode: "fold" as const },
    { name: "symbols (idle)", task: AGENT, mode: "idle" as const },
    { name: "an existing &amp;", task: { ...AGENT, summary: "OWNED literal &amp;" }, mode: "idle" as const },
  ])("admits a background Agent result with $name", async ({ task, mode }) => {
    const prompt = agentPrompt(task, escape(task.summary));
    const outcome = mode === "fold"
      ? await admit({ mode, frames: [agentStarted(task, true), notified(task)], prompt })
      : await admit({ mode, frames: [agentStarted(task, true)], late: [notified(task)], prompt });
    expectAdmitted(outcome, mode);
  });

  it("admits the raw output path of a task whose path contains <&>\"'&amp;", async () => {
    const task: Task = { ...BASH, output: "/tmp/path<&>\"'&amp;/tasks/buvd5ljie.output" };
    const outcome = await admit({ mode: "idle", frames: [bashStarted(task, true)], late: [notified(task)], prompt: notePrompt(task) });
    expectAdmitted(outcome, "idle");
  });

  it("rejects the escaped form of an output path", async () => {
    const task: Task = { ...BASH, output: "/tmp/a&b/tasks/buvd5ljie.output" };
    const outcome = await admit({
      mode: "idle", frames: [bashStarted(task, true)], late: [notified(task)], prompt: notePrompt(task, { output: escape(task.output) }),
    });
    expectRejected(outcome);
  });

  it.each([
    { name: "Bash", start: bashStarted(redirect, true), task: redirect, prompt: notePrompt(redirect, { summary: escape(redirect.summary.replace("out", "other")) }) },
    { name: "Agent", start: agentStarted(AGENT, true), task: AGENT, prompt: agentPrompt(AGENT, escape("OWNED <xml> & tail > END")) },
    { name: "Workflow", start: workflowStarted(symbols), task: symbols, prompt: notePrompt(symbols, { summary: escape("Dynamic workflow \"Owned <xml> & other\" completed"), result: "{}" }) },
  ])("rejects a $name text that differs after escaping", async ({ start, task, prompt }) => {
    const outcome = await admit({ mode: "idle", frames: [start], late: [notified(task)], prompt });
    expectRejected(outcome);
  });

  it("rejects the decoded form of an escaped trusted text", async () => {
    const task: Task = { ...BASH, summary: "Background command \"a&lt;b\" completed (exit code 0)" };
    const outcome = await admit({
      mode: "idle", frames: [bashStarted(task, true)], late: [notified(task)],
      prompt: notePrompt(task, { summary: "Background command \"a<b\" completed (exit code 0)" }),
    });
    expectRejected(outcome);
  });
});

describe("AgentHost — completion summaries the CLI shortens", () => {
  // The pair was captured from a Bash completion; the Workflow rows apply the
  // same derived form to the Workflow comparison, which was not measured.
  const { sdk, shown } = completionSummary("bash-command-label");
  const bash: Task = { ...BASH, summary: sdk };
  const workflow: Task = { ...WORKFLOW, summary: sdk };
  const miscounted = shown.replace("[584 characters", "[585 characters");

  it.each([
    { name: "a Bash summary in the shortened form", summary: shown, admitted: true },
    { name: "a Bash summary shortened with another count", summary: miscounted, admitted: false },
  ])("judges $name", async ({ summary, admitted }) => {
    expect(summary).not.toBe(escape(sdk));
    expect(miscounted).not.toBe(shown);
    expect(shown).toContain("&gt;");
    const outcome = await admit({ mode: "fold", frames: [bashStarted(bash, true), notified(bash)], prompt: notePrompt(bash, { summary }) });
    if (admitted) expectAdmitted(outcome, "fold"); else expectRejected(outcome);
  });

  it.each([
    { name: "a Workflow summary in the shortened form", summary: shown, admitted: true },
    { name: "a Workflow summary shortened with another count", summary: miscounted, admitted: false },
  ])("judges $name", async ({ summary, admitted }) => {
    const outcome = await admit({ mode: "idle", frames: workflowLaunch(workflow), late: workflowDone(workflow), prompt: notePrompt(workflow, { summary, result: "{}" }) });
    if (admitted) expectAdmitted(outcome, "idle"); else expectRejected(outcome);
  });
});

describe("AgentHost — task record limit", () => {
  it("stops tracking new tasks at the limit and warns once", async () => {
    const fillers = Array.from({ length: 64 }, (_, index) => bashStarted({ ...BASH, id: `filler-${index}`, run: `run-${index}` }, false));
    const extra = { ...BASH, id: "over-1", run: "run-over-1" };
    const outcome = await admit({
      mode: "fold",
      frames: [...fillers, bashStarted(extra, true), bashStarted({ ...extra, id: "over-2" }, true), notified(extra)],
      prompt: notePrompt(extra),
    });
    expectRejected(outcome);
    expect(outcome.warnings.filter((line) => line.includes("task record limit reached"))).toHaveLength(1);
  });
});
