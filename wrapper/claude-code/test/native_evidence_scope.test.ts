import { chmod, mkdtemp, readFile, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HookInput, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { InterAgentTool, INTER_AGENT_TOOL_FQN, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import { AgentHost, nativeUnavailableMessage, type AgentHostOptions } from "../src/host.js";
import { NativeTranscriptReader } from "../src/native_transcript.js";

// Issue #426 B1: a native evidence failure stops the whole host only while a
// native turn holds a lease; otherwise only native continuations close and
// ordinary input continues.

const config = { agent_id: "self", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://localhost" };
const scratch: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const frame = (value: unknown) => value as SDKMessage;
const inbound = (n: number): Envelope => ({ version: "0", agent_id: "peer", persona: config.persona, display_name: "P", ts: "2026-10-17T00:00:00Z",
  type: "inter_agent_message", state: "thinking", payload: { to: "self", conversation_id: "c", turn_number: n, kind: "request", body: "launch",
    meta: { done: false, propose_next: "" }, owner: { kind: "user", id: "operator" }, new_conversation: false }, ext: {} });
const before = '{"type":"assistant","text":"before"}\n';

type Fire = (name: "UserPromptSubmit" | "PreToolUse" | "PostToolUse", payload: Record<string, unknown>, callId?: string) => Promise<unknown>;

async function harness(native: boolean, path: string, dir: string,
  script: (fire: Fire, prompts: AsyncIterator<SDKUserMessage>, host: () => AgentHost, tool: InterAgentTool) => AsyncGenerator<SDKMessage>) {
  const record = { outgoing: [] as Envelope[], warnings: [] as string[], failStops: [] as unknown[], unavailable: [] as string[],
    states: [] as string[], starts: [] as string[] };
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
    sendInterAgent: async envelope => { record.outgoing.push(envelope); return { kind: "accepted", stamp: null }; } });
  let host!: AgentHost;
  const queryFn = ((args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const fire: Fire = async (name, payload, callId) =>
      args.options.hooks![name]!.at(-1)!.hooks[0]!({ hook_event_name: name, session_id: "s", transcript_path: path, cwd: dir, ...payload } as HookInput,
        callId, { signal: new AbortController().signal });
    return Object.assign(script(fire, args.prompt[Symbol.asyncIterator](), () => host, tool), { interrupt: async () => {} }) as unknown as Query;
  }) as NonNullable<AgentHostOptions["queryFn"]>;
  host = new AgentHost(config, { queryFn, onState: envelope => record.states.push(envelope.state), warn: message => record.warnings.push(message),
    nativeContinuations: native, ...(native ? { nativeReplyBasis: tool.replyBasis } : {}),
    onAdmissionFailStop: info => record.failStops.push(info), onNativeUnavailable: ({ reason }) => record.unavailable.push(reason),
    onTurnStart: ({ turnToken, kind }) => { record.starts.push(kind ?? "wrapper"); if (kind !== "sdk_notification") tool.replyBasis.begin(turnToken, [inbound(1)], undefined, true); },
    onPromptAdmitted: token => tool.confirmReplyInput(token), onTurnEnd: ({ turnToken }) => { if (turnToken) tool.endReplyInput(turnToken); } });
  try { await host.run("launch"); } finally { host.close(); }
  return record;
}

async function scratchDir(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `kaoiro-426-${name}-`)); scratch.push(dir);
  return { dir, path: join(dir, "native.jsonl") };
}

// Root may read a mode-0200 file, so that row only proves anything for other users.
const readDenied = process.getuid?.() !== 0;
const conditions = ["empty", "missing", ...(readDenied ? ["write-only"] : []), "bad-json", "deleted-after-read", "replaced-after-read",
  "prefix-changed-after-read", "path-changed-same-session"] as const;
const reasonOf: Record<string, string | undefined> = {
  "write-only": "evidence_unreadable", "bad-json": "evidence_unreadable", "deleted-after-read": "evidence_unreadable",
  "replaced-after-read": "evidence_unreadable", "prefix-changed-after-read": "evidence_unreadable",
  "path-changed-same-session": "session_or_path_changed",
};
// Captures made by the two root hooks: a failure at the first hook leaves the second one uncaptured.
const capturesOf: Record<string, number> = {
  empty: 2, missing: 2, "write-only": 1, "bad-json": 1, "deleted-after-read": 2, "replaced-after-read": 2,
  "prefix-changed-after-read": 2, "path-changed-same-session": 1,
};

