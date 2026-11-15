import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { AgentHost } from "../src/host.js";
import { runClaudeCli } from "../src/cli.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(["result", "terminal"])(
  "keeps workless early input after the claimed MCP cut (%s)", async mode => {
  const tool = deferred(), released = deferred(), finished = deferred();
  const pushed: string[] = [];
  let host!: AgentHost;
  const wire = await phoenixLoopback(() => ({
    inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "i",
    inter_agent_reply_basis: "v1", work_control: "v1", delivery_policy: "v1",
  }), event => event === "yield_claim" ? { granted: true } : {});
  const input = (seq: number, grant: string, work = true) => ({
    version: "0", agent_id: `peer-${seq}`, ts: "T",
    persona: { id: "p", name: "P", sprite_set: "p" },
    type: "inter_agent_message", state: "thinking", delivery_seq: seq,
    payload: { to: "self", conversation_id: `cid-${seq}`, turn_number: 1,
      kind: "inform", body: `INPUT-${seq}`,
      ...(work ? { work: { work_id: "W" } } : {}),
      delivery_authority: { requested: grant, granted: grant,
        ...(grant === "yield" ? { yield_token: "token", work_id: "W",
          authority_epoch: 1 } : {}) } },
  });
  const running = runClaudeCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined,
      resume: undefined }),
    loadConfig: () => ({ agent_id: "self", display_name: "Self",
      persona: { id: "p", name: "P", sprite_set: "p" },
      server_url: wire.url, in_flight_delivery_enabled: true }),
    createHost: (cfg, options) => {
      host = new AgentHost(cfg, { ...options, queryFn: ((args: any) =>
        Object.assign((async function* () {
          const iter = args.prompt[Symbol.asyncIterator]();
          const hook = async (name: string, fields: any) =>
            args.options.hooks[name].at(-1).hooks[0]({
              hook_event_name: name, session_id: "s", ...fields,
            }, fields.tool_use_id, { signal: new AbortController().signal });
          const root = await iter.next();
          await hook("UserPromptSubmit", { prompt_id: "p1",
            prompt: root.value.message.content });
          yield { type: "system", subtype: "init", session_id: "s" };
          await hook("PreToolUse", { prompt_id: "p1",
            tool_use_id: "mcp1", tool_name: "mcp__external__slow" });
          tool.resolve(); await released.promise;
          if (mode === "result") yield {
            type: "user", session_id: "s", message: { role: "user",
              content: [{ type: "tool_result", tool_use_id: "mcp1",
                content: "COMPLETE" }] },
          };
          else yield { type: "result", session_id: "s", result_index: 0,
            subtype: "success", result: "terminal" };
          const cut = (await iter.next()).value;
          pushed.push(cut.message.content);
          expect(cut.priority).toBe(mode === "result" ? "now" : undefined);
          if (mode === "result") yield { type: "result", session_id: "s",
            result_index: 0, subtype: "success", result: "done" };
          await hook("UserPromptSubmit", { prompt_id: "p2",
            prompt: cut.message.content });
          const early = (await iter.next()).value;
          pushed.push(early.message.content);
          await hook("UserPromptSubmit", { prompt_id: "p2",
            prompt: early.message.content });
          yield { type: "result", session_id: "s", result_index: 1,
            subtype: "success", result: "done" };
          finished.resolve();
          await stop.promise;
        })(), { interrupt: async () => {}, supportedModels: async () => [] })
      ) as never });
      host.probeRateLimits = async () => {};
      return host;
    },
  });
  const stop = deferred();
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await vi.waitFor(() => expect(wire.joins).toBe(1));
    wire.push("delivery_policy", { version: "0", revision: 1, policy: "on" });
    wire.push("persona_prompt", { prompt: "system" });
    wire.push("envelope", input(1, "normal")); await tool.promise;
    wire.push("envelope", input(2, "yield"));
    await vi.waitFor(() => expect(host.canFoldLiveInput()).toBe(false));
    const now = performance.now.bind(performance);
    clock = vi.spyOn(performance, "now")
      .mockImplementation(() => now() + 3_000);
    wire.push("envelope", input(3, "early", false));
    await vi.waitFor(() => expect(wire.received.some(x =>
      x.event === "delivery_stage" && x.payload.delivery_seq === 3)
    ).toBe(true));
    expect(pushed).toEqual([]);
    released.resolve(); await finished.promise;
    expect(pushed[0]).toContain("INPUT-2");
    expect(pushed[1]).toContain("INPUT-3");
    await vi.waitFor(() => {
      const dispositions = wire.received.filter(x =>
        x.event === "delivery_stage" && x.payload.yield_disposition);
      expect(dispositions).toHaveLength(1);
      expect(dispositions[0]!.payload.yield_disposition)
        .toMatchObject(mode === "result" ? { outcome: "cut" }
          : { outcome: "downgraded", reason: "no_work_input" });
    });
  } finally {
    clock?.mockRestore(); released.resolve(); stop.resolve();
    host?.close(); await running; await wire.close();
  }
}, 10_000);
