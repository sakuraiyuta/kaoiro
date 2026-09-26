import { it, expect, vi } from "vitest";
import { AgentHost } from "../src/host.js";
import { InterAgentTool, INTER_AGENT_TOOL_FQN } from "@kaoiro/agent-common";
const config = {
  agent_id: "review.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};
it.each([false, true])(
  "revokes both captured and later sends after admission freeze=%s",
  async (freeze) => {
    const starts: string[] = [],
      ends: string[] = [],
      warnings: string[] = [],
      states: string[] = [];
    const sink = vi.fn(async () => ({
      kind: "accepted" as const,
      stamp: null,
    }));
    const tool = new InterAgentTool({
      config,
      getState: () => host.state,
      send: () => {},
      sendInterAgent: sink,
      replyBasisMode: () => "v1",
    });
    let host: AgentHost;
    const queryFn = ({ prompt, options }: any): any =>
      Object.assign(
        (async function* () {
          const input = prompt[Symbol.asyncIterator]();
          const signal = { signal: new AbortController().signal };
          const hook = (id: string, text: string) =>
            options.hooks.UserPromptSubmit.at(-1).hooks[0](
              {
                hook_event_name: "UserPromptSubmit",
                session_id: "s",
                prompt_id: id,
                prompt: text,
              },
              undefined,
              signal,
            );
          const bind = (id: string) =>
            options.hooks.PreToolUse.at(-1).hooks[0](
              {
                hook_event_name: "PreToolUse",
                session_id: "s",
                prompt_id: "p2",
                tool_name: INTER_AGENT_TOOL_FQN,
                tool_use_id: id,
              },
              id,
              signal,
            );
          await input.next();
          yield { type: "system", subtype: "init", session_id: "s" };
          await hook("p1", "launch");
          yield {
            type: "system",
            subtype: "task_started",
            session_id: "s",
            task_id: "task",
            tool_use_id: "parent",
            task_type: "local_bash",
            is_backgrounded: true,
          };
          yield {
            type: "result",
            subtype: "success",
            result: "T1 done",
            session_id: "s",
          };
          await input.next();
          await hook("p2", "next");
          await bind("captured-before-freeze");
          const held = await host.toolOrigins.resolveBound(
            "captured-before-freeze",
          );
          if (freeze) {
            yield {
              type: "system",
              subtype: "task_notification",
              session_id: "s",
              task_id: "task",
              tool_use_id: "parent",
              status: "completed",
              output_file: "/tmp/task",
              summary: "done",
            };
            await hook(
              "foreign",
              "<task-notification><task-id>task</task-id><tool-use-id>parent</tool-use-id><status>completed</status><output-file>/tmp/task</output-file><summary>done</summary></task-notification>",
            );
            yield {
              type: "result",
              subtype: "success",
              result: "ambiguous",
              session_id: "s",
            };
            expect(host.state).toBe("error");
            expect(ends).toEqual([starts[0]]);
            await expect(host.send("rejected input")).rejects.toThrow();
          }
          await bind("new-after-freeze");
          const later = await Promise.race([
            host.toolOrigins.resolveBound("new-after-freeze"),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
          ]);
          const results = [];
          for (const origin of [held, later])
            results.push(
              await tool.invoke(
                {
                  to: "peer",
                  conversation_id: "cid",
                  kind: "response",
                  body: "late",
                },
                origin ? { origin } : undefined,
              ),
            );
          expect(held?.signal?.aborted).toBe(freeze);
          expect(later?.signal?.aborted).toBe(freeze ? undefined : false);
          if (freeze)
            expect(results.map((result) => result.isError)).toEqual([
              true,
              true,
            ]);
          expect(sink).toHaveBeenCalledTimes(freeze ? 0 : 2);
          if (!freeze)
            yield {
              type: "result",
              subtype: "success",
              result: "T2 done",
              session_id: "s",
            };
        })(),
        { interrupt: async () => {}, supportedModels: async () => [] },
      );
    host = new AgentHost(config, {
      queryFn,
      onState: (e) => states.push(e.state),
      warn: (w) => warnings.push(w),
      onTurnStart: ({ turnToken }) => {
        starts.push(turnToken);
        tool.prepareReplyInput(turnToken, [
          {
            version: "0",
            agent_id: "peer",
            persona: config.persona,
            display_name: "Peer",
            ts: "2026-09-27T00:00:00Z",
            type: "inter_agent_message",
            state: "thinking",
            payload: {
              to: config.agent_id,
              conversation_id: "cid",
              turn_number: starts.length === 1 ? 1 : 3,
              kind: "response",
              body: starts.length === 1 ? "launch" : "next",
              meta: { done: false, propose_next: "" },
              owner: { kind: "user", id: "operator" },
              new_conversation: false,
            },
            ext: {},
          },
        ]);
        tool.beginReplyInput(turnToken, undefined, true);
      },
      onPromptAdmitted: (t) => tool.confirmReplyInput(t),
      onTurnEnd: ({ turnToken }) => {
        if (turnToken) {
          ends.push(turnToken);
          tool.endReplyInput(turnToken);
        }
      },
    });
    const running = host.run();
    try {
      await host.send("launch");
      await host.send("next");
      await running;
    } finally {
      host.close();
    }
    expect(ends).toEqual(starts);
    expect(states.includes("error")).toBe(freeze);
    expect(warnings.some((warning) => warning.includes("ownership ambiguous"))).toBe(freeze);
  },
);