describe("native evidence failures outside a lease (issue #426)", () => {
  it.each(conditions.flatMap(condition => [true, false].map(native => ({ condition, native }))))(
    "keeps ordinary input and its actual send for $condition (native $native)", async ({ condition, native }) => {
      const { dir, path } = await scratchDir("scope");
      if (condition !== "missing") await writeFile(path, condition === "bad-json" ? "broken\n" : condition.endsWith("after-read") ? before : "");
      if (condition === "write-only") await chmod(path, 0o200);
      let captures = 0;
      const capture = NativeTranscriptReader.prototype.capture;
      vi.spyOn(NativeTranscriptReader.prototype, "capture").mockImplementation(function (this: NativeTranscriptReader, promptId) {
        captures++; return capture.call(this, promptId);
      });
      let sendResult: { isError?: boolean } | undefined;
      const record = await harness(native, path, dir, async function* (fire, prompts, host, tool) {
        await prompts.next();
        await fire("UserPromptSubmit", { prompt_id: "p1", prompt: "launch", source: "sdk" });
        yield frame({ type: "system", subtype: "init", session_id: "s" });
        yield frame({ type: "result", session_id: "s", result_index: 0, uuid: "r0", subtype: "success", is_error: false, result: "done" });
        if (condition === "deleted-after-read") await rm(path);
        if (condition === "replaced-after-read") { await writeFile(path + ".new", await readFile(path)); await rename(path + ".new", path); }
        if (condition === "prefix-changed-after-read") await writeFile(path, before.replace("before", "forged"));
        await host().send("second");
        await prompts.next();
        await fire("UserPromptSubmit", { prompt_id: "p2", prompt: "second", source: "sdk",
          ...(condition === "path-changed-same-session" ? { transcript_path: path + ".moved" } : {}) });
        await fire("PreToolUse", { prompt_id: "p2", tool_name: INTER_AGENT_TOOL_FQN, tool_use_id: "send", tool_input: {} }, "send");
        const bound = await host().resolveToolOrigin("send");
        sendResult = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "reply" }, bound ? { origin: bound } : {});
        yield frame({ type: "result", session_id: "s", result_index: 1, uuid: "r1", subtype: "success", is_error: false, result: "done" });
      });
      expect(record.failStops).toHaveLength(0);
      expect(record.states).not.toContain("error");
      expect(record.outgoing).toHaveLength(1);
      expect(sendResult?.isError).toBeUndefined();
      const reason = native ? reasonOf[condition] : undefined;
      expect(record.unavailable).toEqual(reason ? [reason] : []);
      expect(record.warnings.filter(message => message.includes("native continuations are unavailable")))
        .toEqual(reason ? [nativeUnavailableMessage(reason as never)] : []);
      expect(captures).toBe(native ? capturesOf[condition] : 0);
    }, 10000);

  it.each([true, false])("leaves the existing guard to stop a hook from another session (native %s)", async native => {
    const { dir, path } = await scratchDir("session");
    await writeFile(path, "");
    const record = await harness(native, path, dir, async function* (fire, prompts, host) {
      await prompts.next();
      await fire("UserPromptSubmit", { prompt_id: "p1", prompt: "launch", source: "sdk" });
      yield frame({ type: "system", subtype: "init", session_id: "s" });
      yield frame({ type: "result", session_id: "s", result_index: 0, uuid: "r0", subtype: "success", is_error: false, result: "done" });
      await host().send("second");
      await prompts.next();
      await fire("UserPromptSubmit", { prompt_id: "p2", prompt: "second", source: "sdk", session_id: "s2" });
      yield frame({ type: "result", session_id: "s", result_index: 1, uuid: "r1", subtype: "success", is_error: false, result: "done" });
    });
    expect(record.failStops).toHaveLength(1);
    expect(record.warnings.some(message => message.includes("ownership ambiguous"))).toBe(true);
  }, 10000);
});

