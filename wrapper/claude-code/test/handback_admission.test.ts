import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { INTER_AGENT_TOOL_FQN, ReplyBasis } from "@kaoiro/agent-common";
import type { Envelope } from "@kaoiro/protocol";
import { AgentHost } from "../src/host.js";
import type { AgentHostOptions } from "../src/host.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/issue-426-agent-handback.json", import.meta.url), "utf8")) as {
  taskId: string;
  report: string;
  prompt: string;
};
const config = {
  agent_id: "recipient",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};
type QueryArgs = { prompt: AsyncIterable<SDKUserMessage>; options: Options };
const fakeQuery = (fn: (args: QueryArgs) => AsyncGenerator<SDKMessage, void>): NonNullable<AgentHostOptions["queryFn"]> =>
  ((args: QueryArgs) => Object.assign(fn(args), { interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query) as NonNullable<AgentHostOptions["queryFn"]>;
const sdk = (data: Record<string, unknown>): SDKMessage => data as SDKMessage;
const signal = { signal: new AbortController().signal };
const observedBody = fixture.prompt.slice(fixture.prompt.indexOf("\n") + 1, -"\n</agent-message>".length);
const disclaimer = observedBody.split("\n", 1)[0]!;
const render = (taskId: string, report: string): string =>
  `<agent-message from="${taskId}">\n${disclaimer}\n${report.split("\n").map(line => `  ${line}`).join("\n")}\n</agent-message>`;

async function promptHook(options: Options, promptId: string, prompt: string): Promise<void> {
  await options.hooks!.UserPromptSubmit!.at(-1)!.hooks[0]!({
    hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: promptId, prompt,
  } as never, undefined, signal);
}

async function toolHook(options: Options, promptId: string, toolName: string, toolUseId: string, agentId?: string, toolInput?: unknown, sessionId = "s"): Promise<void> {
  await options.hooks!.PreToolUse!.at(-1)!.hooks[0]!({
    hook_event_name: "PreToolUse", session_id: sessionId, prompt_id: promptId,
    tool_name: toolName, tool_use_id: toolUseId,
    ...(agentId ? { agent_id: agentId } : {}),
    ...(toolInput ? { tool_input: toolInput } : {}),
  } as never, toolUseId, signal);
}

describe("background Agent hand-back admission", () => {
  it.each([
    ["registered background Agent", true, "local_agent", true, fixture.taskId, "s", true, true],
    ["missing root Agent parent", false, "local_agent", true, fixture.taskId, "s", true, false],
    ["foreground Agent", true, "local_agent", false, fixture.taskId, "s", true, false],
    ["later background promotion", true, "local_agent", false, fixture.taskId, "s", true, false],
    ["wrong task kind", true, "local_bash", true, fixture.taskId, "s", true, false],
    ["wrong child task", true, "local_agent", true, "other-task", "s", true, false],
    ["wrong child session", true, "local_agent", true, fixture.taskId, "other", true, false],
    ["wrong child tool ID", true, "local_agent", true, fixture.taskId, "s", false, false],
  ] as const)("requires task and child provenance: %s", async (label, parentObserved, taskType, backgrounded,
    agentId, childSession, childIdMatches, valid) => {
    let binding!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      if (parentObserved) await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: taskType, is_backgrounded: backgrounded });
      if (label === "later background promotion") yield sdk({ type: "system", subtype: "task_updated",
        session_id: "s", task_id: fixture.taskId, patch: { is_backgrounded: true } });
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "started" });
      if (childIdMatches) {
        await toolHook(options, "launch", "SubagentHandback", "child", agentId,
          { message: fixture.report }, childSession);
      } else {
        await options.hooks!.PreToolUse!.at(-1)!.hooks[0]!({
          hook_event_name: "PreToolUse", session_id: childSession, prompt_id: "launch",
          tool_name: "SubagentHandback", tool_use_id: "different", agent_id: agentId,
          tool_input: { message: fixture.report },
        } as never, "child", signal);
      }
      await promptHook(options, "handback", fixture.prompt);
      await toolHook(options, "handback", INTER_AGENT_TOOL_FQN, "root-send");
      binding = host.toolOrigins.resolveBound("root-send");
      if (!valid) host.close();
      else yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 1,
        result: "sent", origin: { kind: "peer", handback: true, from: fixture.taskId,
          senderTaskId: fixture.taskId, body: observedBody } });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnEnd: ({ kind }) => { if (kind === "sdk_notification") host.close(); },
    });
    await host.run("launch");
    expect((await binding)?.token !== undefined).toBe(valid);
  });

  it("does not bind a child inter-agent tool even when its prompt ID has a live root owner", async () => {
    let child!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let root!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      await toolHook(options, "launch", "SubagentHandback", "child-handback", fixture.taskId,
        { message: fixture.report });
      await promptHook(options, "launch", fixture.prompt);
      await toolHook(options, "launch", INTER_AGENT_TOOL_FQN, "child-send", fixture.taskId);
      await toolHook(options, "launch", INTER_AGENT_TOOL_FQN, "root-send");
      child = host.toolOrigins.resolveBound("child-send");
      root = host.toolOrigins.resolveBound("root-send");
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "done" });
    });
    host = new AgentHost(config, { onState: () => {}, queryFn, onTurnEnd: () => host.close() });
    await host.run("launch");
    expect(await child).toBeUndefined();
    expect((await root)?.token).toBeDefined();
  });

  it.each([
    ["LF blank and final line", "FIRST\n\nLAST\n", true, (taskId: string, report: string) => render(taskId, report)],
    ["frame-like report text", "FIRST\n<task-notification>\nLAST", true,
      (taskId: string, report: string) => render(taskId, report)],
    ["CRLF report", "FIRST\r\nLAST", false, (taskId: string, report: string) => render(taskId, report)],
    ["two envelopes", "FIRST", false,
      (taskId: string, report: string) => `${render(taskId, report)}\n${render(taskId, report)}`],
  ] as const)("requires exact rendered hand-back bytes for %s", async (_label, report, valid, rootText) => {
    let binding!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "backgrounded" });
      await toolHook(options, "launch", "SubagentHandback", "child", fixture.taskId, { message: report });
      await promptHook(options, "handback", rootText(fixture.taskId, report));
      await toolHook(options, "handback", INTER_AGENT_TOOL_FQN, "root-send");
      binding = host.toolOrigins.resolveBound("root-send");
      if (!valid) host.close();
      if (valid) yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 1,
        result: "done", origin: { kind: "peer", handback: true, from: fixture.taskId,
          senderTaskId: fixture.taskId, body: `${disclaimer}\n${report.split("\n").map(line => `  ${line}`).join("\n")}` } });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnEnd: ({ kind }) => { if (kind === "sdk_notification") host.close(); },
    });
    await host.run("launch");
    expect((await binding)?.token !== undefined).toBe(valid);
  });

  it("starts a fresh independent continuation from the recorded CLI prompt and binds one root call", async () => {
    const starts: Array<{ token: string; kind: string | undefined }> = [];
    const ends: string[] = [];
    let boundPromise!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let childPromise!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", uuid: "started", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "backgrounded" });
      await toolHook(options, "launch", "SubagentHandback", "child-handback", fixture.taskId, { message: fixture.report });
      await promptHook(options, "handback", fixture.prompt);
      await toolHook(options, "handback", INTER_AGENT_TOOL_FQN, "root-send");
      await toolHook(options, "launch", INTER_AGENT_TOOL_FQN, "child-send", fixture.taskId);
      boundPromise = host.toolOrigins.resolveBound("root-send");
      childPromise = host.toolOrigins.resolveBound("child-send");
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 1, result: "sent",
        origin: { kind: "peer", handback: true, from: fixture.taskId, senderTaskId: fixture.taskId,
          body: observedBody } });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken, kind }) => starts.push({ token: turnToken, kind }),
      onTurnEnd: ({ turnToken }) => {
        if (turnToken) ends.push(turnToken);
        if (ends.length === 2) host.close();
      },
    });
    await host.run("launch");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.kind).toBe("sdk_notification");
    expect((await boundPromise)?.token).toBe(starts[1]?.token);
    expect(await childPromise).toBeUndefined();
    expect(ends).toEqual(starts.map(({ token }) => token));
  });

  it.each([
    ["notification", { kind: "task-notification" }, true],
    ["peer", { kind: "peer", handback: true, from: fixture.taskId, senderTaskId: fixture.taskId, body: observedBody }, false],
    ["originless", undefined, false],
  ])("folds a hand-back into an independent notification owner with %s result", async (_label, origin, accepted) => {
    const starts: string[] = [];
    const ends: Array<{ token: string; cancellation?: string }> = [];
    const failStops: string[] = [];
    let rootCall!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", uuid: "started", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "backgrounded" });
      yield sdk({ type: "system", subtype: "task_notification", session_id: "s", uuid: "notification", task_id: fixture.taskId,
        tool_use_id: "parent", status: "completed", output_file: "/tmp/task", summary: "done" });
      await promptHook(options, "notification", `<task-notification><task-id>${fixture.taskId}</task-id><tool-use-id>parent</tool-use-id><status>completed</status><output-file>/tmp/task</output-file><summary>Agent finished</summary><result>done</result></task-notification>`);
      await toolHook(options, "launch", "SubagentHandback", "child-handback", fixture.taskId, { message: fixture.report });
      await promptHook(options, "notification", fixture.prompt);
      await toolHook(options, "notification", INTER_AGENT_TOOL_FQN, "root-send");
      rootCall = host.toolOrigins.resolveBound("root-send");
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 1, result: "sent",
        ...(origin === undefined ? {} : { origin }) });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken }) => starts.push(turnToken),
      onTurnEnd: ({ turnToken, cancellation }) => {
        if (turnToken) ends.push({ token: turnToken, ...(cancellation ? { cancellation: cancellation.kind } : {}) });
        if (ends.length === 2 && accepted) host.close();
      },
      onAdmissionFailStop: ({ turnToken }) => failStops.push(turnToken),
    });
    await host.run("launch");
    expect(starts).toHaveLength(2);
    expect((await rootCall)?.token).toBe(starts[1]);
    expect(ends).toEqual([{ token: starts[0] }, { token: starts[1], ...(accepted ? {} : { cancellation: "stream_eof" }) }]);
    expect(failStops).toEqual(accepted ? [] : [starts[1]]);
  });

  it.each([
    ["opener result", { kind: "peer", handback: true, from: fixture.taskId, senderTaskId: fixture.taskId,
      body: observedBody }, true],
    ["folded task identity", { kind: "peer", handback: true, from: "folded-task", senderTaskId: "folded-task",
      body: observedBody }, false],
    ["wrong origin", { kind: "task-notification", handback: true, from: fixture.taskId,
      senderTaskId: fixture.taskId, body: observedBody }, false],
    ["wrong opener body", { kind: "peer", handback: true, from: fixture.taskId,
      senderTaskId: fixture.taskId, body: observedBody.replace("  READY", "  OTHER") }, false],
  ] as const)("keeps the hand-back opener after other-task folds: %s", async (_label, origin, accepted) => {
    const starts: string[] = [];
    const ends: Array<{ token: string; cancellation?: string }> = [];
    const failStops: string[] = [];
    let bound!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      for (const [taskId, parent] of [[fixture.taskId, "opener-parent"], ["folded-task", "folded-parent"]] as const) {
        await toolHook(options, "launch", "Agent", parent);
        yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: taskId,
          tool_use_id: parent, task_type: "local_agent", is_backgrounded: true });
      }
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "backgrounded" });
      await toolHook(options, "launch", "SubagentHandback", "opener-child", fixture.taskId,
        { message: fixture.report });
      await promptHook(options, "owner", fixture.prompt);
      await toolHook(options, "launch", "SubagentHandback", "folded-child", "folded-task", { message: "FOLDED" });
      await promptHook(options, "owner", fixture.prompt.replaceAll(fixture.taskId, "folded-task").replace("  READY", "  FOLDED"));
      yield sdk({ type: "system", subtype: "task_notification", session_id: "s", uuid: "opener-notice",
        task_id: fixture.taskId, tool_use_id: "opener-parent", status: "completed", output_file: "/tmp/task", summary: "done" });
      await promptHook(options, "owner", `<task-notification><task-id>${fixture.taskId}</task-id><tool-use-id>opener-parent</tool-use-id><status>completed</status><output-file>/tmp/task</output-file><summary>Agent finished</summary><result>done</result></task-notification>`);
      await toolHook(options, "owner", INTER_AGENT_TOOL_FQN, "after-fold-send");
      bound = host.toolOrigins.resolveBound("after-fold-send");
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 1, result: "done", origin });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken }) => starts.push(turnToken),
      onTurnEnd: ({ turnToken, cancellation }) => {
        if (turnToken) ends.push({ token: turnToken, ...(cancellation ? { cancellation: cancellation.kind } : {}) });
        if (accepted && ends.length === 2) host.close();
      },
      onAdmissionFailStop: ({ turnToken }) => failStops.push(turnToken),
    });
    await host.run("launch");
    expect(starts).toHaveLength(2);
    expect((await bound)?.token).toBe(starts[1]);
    expect(ends).toEqual([{ token: starts[0] }, { token: starts[1], ...(accepted ? {} : { cancellation: "stream_eof" }) }]);
    expect(failStops).toEqual(accepted ? [] : [starts[1]]);
  });

  it("releases a notification opener's input barrier after an other-task hand-back fold", async () => {
    const starts: string[] = [];
    const ends: string[] = [];
    let foldedCall!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      const input = prompt[Symbol.asyncIterator]();
      await input.next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      for (const [taskId, parent] of [[fixture.taskId, "first-parent"], ["other-task", "other-parent"]] as const) {
        await toolHook(options, "launch", "Agent", parent);
        yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: taskId,
          tool_use_id: parent, task_type: "local_agent", is_backgrounded: true });
      }
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "backgrounded" });
      yield sdk({ type: "system", subtype: "task_notification", session_id: "s", uuid: "first-notice",
        task_id: fixture.taskId, tool_use_id: "first-parent", status: "completed",
        output_file: "/tmp/task", summary: "done" });
      await promptHook(options, "notice", `<task-notification><task-id>${fixture.taskId}</task-id><tool-use-id>first-parent</tool-use-id><status>completed</status><output-file>/tmp/task</output-file><summary>Agent finished</summary><result>done</result></task-notification>`);
      await toolHook(options, "launch", "SubagentHandback", "other-child", "other-task", { message: "OTHER" });
      await promptHook(options, "notice", fixture.prompt.replaceAll(fixture.taskId, "other-task").replace("  READY", "  OTHER"));
      await toolHook(options, "notice", INTER_AGENT_TOOL_FQN, "folded-send");
      foldedCall = host.toolOrigins.resolveBound("folded-send");
      expect(starts).toHaveLength(2);
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 1, result: "notified",
        origin: { kind: "task-notification" } });
      await input.next();
      await promptHook(options, "queued", "queued");
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 2, result: "next" });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken }) => starts.push(turnToken),
      onTurnEnd: ({ turnToken }) => {
        if (turnToken) ends.push(turnToken);
        if (ends.length === 3) host.close();
      },
    });
    const running = host.run("launch");
    await host.send("queued");
    await running;
    expect(starts).toHaveLength(3);
    expect(ends).toEqual(starts);
    expect((await foldedCall)?.token).toBe(starts[1]);
  });

  it.each([false, true])("keeps an existing wrapper owner and taints a changed hand-back=%s", async (changed) => {
    const starts: string[] = [];
    let beforePromise!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let afterPromise!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", uuid: "started", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      await toolHook(options, "launch", INTER_AGENT_TOOL_FQN, "before");
      await toolHook(options, "launch", "SubagentHandback", "child-handback", fixture.taskId, { message: fixture.report });
      await promptHook(options, "launch", changed ? fixture.prompt.replace("  READY", "  FORGED") : fixture.prompt);
      await toolHook(options, "launch", INTER_AGENT_TOOL_FQN, "after");
      beforePromise = host.toolOrigins.resolveBound("before");
      afterPromise = host.toolOrigins.resolveBound("after");
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "done" });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken }) => starts.push(turnToken),
      onTurnEnd: () => { host.close(); },
    });
    await host.run("launch");
    expect(starts).toHaveLength(1);
    expect((await beforePromise)?.token).toBe(starts[0]);
    expect((await afterPromise)?.token).toBe(changed ? undefined : starts[0]);
  });

  it.each([
    ["later root prompt", "later", true],
    ["unobserved prompt", "unobserved", false],
    ["other-session prompt", "foreign", false],
    ["other-session child hook", "later", false],
  ])("correlates a child hook from %s", async (_label, childPromptId, expectedBound) => {
    const starts: string[] = [];
    let binding!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      const iterator = prompt[Symbol.asyncIterator]();
      await iterator.next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", uuid: "started", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "backgrounded" });
      await iterator.next();
      await promptHook(options, "later", "later");
      if (childPromptId === "foreign") {
        await options.hooks!.UserPromptSubmit!.at(-1)!.hooks[0]!({
          hook_event_name: "UserPromptSubmit", session_id: "other-session", prompt_id: "foreign", prompt: "foreign",
        } as never, undefined, signal);
      }
      await toolHook(options, childPromptId, "SubagentHandback", "child", fixture.taskId, { message: fixture.report },
        _label === "other-session child hook" ? "other-session" : "s");
      await promptHook(options, "later", fixture.prompt);
      await toolHook(options, "later", INTER_AGENT_TOOL_FQN, "root-send");
      binding = host.toolOrigins.resolveBound("root-send");
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 1, result: "done" });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken }) => starts.push(turnToken),
      onTurnEnd: ({ turnToken }) => { if (turnToken === starts[1]) host.close(); },
    });
    const running = host.run("launch");
    await host.send("later");
    await running;
    expect(starts).toHaveLength(2);
    expect((await binding)?.token).toBe(expectedBound ? starts[1] : undefined);
  });

  it("keeps observed root IDs within the 64-entry cap and rejects a later ID", async () => {
    const warnings: string[] = [];
    let before!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let after!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      for (let i = 0; i < 63; i++) await promptHook(options, `seen-${i}`, `seen-${i}`);
      await promptHook(options, "overflow", "overflow");
      await toolHook(options, "launch", "SubagentHandback", "child-valid", fixture.taskId, { message: fixture.report });
      await promptHook(options, "launch", fixture.prompt);
      await toolHook(options, "launch", INTER_AGENT_TOOL_FQN, "before");
      await toolHook(options, "overflow", "SubagentHandback", "child-overflow", fixture.taskId, { message: "BAD" });
      await promptHook(options, "launch", fixture.prompt.replace("  READY", "  BAD"));
      await toolHook(options, "launch", INTER_AGENT_TOOL_FQN, "after");
      before = host.toolOrigins.resolveBound("before");
      after = host.toolOrigins.resolveBound("after");
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "done" });
    });
    host = new AgentHost(config, { onState: () => {}, queryFn, warn: text => warnings.push(text), onTurnEnd: () => host.close() });
    await host.run("launch");
    expect((await before)?.token).toBeDefined();
    expect(await after).toBeUndefined();
    expect(warnings.filter(text => text.includes("observed root prompt capacity"))).toHaveLength(1);
  });

  it("folds four distinct Agent reports into one wrapper owner and releases the next input barrier", async () => {
    const starts: string[] = [];
    const ends: string[] = [];
    let rootCall!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      const iterator = prompt[Symbol.asyncIterator]();
      await iterator.next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      for (let i = 0; i < 4; i++) {
        await toolHook(options, "launch", "Agent", `parent-${i}`);
        yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: `task-${i}`,
          tool_use_id: `parent-${i}`, task_type: "local_agent", is_backgrounded: true });
      }
      for (let i = 0; i < 4; i++) {
        await toolHook(options, "launch", "SubagentHandback", `child-${i}`, `task-${i}`,
          { message: `REPORT-${i}` });
        await promptHook(options, "launch", fixture.prompt.replaceAll(fixture.taskId, `task-${i}`).replace("  READY", `  REPORT-${i}`));
      }
      await toolHook(options, "launch", INTER_AGENT_TOOL_FQN, "fold-send");
      rootCall = host.toolOrigins.resolveBound("fold-send");
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "folded" });
      await iterator.next();
      await promptHook(options, "next", "next");
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 1, result: "next" });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken }) => starts.push(turnToken),
      onTurnEnd: ({ turnToken }) => {
        if (turnToken) ends.push(turnToken);
        if (ends.length === 2) host.close();
      },
    });
    const running = host.run("launch");
    await host.send("next");
    await running;
    expect(starts).toHaveLength(2);
    expect(ends).toEqual(starts);
    expect((await rootCall)?.token).toBe(starts[0]);
  });

  it("consumes distinct reports from one task separately and rejects an exact replay", async () => {
    const starts: string[] = [];
    let first!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let second!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let replay!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      await toolHook(options, "launch", "SubagentHandback", "child-one", fixture.taskId,
        { message: fixture.report });
      await promptHook(options, "launch", fixture.prompt);
      await toolHook(options, "launch", INTER_AGENT_TOOL_FQN, "first-send");
      first = host.toolOrigins.resolveBound("first-send");
      await toolHook(options, "launch", "SubagentHandback", "child-two", fixture.taskId,
        { message: "SECOND" });
      await promptHook(options, "launch", render(fixture.taskId, "SECOND"));
      await toolHook(options, "launch", INTER_AGENT_TOOL_FQN, "second-send");
      second = host.toolOrigins.resolveBound("second-send");
      await toolHook(options, "launch", "SubagentHandback", "child-replay", fixture.taskId,
        { message: fixture.report });
      await promptHook(options, "launch", fixture.prompt);
      await toolHook(options, "launch", INTER_AGENT_TOOL_FQN, "replay-send");
      replay = host.toolOrigins.resolveBound("replay-send");
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "done" });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken }) => starts.push(turnToken),
      onTurnEnd: () => host.close(),
    });
    await host.run("launch");
    expect(starts).toHaveLength(1);
    expect((await first)?.token).toBe(starts[0]);
    expect((await second)?.token).toBe(starts[0]);
    expect(await replay).toBeUndefined();
  });

  it("keeps the wrapper snapshot and an issued same-token ticket across other-task folds", async () => {
    const basis = new ReplyBasis();
    const starts: string[] = [];
    let defaultBasis: unknown;
    let ticketBasis: unknown;
    let host!: AgentHost;
    const inbound = (turnNumber: number): Envelope => ({
      version: "0", agent_id: "peer", persona: config.persona, display_name: "Peer",
      ts: "2026-09-27T00:00:00Z", type: "inter_agent_message", state: "thinking",
      payload: { to: config.agent_id, conversation_id: "cid", turn_number: turnNumber,
        kind: "response", body: `input ${turnNumber}`, meta: { done: false, propose_next: "" },
        owner: { kind: "user", id: "operator" }, new_conversation: false }, ext: {},
    });
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      for (const [taskId, parent] of [[fixture.taskId, "first-parent"], ["folded-task", "folded-parent"]] as const) {
        await toolHook(options, "launch", "Agent", parent);
        yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: taskId,
          tool_use_id: parent, task_type: "local_agent", is_backgrounded: true });
      }
      const ticket = basis.prepare({ token: starts[0]! }, "cid", "peer", 3)!;
      expect(ticket.activate()).toBe(true);
      await toolHook(options, "launch", "SubagentHandback", "first-child", fixture.taskId,
        { message: fixture.report });
      await promptHook(options, "launch", fixture.prompt);
      await toolHook(options, "launch", "SubagentHandback", "folded-child", "folded-task", { message: "FOLDED" });
      await promptHook(options, "launch", fixture.prompt.replaceAll(fixture.taskId, "folded-task").replace("  READY", "  FOLDED"));
      basis.observe([inbound(4)]);
      await toolHook(options, "launch", INTER_AGENT_TOOL_FQN, "after-fold-send");
      const origin = await host.toolOrigins.resolveBound("after-fold-send");
      defaultBasis = basis.capture(origin, "cid", "peer");
      ticketBasis = basis.capture(origin, "cid", "peer", 3, ticket.authorization.reply_ticket);
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "done" });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken }) => {
        starts.push(turnToken);
        basis.begin(turnToken, [inbound(2)], undefined, true);
      },
      onPromptAdmitted: token => basis.confirmInput(token),
      onTurnEnd: ({ turnToken }) => {
        if (turnToken) basis.retire(turnToken);
        host.close();
      },
    });
    await host.run("launch");
    expect(starts).toHaveLength(1);
    expect(defaultBasis).toMatchObject({ basis: 2 });
    expect(ticketBasis).toMatchObject({ basis: 3 });
  });

  it("starts a live-turn candidate timer only at the terminal boundary, then taints a late same-ID hook", async () => {
    vi.useFakeTimers();
    try {
      const starts: string[] = [];
      let firstEnd!: () => void;
      const firstEnded = new Promise<void>(resolve => { firstEnd = resolve; });
      let before!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
      let after!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
      let host!: AgentHost;
      const queryFn = fakeQuery(async function* ({ prompt, options }) {
        const iterator = prompt[Symbol.asyncIterator]();
        await iterator.next();
        await promptHook(options, "launch", "launch");
        yield sdk({ type: "system", subtype: "init", session_id: "s" });
        await toolHook(options, "launch", "Agent", "parent");
        yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: fixture.taskId,
          tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
        await toolHook(options, "launch", "SubagentHandback", "child", fixture.taskId, { message: fixture.report });
        await vi.advanceTimersByTimeAsync(31_000);
        yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "done" });
        await iterator.next();
        await promptHook(options, "next", "next");
        await toolHook(options, "next", INTER_AGENT_TOOL_FQN, "before");
        await promptHook(options, "next", fixture.prompt);
        await toolHook(options, "next", INTER_AGENT_TOOL_FQN, "after");
        before = host.toolOrigins.resolveBound("before");
        after = host.toolOrigins.resolveBound("after");
        yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 1, result: "next" });
      });
      host = new AgentHost(config, {
        onState: () => {}, queryFn,
        onTurnStart: ({ turnToken }) => starts.push(turnToken),
        onTurnEnd: ({ turnToken }) => {
          if (turnToken === starts[0]) firstEnd();
          if (turnToken === starts[1]) host.close();
        },
      });
      const running = host.run("launch");
      await host.send("next");
      await firstEnded;
      await vi.advanceTimersByTimeAsync(30_001);
      await running;
      expect(starts).toHaveLength(2);
      expect((await before)?.token).toBe(starts[1]);
      expect(await after).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["handback", 30_000, false],
    ["notification", 10_000, false],
    ["handback", 30_000, true],
    ["notification", 10_000, true],
  ] as const)("rearms a %s candidate across a busy continuation, interval=%s, no-hook expiry=%s", async (kind, interval, noHook) => {
    vi.useFakeTimers();
    try {
      const starts: string[] = [];
      const ends: string[] = [];
      let rootBinding!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
      let beforeLate!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
      let afterLate!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
      let host!: AgentHost;
      const notificationPrompt = `<task-notification><task-id>${fixture.taskId}</task-id><tool-use-id>target-parent</tool-use-id><status>completed</status><output-file>/tmp/task</output-file><summary>Agent finished</summary><result>done</result></task-notification>`;
      const blockerPrompt = fixture.prompt.replaceAll(fixture.taskId, "blocker-task").replace("  READY", "  BLOCKER");
      const queryFn = fakeQuery(async function* ({ prompt, options }) {
        const iterator = prompt[Symbol.asyncIterator]();
        await iterator.next();
        await promptHook(options, "launch", "launch");
        yield sdk({ type: "system", subtype: "init", session_id: "s" });
        for (const [taskId, parent] of [[fixture.taskId, "target-parent"], ["blocker-task", "blocker-parent"]] as const) {
          await toolHook(options, "launch", "Agent", parent);
          yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: taskId,
            tool_use_id: parent, task_type: "local_agent", is_backgrounded: true });
        }
        if (kind === "handback") {
          await toolHook(options, "launch", "SubagentHandback", "target-child", fixture.taskId, { message: fixture.report });
        } else {
          yield sdk({ type: "system", subtype: "task_notification", session_id: "s", uuid: "target-notice",
            task_id: fixture.taskId, tool_use_id: "target-parent", status: "completed",
            output_file: "/tmp/task", summary: "done" });
        }
        yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "launch complete" });
        await vi.advanceTimersByTimeAsync(interval - 1_000);
        expect(starts).toHaveLength(1);
        await toolHook(options, "launch", "SubagentHandback", "blocker-child", "blocker-task", { message: "BLOCKER" });
        await promptHook(options, "blocker", blockerPrompt);
        expect(starts).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(interval + 1_000);
        yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 1, result: "blocker complete",
          origin: { kind: "peer", handback: true, from: "blocker-task", senderTaskId: "blocker-task",
            body: observedBody.replace("  READY", "  BLOCKER") } });
        if (!noHook) {
          await vi.advanceTimersByTimeAsync(3_000);
          await promptHook(options, "target", kind === "handback" ? fixture.prompt : notificationPrompt);
          await toolHook(options, "target", INTER_AGENT_TOOL_FQN, "target-send");
          rootBinding = host.toolOrigins.resolveBound("target-send");
          yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 2, result: "target complete",
            origin: kind === "handback"
              ? { kind: "peer", handback: true, from: fixture.taskId, senderTaskId: fixture.taskId, body: observedBody }
              : { kind: "task-notification" } });
        } else {
          await vi.advanceTimersByTimeAsync(interval - 1);
          expect(starts).toHaveLength(2);
          await vi.advanceTimersByTimeAsync(2);
          const nextInput = iterator.next();
          await vi.advanceTimersByTimeAsync(1);
          expect(starts).toHaveLength(3);
          await nextInput;
          await promptHook(options, "after", "after");
          await toolHook(options, "after", INTER_AGENT_TOOL_FQN, "before-late");
          beforeLate = host.toolOrigins.resolveBound("before-late");
          if (kind === "handback") {
            await toolHook(options, "launch", "SubagentHandback", "target-child-replay", fixture.taskId,
              { message: fixture.report });
          } else {
            yield sdk({ type: "system", subtype: "task_notification", session_id: "s", uuid: "target-notice-replay",
              task_id: fixture.taskId, tool_use_id: "target-parent", status: "completed",
              output_file: "/tmp/task", summary: "done" });
          }
          await promptHook(options, "after", kind === "handback" ? fixture.prompt : notificationPrompt);
          await toolHook(options, "after", INTER_AGENT_TOOL_FQN, "after-late");
          afterLate = host.toolOrigins.resolveBound("after-late");
          yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 2, result: "after complete" });
        }
      });
      host = new AgentHost(config, {
        onState: () => {}, queryFn,
        onTurnStart: ({ turnToken }) => starts.push(turnToken),
        onTurnEnd: ({ turnToken }) => {
          if (turnToken) ends.push(turnToken);
          if (ends.length === 3) host.close();
        },
      });
      const running = host.run("launch");
      if (noHook) await host.send("after");
      await running;
      expect(starts).toHaveLength(3);
      expect(ends).toEqual(starts);
      if (noHook) {
        expect((await beforeLate)?.token).toBe(starts[2]);
        expect(await afterLate).toBeUndefined();
      } else {
        expect((await rootBinding)?.token).toBe(starts[2]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["wrong task", { kind: "peer", handback: true, from: "other", senderTaskId: "other", body: observedBody }, 1, "s"],
    ["wrong report", { kind: "peer", handback: true, from: fixture.taskId, senderTaskId: fixture.taskId, body: "other" }, 1, "s"],
    ["missing identity", { kind: "peer", from: fixture.taskId, senderTaskId: fixture.taskId, body: observedBody }, 1, "s"],
    ["notification origin", { kind: "task-notification" }, 1, "s"],
    ["originless", undefined, 1, "s"],
    ["missing index", { kind: "peer", handback: true, from: fixture.taskId, senderTaskId: fixture.taskId, body: observedBody }, undefined, "s"],
    ["regressing index", { kind: "peer", handback: true, from: fixture.taskId, senderTaskId: fixture.taskId, body: observedBody }, 0, "s"],
    ["other session", { kind: "peer", handback: true, from: fixture.taskId, senderTaskId: fixture.taskId, body: observedBody }, 1, "other"],
  ])("fail-stops an independently admitted hand-back on %s", async (_label, origin, resultIndex, resultSession) => {
    const starts: string[] = [];
    const ends: Array<{ token: string; cancellation?: string }> = [];
    const failStops: string[] = [];
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "backgrounded" });
      await toolHook(options, "launch", "SubagentHandback", "child", fixture.taskId, { message: fixture.report });
      await promptHook(options, "handback", fixture.prompt);
      yield sdk({ type: "result", subtype: "success", session_id: resultSession, result: "done",
        ...(resultIndex === undefined ? {} : { result_index: resultIndex }),
        ...(origin === undefined ? {} : { origin }) });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken }) => starts.push(turnToken),
      onTurnEnd: ({ turnToken, cancellation }) => {
        if (turnToken) ends.push({ token: turnToken, ...(cancellation ? { cancellation: cancellation.kind } : {}) });
      },
      onAdmissionFailStop: ({ turnToken }) => failStops.push(turnToken),
    });
    await host.run("launch");
    expect(starts).toHaveLength(2);
    expect(ends).toEqual([{ token: starts[0] }, { token: starts[1], cancellation: "stream_eof" }]);
    expect(failStops).toEqual([starts[1]]);
  });

  it("ignores an exact retired result duplicate without settling the newer hand-back owner", async () => {
    const starts: string[] = [];
    const ends: string[] = [];
    const failStops: string[] = [];
    let host!: AgentHost;
    const launchResult = sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0,
      result: "backgrounded" });
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      yield launchResult;
      await toolHook(options, "launch", "SubagentHandback", "child", fixture.taskId, { message: fixture.report });
      await promptHook(options, "handback", fixture.prompt);
      yield launchResult;
      expect(ends).toEqual([starts[0]]);
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 1,
        result: "sent", origin: { kind: "peer", handback: true, from: fixture.taskId,
          senderTaskId: fixture.taskId, body: observedBody } });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken }) => starts.push(turnToken),
      onTurnEnd: ({ turnToken }) => {
        if (turnToken) ends.push(turnToken);
        if (ends.length === 2) host.close();
      },
      onAdmissionFailStop: ({ turnToken }) => failStops.push(turnToken),
    });
    await host.run("launch");
    expect(starts).toHaveLength(2);
    expect(ends).toEqual(starts);
    expect(failStops).toEqual([]);
  });

  it.each(["independent", "wrapper fold"] as const)("treats repeated Stop hooks as attempts for a %s hand-back", async ownerKind => {
    const starts: string[] = [];
    const ends: string[] = [];
    let afterStop!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      if (ownerKind === "independent") yield sdk({ type: "result", subtype: "success", session_id: "s",
        result_index: 0, result: "backgrounded" });
      await toolHook(options, "launch", "SubagentHandback", "child", fixture.taskId, { message: fixture.report });
      const promptId = ownerKind === "independent" ? "handback" : "launch";
      await promptHook(options, promptId, fixture.prompt);
      for (let i = 0; i < 2; i++) {
        await options.hooks!.Stop!.at(-1)!.hooks[0]!({
          hook_event_name: "Stop", session_id: "s", prompt_id: promptId,
        } as never, undefined, signal);
        if (i === 0) await toolHook(options, promptId, INTER_AGENT_TOOL_FQN, "after-stop");
      }
      afterStop = host.toolOrigins.resolveBound("after-stop");
      expect(ends).toHaveLength(ownerKind === "independent" ? 1 : 0);
      yield sdk({ type: "result", subtype: "success", session_id: "s",
        result_index: ownerKind === "independent" ? 1 : 0, result: "done",
        ...(ownerKind === "independent" ? { origin: { kind: "peer", handback: true,
          from: fixture.taskId, senderTaskId: fixture.taskId, body: observedBody } } : {}) });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken }) => starts.push(turnToken),
      onTurnEnd: ({ turnToken }) => {
        if (turnToken) ends.push(turnToken);
        if (ends.length === (ownerKind === "independent" ? 2 : 1)) host.close();
      },
    });
    await host.run("launch");
    expect((await afterStop)?.token).toBe(starts.at(-1));
    expect(ends).toEqual(starts);
  });

  it.each([
    ["independent", "interrupt"], ["wrapper fold", "interrupt"],
    ["independent", "reset"], ["wrapper fold", "reset"],
    ["independent", "watchdog"], ["wrapper fold", "watchdog"],
    ["independent", "fail-stop"], ["wrapper fold", "fail-stop"],
    ["independent", "EOF"], ["wrapper fold", "EOF"],
  ] as const)("keeps delayed hand-back authority from crossing %s %s", async (ownerKind, boundary) => {
    const starts: string[] = [];
    const ends: Array<{ token: string; cancellation?: string }> = [];
    const freezes: string[] = [];
    let delayed!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      const input = prompt[Symbol.asyncIterator]();
      await input.next();
      await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      if (ownerKind === "independent") yield sdk({ type: "result", subtype: "success", session_id: "s",
        result_index: 0, result: "backgrounded" });
      await toolHook(options, "launch", "SubagentHandback", "child", fixture.taskId, { message: fixture.report });
      await promptHook(options, ownerKind === "independent" ? "handback" : "launch", fixture.prompt);
      const ownerToken = starts.at(-1)!;
      if (boundary === "interrupt") await host.interrupt();
      if (boundary === "reset") yield sdk({ type: "conversation_reset", new_conversation_id: "new" });
      if (boundary === "watchdog") expect(host.failStopTurnForWatchdog(ownerToken)).toBe(true);
      if (boundary === "fail-stop") yield sdk({ type: "result", subtype: "success", session_id: "s",
        result_index: ownerKind === "independent" ? 1 : 0, result: "wrong",
        origin: { kind: "task-notification" } });
      if (boundary === "EOF") return;
      if (boundary === "watchdog" || boundary === "fail-stop") {
        await toolHook(options, ownerKind === "independent" ? "handback" : "launch",
          "SubagentHandback", "late-child", fixture.taskId, { message: "LATE" });
        await promptHook(options, ownerKind === "independent" ? "handback" : "launch", render(fixture.taskId, "LATE"));
        await toolHook(options, ownerKind === "independent" ? "handback" : "launch",
          INTER_AGENT_TOOL_FQN, "frozen-send");
        delayed = host.toolOrigins.resolveBound("frozen-send");
        yield sdk({ type: "result", subtype: "success", session_id: "s",
          result_index: ownerKind === "independent" ? 2 : 1, result: "late",
          ...(ownerKind === "independent" ? { origin: { kind: "peer", handback: true,
            from: fixture.taskId, senderTaskId: fixture.taskId, body: observedBody } } : {}) });
        return;
      }
      yield sdk({ type: "result", subtype: "success", session_id: "s",
        result_index: ownerKind === "independent" ? 1 : 0, result: "done",
        ...(ownerKind === "independent" ? { origin: { kind: "peer", handback: true,
          from: fixture.taskId, senderTaskId: fixture.taskId, body: observedBody } } : {}) });
      await input.next();
      await promptHook(options, "next", "next");
      await toolHook(options, "launch", "SubagentHandback", "late-child", fixture.taskId, { message: "LATE" });
      await promptHook(options, "next", render(fixture.taskId, "LATE"));
      await toolHook(options, "next", INTER_AGENT_TOOL_FQN, "delayed-send");
      delayed = host.toolOrigins.resolveBound("delayed-send");
      yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: ownerKind === "independent" ? 2 : 1,
        result: "next" });
    });
    host = new AgentHost(config, {
      onState: () => {}, queryFn,
      onTurnStart: ({ turnToken }) => starts.push(turnToken),
      onTurnEnd: ({ turnToken, cancellation }) => {
        if (turnToken) ends.push({ token: turnToken, ...(cancellation ? { cancellation: cancellation.kind } : {}) });
        if (starts.length === (ownerKind === "independent" ? 3 : 2) && ends.length === starts.length) host.close();
      },
      onAdmissionFailStop: ({ turnToken }) => freezes.push(turnToken),
      onWatchdogFailStop: ({ turnToken }) => { if (turnToken) freezes.push(turnToken); },
    });
    const running = host.run("launch");
    if (boundary === "interrupt" || boundary === "reset") await host.send("next");
    await running;
    if (boundary === "interrupt" || boundary === "reset") {
      expect(starts).toHaveLength(ownerKind === "independent" ? 3 : 2);
      expect(ends.map(end => end.token)).toEqual(starts);
      expect(await delayed).toBeUndefined();
    } else {
      expect(starts).toHaveLength(ownerKind === "independent" ? 2 : 1);
      expect(ends.at(-1)?.token).toBe(starts.at(-1));
      if (boundary !== "EOF") {
        expect(freezes).toEqual([starts.at(-1)]);
        expect(await delayed).toBeUndefined();
      }
      await expect(host.send("new")).rejects.toThrow("agent host is closed");
    }
  });
});
