// issue #285 invariant: a state asserting "the SDK is working" must be
// backed by an SDK-active turn. Without one, no frame is coming, so nothing
// will ever leave that state and the agent reads as busy forever — the shape
// of the 6-hour freeze. The host warns rather than throws: the operator still
// needs whatever output remains.

import { describe, expect, it } from "vitest";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentHost } from "../src/host.js";
import type { AgentHostOptions } from "../src/host.js";
import type { WrapperConfig } from "@kaoiro/agent-common";

const config: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const msg = (shape: unknown): SDKMessage => shape as SDKMessage;
const assistant = (content: unknown): SDKMessage =>
  msg({ type: "assistant", message: { content } });
const result = (subtype: string): SDKMessage => msg({ type: "result", subtype });

type QueryArgs = { prompt: AsyncIterable<SDKUserMessage>; options: Options };
type QueryFn = NonNullable<AgentHostOptions["queryFn"]>;

/** Runs one wrapper-fed turn, then optionally emits a straggler frame after
 *  its result — the position where no turn owns the state any more. */
async function run(straggler: boolean): Promise<{
  states: string[];
  warnings: string[];
}> {
  const states: string[] = [];
  const warnings: string[] = [];

  const queryFn = ((args: QueryArgs) => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      const input = args.prompt[Symbol.asyncIterator]();
      await input.next();
      yield assistant([{ type: "text", text: "hi" }]);
      yield result("success");
      if (straggler) {
        yield assistant([
          { type: "tool_use", id: "tu_late", name: "Read", input: {} },
        ]);
      }
    }
    return Object.assign(gen(), {
      interrupt: async () => {},
    }) as unknown as Query;
  }) as unknown as QueryFn;

  const host = new AgentHost(config, {
    onState: (envelope) => states.push(envelope.state),
    warn: (message) => warnings.push(message),
    queryFn,
    now: () => "T",
  });
  const running = host.run();
  await host.send("go");
  host.close();
  await running;

  return { states, warnings };
}

describe("issue #285 — turn-backed busy states", () => {
  it("warns when a busy state is emitted with no active turn", async () => {
    const { states, warnings } = await run(true);

    expect(states).toContain("tool_running");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tool_running emitted with no active turn");
  });

  it("stays silent through an ordinary turn", async () => {
    const { states, warnings } = await run(false);

    expect(states).toContain("thinking");
    expect(states.slice(-2)).toEqual(["done", "waiting_input"]);
    expect(warnings).toEqual([]);
  });
});