// A Monitor launched by the confirmed root, then the hook of its event root.
async function* eventRoot(fire: Fire, prompts: AsyncIterator<SDKUserMessage>, path: string): AsyncGenerator<SDKMessage> {
  await prompts.next();
  await fire("UserPromptSubmit", { prompt_id: "parent", prompt: "launch", source: "sdk" });
  yield frame({ type: "system", subtype: "init", session_id: "s" });
  const input = { command: "printf event", description: "watch", timeout_ms: 1000 };
  const prepared = await fire("PreToolUse", { prompt_id: "parent", tool_name: "Monitor", tool_use_id: "launch", tool_input: input }, "launch") as
    { hookSpecificOutput: { updatedInput: Record<string, unknown> } };
  const effective = prepared.hookSpecificOutput.updatedInput;
  yield frame({ type: "system", subtype: "task_started", session_id: "s", task_id: "task", run_id: "run", tool_use_id: "launch",
    task_type: "local_bash", is_backgrounded: true, description: effective.description });
  await fire("PostToolUse", { prompt_id: "parent", tool_name: "Monitor", tool_use_id: "launch", tool_input: effective,
    tool_response: { taskId: "task", timeoutMs: 1000, persistent: false } }, "launch");
  yield frame({ type: "result", session_id: "s", result_index: 0, uuid: "r0", subtype: "success", is_error: false, result: "launched" });
  const text = `<task-notification><task-id>task</task-id><summary>Monitor event: "${String(effective.description)}"</summary><event>hello</event></task-notification>`;
  await appendFile(path, JSON.stringify({ type: "user", sessionId: "s", promptId: "return", uuid: "opener", isSidechain: false,
    turnPosition: { promptIndex: 0 }, promptSource: "system", turnOrigin: "task_notification",
    origin: { kind: "task-notification", producer: "session-task" }, message: { role: "user", content: text } }) + "\n");
  await fire("UserPromptSubmit", { prompt_id: "return", prompt: text });
}

// The event root proved into a native turn that holds a lease; `during` runs while that turn is live.
async function* leasedEvent(fire: Fire, prompts: AsyncIterator<SDKUserMessage>, host: () => AgentHost, path: string,
  during: (bound: Awaited<ReturnType<AgentHost["resolveToolOrigin"]>>) => AsyncGenerator<SDKMessage>): AsyncGenerator<SDKMessage> {
  yield* eventRoot(fire, prompts, path);
  await fire("PreToolUse", { prompt_id: "return", tool_name: INTER_AGENT_TOOL_FQN, tool_use_id: "send", tool_input: {} }, "send");
  const bound = await host().resolveToolOrigin("send");
  expect(bound).toBeDefined();
  yield* during(bound);
}

// Holds the proof acquisition's capture of the event root until `release`.
function holdAcquisition() {
  let armed = false, signalEntered!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const capture = NativeTranscriptReader.prototype.capture;
  vi.spyOn(NativeTranscriptReader.prototype, "capture").mockImplementation(async function (this: NativeTranscriptReader, promptId) {
    if (armed && promptId === "return") { armed = false; signalEntered(); await gate; }
    return capture.call(this, promptId);
  });
  return { arm: () => { armed = true; }, entered, release: () => release() };
}
const nativeResult = frame({ type: "result", session_id: "s", result_index: 1, uuid: "r1", subtype: "success", is_error: false, result: "reported",
  origin: { kind: "task-notification", producer: "session-task" } });

describe("native evidence failures while a native turn holds a lease (issue #426)", () => {
  it("stops the host when a root hook fails while the native turn is live", async () => {
    const { dir, path } = await scratchDir("leased-hook");
    await writeFile(path, "");
    const record = await harness(true, path, dir, (fire, prompts, host) => leasedEvent(fire, prompts, host, path, async function* () {
      await appendFile(path, "broken\n");
      await fire("UserPromptSubmit", { prompt_id: "fold", prompt: "folded input" });
      yield nativeResult;
    }));
    expect(record.starts).toContain("sdk_notification");
    expect(record.failStops).toHaveLength(1);
    expect(record.unavailable).toEqual([]);
    expect(record.warnings).toContain("[kaoiro] native transcript evidence damaged; restart required");
  }, 10000);

  // Design r3 9.1 (fuji's dispatch race): the decision uses the lease when the failure is detected.
  it.each(["ended-and-damaged", "live-and-damaged", "ended-and-readable"])("judges a dispatch validation failure by the state at detection (%s)", async condition => {
    const { dir, path } = await scratchDir("dispatch");
    await writeFile(path, "");
    let hold = false, signalEntered!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const validate = NativeTranscriptReader.prototype.validate;
    vi.spyOn(NativeTranscriptReader.prototype, "validate").mockImplementation(async function (this: NativeTranscriptReader, anchor) {
      if (hold) { signalEntered(); await gate; }
      return validate.call(this, anchor);
    });
    let sendResult: { isError?: boolean } | undefined, stateAfter = "";
    const record = await harness(true, path, dir, (fire, prompts, host, tool) => leasedEvent(fire, prompts, host, path, async function* (bound) {
      hold = true;
      const sending = tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "report" }, { origin: bound! });
      await entered;
      if (condition.startsWith("ended")) yield nativeResult;
      if (condition.endsWith("damaged")) await appendFile(path, "broken\n");
      release();
      sendResult = await sending;
      stateAfter = host().state;
      if (condition.startsWith("live")) yield nativeResult;
    }));
    expect(record.outgoing).toHaveLength(0);
    expect(sendResult?.isError).toBe(true);
    expect(record.failStops).toHaveLength(condition === "live-and-damaged" ? 1 : 0);
    expect(record.unavailable).toEqual(condition === "ended-and-damaged" ? ["dispatch_evidence_unreadable"] : []);
    expect(stateAfter).toBe(condition === "live-and-damaged" ? "error" : "waiting_input");
  }, 10000);
});

