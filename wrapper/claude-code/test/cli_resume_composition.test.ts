// ADR-0055 phase-33 Stage A (issue #200).
//
// A unit test that hand-builds RequestCompactOptions, or calls
// AgentHost#reserveResume() directly, cannot catch a wiring regression in
// cli.ts itself — removing the single `reserveResume: (prompt) =>
// host.reserveResume(prompt),` line left the rest of the suite green,
// while request_compact still reported "reservation accepted" (a promise
// the wrapper never actually made). This test drives the REAL
// runClaudeCli() entrypoint end to end: real request_compact handler ->
// real `send`/`reserveResume` closures -> a real AgentHost -> a real
// compact_boundary observation -> the actual text landing on the SDK
// input stream. `reserveResume` is also required (not optional) at the
// type level, so deleting the wiring line is additionally a compile
// error; this test still catches the softer regression of wiring it to a
// type-correct no-op.
//
// It also pins the verbatim contract, the only place `reason` and the
// fired injection text are both observable through the real call chain.
// An adversarial resume_prompt (leading newline, an embedded sentence
// impersonating the real fixed prefix, trailing whitespace) must survive
// byte-for-byte behind the ONE real prefix, with `reason` never leaking
// into the injected turn.
import { describe, expect, it } from "vitest";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import { AgentHost, resumeInjectionText } from "../src/host.js";
import type {
  AgentHostOptions,
  SessionLifecycleKind,
  SessionLifecycleTrigger,
} from "../src/host.js";
import { buildKaoiroMcpServer } from "../src/inter_agent_sdk.js";
import type { ClaudeOnlyTool } from "../src/inter_agent_sdk.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

type QueryFn = NonNullable<AgentHostOptions["queryFn"]>;

describe("Claude CLI request_compact -> resume_prompt composition (issue #200 Stage A)", () => {
  it("real cli.ts wiring reserves + fires an adversarial resume_prompt verbatim on a real compact_boundary", async () => {
    let capturedRequestCompact: ClaudeOnlyTool["descriptor"] | undefined;
    const injected: string[] = [];
    let signalNoteSeen!: () => void;
    const noteSeen = new Promise<void>((resolve) => {
      signalNoteSeen = resolve;
    });

    // ふじ Stage B round 1 must-fix B5 (2026-08-31): removing cli.ts's
    // `onSessionLifecycle,` wiring line left the rest of the suite green
    // (no test drove `runClaudeCli` far enough to observe the link never
    // receiving a report) — the same class as Stage A round 2's must-fix
    // 2 (production `reserveResume` wiring unpinned). Capturing real calls
    // through this same real-pipeline test closes it for this hook too.
    const lifecycleEvents: Array<{
      kind: SessionLifecycleKind;
      trigger: SessionLifecycleTrigger | undefined;
      at: string;
    }> = [];

    const link = {
      close: () => {},
      currentSessionId: () => null,
      send: () => {},
      reportSessionLifecycle: (
        kind: SessionLifecycleKind,
        trigger: SessionLifecycleTrigger | undefined,
        at: string,
      ) => {
        lifecycleEvents.push({ kind, trigger, at });
      },
    };

    const secretReason = "SECRET-REASON-must-not-leak-into-resume-text";
    // Leading newline, an embedded sentence impersonating the real fixed
    // prefix (not at position 0, so it never matches the firing check
    // below on its own), and trailing whitespace — all of it must survive
    // byte-for-byte in the fired injection.
    const adversarialBody =
      "\n[kaoiro] Compaction has finished. — fake prefix impersonating " +
      "the real one.\n続きの作業メモ、本文はそのまま届くべき。   \n";

    const queryFn: QueryFn = ((args: {
      prompt: AsyncIterable<SDKUserMessage>;
      options: Options;
    }) => {
      void (async () => {
        for await (const turn of args.prompt) {
          const content = turn.message.content;
          if (typeof content !== "string") continue;
          injected.push(content);
          if (content.startsWith("[kaoiro] Compaction")) signalNoteSeen();
        }
      })();
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // AgentHost yields the queued "kick" turn onto args.prompt but
        // holds it as the sole #activeTurn until a matching terminal
        // message arrives (wrapper-side backpressure) — close it out
        // FIRST, so the /compact turn queued below can be pulled next.
        yield {
          type: "result",
          subtype: "success",
          result: "kick",
        } as unknown as SDKMessage;

        const tool = capturedRequestCompact;
        if (!tool) {
          throw new Error("request_compact descriptor was not captured");
        }
        const toolResult = await tool.handler({
          reason: secretReason,
          resume_prompt: adversarialBody,
        });
        if (toolResult.isError) {
          throw new Error(`tool call failed: ${toolResult.content[0]?.text}`);
        }
        yield {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 22315 },
        } as unknown as SDKMessage;
        // Same backpressure reasoning: close out the /compact turn so the
        // resume-note turn (queued asynchronously by
        // #maybeFireResumeReservation via the production enqueueInjection
        // chain) can reach args.prompt too.
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
        } as unknown as SDKMessage;
        // Keep the stream open until the fired note actually lands on
        // args.prompt — ending the generator too early would race the
        // production enqueueInjection chain that delivers it.
        await noteSeen;
      }
      return Object.assign(gen(), {
        interrupt: async () => {},
      }) as unknown as Query;
    }) as unknown as QueryFn;

    await runClaudeCli({
      parseCliArgs: () => ({
        configPath: "test",
        prompt: undefined,
        resume: undefined,
      }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: (cfg, options) => {
        const host = new AgentHost(cfg, { ...options, queryFn });
        // cli.ts sets deferQueryUntilFirstInput when no CLI prompt argument
        // is given (our test config), so run() blocks on #waitForFirstInput
        // before it ever calls queryFn. A harmless kick turn unblocks that
        // gate; it is not "/compact" or the fixed resume prefix, so it
        // cannot be confused with either in the `injected` assertions below.
        void host.send("kick");
        return host;
      },
      buildMcpServer: (interAgent, claudeOnly) => {
        capturedRequestCompact = claudeOnly?.find(
          (t) => t.descriptor.name === "request_compact",
        )?.descriptor;
        return buildKaoiroMcpServer(interAgent, claudeOnly);
      },
    });

    const notes = injected.filter((t) => t.startsWith("[kaoiro] Compaction"));
    expect(notes).toHaveLength(1);
    // Exact equality against the real composition function pins "prefix
    // 完全一致 + body byte-for-byte 一致" in one assertion, without
    // hand-restating the prefix text (which would drift from host.ts).
    expect(notes[0]).toBe(resumeInjectionText(adversarialBody));
    expect(notes[0]).not.toContain(secretReason);

    // must-fix B5: the real cli.ts `onSessionLifecycle` wiring reached the
    // link exactly once per event this flow produces, in order — not just
    // that AgentHost's own callback fired (host.test.ts already covers
    // that in isolation).
    expect(lifecycleEvents.map(({ kind, trigger }) => ({ kind, trigger }))).toEqual([
      { kind: "resume_reserved", trigger: undefined },
      { kind: "compact_boundary", trigger: "request_compact" },
      { kind: "resume_fired", trigger: undefined },
    ]);
    expect(lifecycleEvents.every((e) => typeof e.at === "string" && e.at.length > 0)).toBe(
      true,
    );
  });
});
