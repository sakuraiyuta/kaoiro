import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { INTER_AGENT_TOOL_FQN } from "@kaoiro/agent-common";
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


describe("review regression probes", () => {
  it.each([["wrapper", "s"], ["notification", "s"], ["independent", "s"],
    ["wrapper", "foreign"], ["notification", "foreign"], ["independent", "foreign"]] as const)(
    "checks %s handback owner terminal session %s", async (kind, terminalSession) => {
    const failStops: string[] = []; const successfulEnds: string[] = []; const sessionIds: string[] = [];
    let host!: AgentHost;
    const queryFn = fakeQuery(async function* ({ prompt, options }) {
      await prompt[Symbol.asyncIterator]().next(); await promptHook(options, "launch", "launch");
      yield sdk({ type: "system", subtype: "init", session_id: "s" });
      await toolHook(options, "launch", "Agent", "parent");
      yield sdk({ type: "system", subtype: "task_started", session_id: "s", task_id: fixture.taskId,
        tool_use_id: "parent", task_type: "local_agent", is_backgrounded: true });
      if (kind !== "wrapper") {
        yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 0, result: "launch done" });
      }
      if (kind === "notification") {
        yield sdk({ type: "system", subtype: "task_notification", session_id: "s", uuid: "n", task_id: fixture.taskId,
          tool_use_id: "parent", status: "completed", output_file: "/tmp/task", summary: "done" });
        await promptHook(options, "owner", `<task-notification><task-id>${fixture.taskId}</task-id><tool-use-id>parent</tool-use-id><status>completed</status><output-file>/tmp/task</output-file><summary>Agent finished</summary><result>done</result></task-notification>`);
      }
      await toolHook(options, "launch", "SubagentHandback", "child", fixture.taskId, { message: fixture.report });
      await promptHook(options, kind === "wrapper" ? "launch" : "owner", fixture.prompt);
      yield sdk({ type: "result", subtype: "success", session_id: terminalSession, result_index: 1, result: "wrong session",
        ...(kind === "notification" ? { origin: { kind: "task-notification" } } : {}),
        ...(kind === "independent" ? { origin: { kind: "peer", handback: true, from: fixture.taskId,
          senderTaskId: fixture.taskId, body: observedBody } } : {}) });
      if (terminalSession === "foreign") {
        yield sdk({ type: "result", subtype: "success", session_id: "s", result_index: 1, result: "late",
          ...(kind === "notification" ? { origin: { kind: "task-notification" } } : {}),
          ...(kind === "independent" ? { origin: { kind: "peer", handback: true, from: fixture.taskId,
            senderTaskId: fixture.taskId, body: observedBody } } : {}) });
      }
    });
    host = new AgentHost(config, {onState:()=>{},queryFn,
      onSessionId: id => sessionIds.push(id),
      onAdmissionFailStop: ({turnToken}) => failStops.push(turnToken),
      onTurnEnd: ({turnToken,cancellation}) => {if(!cancellation) successfulEnds.push(turnToken!);}
    });
    await host.run("launch");
    expect(failStops).toHaveLength(terminalSession === "s" ? 0 : 1);
    expect(successfulEnds).toHaveLength((kind === "wrapper" ? 0 : 1) + (terminalSession === "s" ? 1 : 0));
    expect(sessionIds).toEqual(["s"]);
  });
  it.each(["live", "independent"] as const)("binds an exact %s notification with report markup", async kind => {
    const report = "report quotes <agent-message>";
    let binding!: ReturnType<AgentHost["toolOrigins"]["resolveBound"]>;let host!:AgentHost;
    const queryFn=fakeQuery(async function*({prompt,options}) {
      await prompt[Symbol.asyncIterator]().next();await promptHook(options,"launch","launch");
      yield sdk({type:"system",subtype:"init",session_id:"s"});
      await toolHook(options,"launch","Agent","parent");
      yield sdk({type:"system",subtype:"task_started",session_id:"s",task_id:fixture.taskId,tool_use_id:"parent",task_type:"local_agent",is_backgrounded:true});
      if (kind === "independent") yield sdk({type:"result",subtype:"success",session_id:"s",result_index:0,result:"backgrounded"});
      yield sdk({type:"system",subtype:"task_notification",session_id:"s",uuid:"n",task_id:fixture.taskId,tool_use_id:"parent",status:"completed",output_file:"/tmp/task",summary:report});
      const promptId = kind === "live" ? "launch" : "notice";
      await promptHook(options,promptId,`<task-notification><task-id>${fixture.taskId}</task-id><tool-use-id>parent</tool-use-id><status>completed</status><output-file>/tmp/task</output-file><summary>Agent finished</summary><result>${report}</result></task-notification>`);
      await toolHook(options,promptId,INTER_AGENT_TOOL_FQN,"send");binding=host.toolOrigins.resolveBound("send");
      yield sdk({type:"result",subtype:"success",session_id:"s",result_index:kind === "live" ? 0 : 1,result:"done",
        ...(kind === "independent" ? {origin:{kind:"task-notification"}} : {})});
    });
    host=new AgentHost(config,{onState:()=>{},queryFn});await host.run("launch");expect((await binding)?.token).toBeDefined();
  });
});