describe("native evidence failures during a proof acquisition (issue #426)", () => {
  it("closes native when the root's terminal ends an acquisition whose capture then fails", async () => {
    const { dir, path } = await scratchDir("acquire-terminal");
    await writeFile(path, "");
    const hold = holdAcquisition();
    let bound: Awaited<ReturnType<AgentHost["resolveToolOrigin"]>>, sendResult: { isError?: boolean } | undefined;
    const record = await harness(true, path, dir, async function* (fire, prompts, host, tool) {
      yield* eventRoot(fire, prompts, path);
      hold.arm();
      const pending = fire("PreToolUse", { prompt_id: "return", tool_name: INTER_AGENT_TOOL_FQN, tool_use_id: "send", tool_input: {} }, "send");
      await hold.entered;
      // The terminal drains the unowned root and clears its pending proof (host.ts result handling).
      yield nativeResult;
      await appendFile(path, "broken\n");
      hold.release();
      await pending;
      bound = await host().resolveToolOrigin("send");
      sendResult = await tool.invoke({ to: "peer", conversation_id: "c", kind: "response", body: "report" }, bound ? { origin: bound } : {});
    });
    expect(record.failStops).toHaveLength(0);
    expect(record.unavailable).toEqual(["acquisition_failed"]);
    expect(record.warnings).toContain("native continuation proof acquisition refused; call cannot revive");
    expect(record.starts).not.toContain("sdk_notification");
    expect(bound).toBeUndefined();
    expect(record.outgoing).toHaveLength(0);
    expect(sendResult?.isError).toBe(true);
    expect(record.states).not.toContain("error");
  }, 10000);

  it("stays silent when close() ends an acquisition", async () => {
    const { dir, path } = await scratchDir("acquire-close");
    await writeFile(path, "");
    const hold = holdAcquisition();
    const record = await harness(true, path, dir, async function* (fire, prompts, host) {
      yield* eventRoot(fire, prompts, path);
      hold.arm();
      const pending = fire("PreToolUse", { prompt_id: "return", tool_name: INTER_AGENT_TOOL_FQN, tool_use_id: "send", tool_input: {} }, "send");
      await hold.entered;
      host().close();
      hold.release();
      await pending;
      // The root's own terminal drains it, so the existing stream-end guard has nothing to stop.
      yield nativeResult;
    });
    expect(record.unavailable).toEqual([]);
    expect(record.warnings.some(message => message.includes("native continuations are unavailable"))).toBe(false);
    expect(record.failStops).toHaveLength(0);
  }, 10000);
});

