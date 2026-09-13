// CodexHost#setPendingPermission as the waiting_permission state driver
// (issue #347): the permission twin of setPendingQuestion, plus the guards
// that keep a late settle from mis-stating a resting agent.
import { describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import type {
  Envelope,
  PendingPermissionExt,
  PendingQuestionExt,
  WrapperConfig,
} from "@kaoiro/agent-common";
import { CodexHost } from "../src/host.js";
import type { CodexClientLike, CodexThreadLike } from "../src/host.js";

const CONFIG: WrapperConfig = {
  agent_id: "host-1.codex-perm",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const RECORD: PendingPermissionExt = {
  request_id: "req-1",
  tool_name: "mcp__kaoiro__request_session_reset",
  input: { mode: "new" },
  ts: "T",
};

const QUESTION: PendingQuestionExt = {
  request_id: "q-1",
  questions: [
    {
      question: "Which?",
      header: "pick",
      multiSelect: false,
      options: [
        { label: "a", description: "A" },
        { label: "b", description: "B" },
      ],
    },
  ],
  ts: "T",
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** One turn that reports a tool call, parks until released, then completes. */
function parkedClient(release: Promise<void>): CodexClientLike {
  const thread: CodexThreadLike = {
    async runStreamed() {
      async function* gen(): AsyncGenerator<ThreadEvent> {
        yield {
          type: "item.started",
          item: {
            id: "call-1",
            type: "mcp_tool_call",
            server: "kaoiro",
            tool: "request_session_reset",
            arguments: {},
            status: "in_progress",
          },
        };
        await release;
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            cache_write_input_tokens: 0,
          },
        };
      }
      return { events: gen() };
    },
  };
  return { startThread: () => thread, resumeThread: () => thread };
}

function pendingOf(envelope: Envelope): Record<string, unknown> {
  const ext = (envelope.ext ?? {}) as Record<string, unknown>;
  return {
    permission: ext.pending_permission,
    question: ext.pending_question,
  };
}

async function inTurn(): Promise<{
  host: CodexHost;
  states: Envelope[];
  release: () => void;
  done: Promise<void>;
}> {
  const states: Envelope[] = [];
  const gate = deferred();
  let started = false;
  const host = new CodexHost(CONFIG, {
    onState: (envelope) => states.push(envelope),
    onTurnStart: () => {
      started = true;
    },
    appendSystemPrompt: "p",
    codexFactory: () => parkedClient(gate.promise),
    now: () => "T",
  });
  const done = host.run("hi");
  await vi.waitFor(() => expect(started).toBe(true));
  await vi.waitFor(() => expect(states.at(-1)?.state).toBe("tool_running"));
  return { host, states, release: gate.resolve, done };
}

describe("CodexHost#setPendingPermission (issue #347)", () => {
  it("stamps the record onto waiting_permission and returns to tool_running without it", async () => {
    const { host, states, release, done } = await inTurn();
    host.setPendingPermission(RECORD);
    expect(states.at(-1)?.state).toBe("waiting_permission");
    expect(pendingOf(states.at(-1)!).permission).toEqual(RECORD);

    host.setPendingPermission(null);
    expect(states.at(-1)?.state).toBe("tool_running");
    expect(pendingOf(states.at(-1)!).permission).toBeUndefined();

    release();
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe("waiting_input"));
    host.close();
    await done;
  });

  it("ignores a record while no turn is active and emits nothing", () => {
    const states: Envelope[] = [];
    const host = new CodexHost(CONFIG, {
      onState: (envelope) => states.push(envelope),
      appendSystemPrompt: "p",
      now: () => "T",
    });
    host.setPendingPermission(RECORD);
    host.setPendingPermission(null);
    expect(states).toHaveLength(0);
  });

  it("a clear that lands after the terminal re-emits the resting state, never tool_running", async () => {
    const { host, states, release, done } = await inTurn();
    host.setPendingPermission(RECORD);
    release();
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe("waiting_input"));
    // The stale stamp rode the terminal envelope; clearing it now must fix
    // the projection in place rather than drag the agent back to busy.
    expect(pendingOf(states.at(-1)!).permission).toEqual(RECORD);
    const before = states.length;
    host.setPendingPermission(null);
    expect(states).toHaveLength(before + 1);
    expect(states.at(-1)?.state).toBe("waiting_input");
    expect(pendingOf(states.at(-1)!).permission).toBeUndefined();
    host.close();
    await done;
  });

  it("carries a pending question and a pending permission side by side", async () => {
    const { host, states, release, done } = await inTurn();
    host.setPendingQuestion(QUESTION);
    host.setPendingPermission(RECORD);
    expect(states.at(-1)?.state).toBe("waiting_permission");
    expect(pendingOf(states.at(-1)!)).toEqual({
      permission: RECORD,
      question: QUESTION,
    });
    host.setPendingPermission(null);
    host.setPendingQuestion(null);
    expect(pendingOf(states.at(-1)!)).toEqual({
      permission: undefined,
      question: undefined,
    });
    release();
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe("waiting_input"));
    host.close();
    await done;
  });
});