describe("peer input through the CLI after native closes (issue #426)", () => {
  it.each([...(readDenied ? ["write-only"] : []), "bad-json"].flatMap(condition => [undefined, "0"].map(flag => ({ condition, flag }))))(
    "admits the next peer message for $condition (flag $flag)", async ({ condition, flag }) => {
      vi.stubEnv("KAOIRO_CLAUDE_NATIVE_CONTINUATIONS", flag);
      const { dir, path } = await scratchDir("cli-peer");
      await writeFile(path, condition === "bad-json" ? "broken\n" : "");
      if (condition === "write-only") await chmod(path, 0o200);
      const record = { failStops: 0, unavailable: [] as string[], inputs: 0, states: [] as string[] };
      let host!: AgentHost, linkOptions!: Record<string, any>, hostReady!: () => void;
      const ready = new Promise<void>(resolve => { hostReady = resolve; });
      const turnEnds: Array<() => void> = [];
      const turnEnd = () => new Promise<void>(resolve => turnEnds.push(resolve));
      const queryFn = ((args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Object.assign((async function* () {
        let n = 0;
        for await (const input of args.prompt) {
          record.inputs++;
          const content = input.message.content;
          const text = typeof content === "string" ? content : (content as Array<{ type: string; text?: string }>).find(part => part.type === "text")?.text ?? "";
          await args.options.hooks!.UserPromptSubmit!.at(-1)!.hooks[0]!({ hook_event_name: "UserPromptSubmit", session_id: "s", transcript_path: path, cwd: dir,
            prompt_id: `p${n}`, prompt: text, source: "sdk" } as HookInput, undefined, { signal: new AbortController().signal });
          if (n === 0) yield frame({ type: "system", subtype: "init", session_id: "s" });
          yield frame({ type: "result", session_id: "s", result_index: n, uuid: `r${n}`, subtype: "success", is_error: false, result: "done" });
          n++;
        }
      })(), { interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query) as NonNullable<AgentHostOptions["queryFn"]>;
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const message = (seq: number) => ({ version: "0", agent_id: "peer", persona: config.persona, display_name: "Peer", ts: "2026-10-17T00:00:00Z",
        type: "inter_agent_message", state: "thinking", delivery_seq: seq, payload: { to: config.agent_id, conversation_id: "c", turn_number: seq,
          kind: "request", body: `peer message ${seq}`, meta: { done: false, propose_next: "" } } });
      try {
        const running = runClaudeCli({
          parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
          loadConfig: () => ({ ...config }),
          createServerLink: (_url, _id, options) => {
            linkOptions = options as unknown as Record<string, any>;
            queueMicrotask(() => { options.onReplyBasisMode?.("v1"); options.onPersonaPrompt?.("system prompt"); });
            return { close() {}, send() {}, currentSessionId: () => null, setSessionId() {}, reportSessionLifecycle() {}, reportDisconnectIntent: async () => true,
              acknowledgeInterAgentDelivery() {}, flushInterAgentRetirements: async () => {}, retireInterAgentDeliveries: () => true } as never;
          },
          createHost: (cfg, options) => {
            host = new AgentHost(cfg, { ...options, queryFn,
              onState: envelope => { record.states.push(envelope.state); options.onState?.(envelope); },
              onTurnEnd: info => { options.onTurnEnd?.(info); turnEnds.shift()?.(); },
              onAdmissionFailStop: info => { record.failStops++; options.onAdmissionFailStop?.(info); },
              onNativeUnavailable: info => { record.unavailable.push(info.reason); options.onNativeUnavailable?.(info); } });
            host.probeRateLimits = async () => {};
            hostReady();
            return host;
          },
        });
        await ready;
        linkOptions.onInterAgentDeliveryStatus?.({ acked_seq: 0 });
        let ended = turnEnd(); await linkOptions.onInterAgentMessage(message(1)); await ended;
        ended = turnEnd(); await linkOptions.onInterAgentMessage(message(2)); await ended;
        host.close();
        await running;
      } finally { stderr.mockRestore(); stdout.mockRestore(); vi.unstubAllEnvs(); }
      expect(record.failStops).toBe(0);
      expect(record.inputs).toBe(2);
      expect(record.states).not.toContain("error");
      expect(record.unavailable).toEqual(flag === "0" ? [] : ["evidence_unreadable"]);
    }, 15000);
});

describe("native unavailability in the operator log (issue #426)", () => {
  it("puts the host's notice into the server log once", async () => {
    const cliConfig: WrapperConfig = { ...config, server_url: "ws://localhost:4000/wrapper" };
    const sent: Envelope[] = [];
    let hostOptions: AgentHostOptions | undefined;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runClaudeCli({
        parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
        loadConfig: () => ({ ...cliConfig }),
        createServerLink: (_url, _agentId, options) => {
          queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
          return { close: () => {}, currentSessionId: () => null, send: (envelope: Envelope) => { sent.push(envelope); } } as never;
        },
        createHost: (_cfg, options) => {
          hostOptions = options;
          return { state: "idle", statusExtSnapshot: () => ({}), run: async () => { options.onNativeUnavailable?.({ reason: "evidence_unreadable" }); } } as never;
        },
      });
    } finally { stderr.mockRestore(); stdout.mockRestore(); vi.unstubAllEnvs(); }
    expect(hostOptions?.onNativeUnavailable).toBeTypeOf("function");
    const logs = sent.filter(envelope => envelope.type === "log" &&
      (envelope.payload as { text?: string }).text === nativeUnavailableMessage("evidence_unreadable"));
    expect(logs).toHaveLength(1);
    expect((logs[0]!.payload as { kind?: string }).kind).toBe("system");
  });
});
