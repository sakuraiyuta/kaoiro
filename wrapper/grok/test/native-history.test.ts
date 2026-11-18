import { permitHostAccess } from "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { makeGrokScratch, removeGrokState } from "./grok-state.js";
import { nativeRun } from "./native-support.js";

permitHostAccess({
  kinds: ["network"],
  optIn: "KAOIRO_LIVE_GROK",
  reason: "live Grok provider run",
});

// Work unit 3b acceptance against the real grok (issue #645): resuming a
// session after a tool-call turn replays its user, tool_use, tool_result and
// assistant entries, each with a time inside the turn's wall-clock window.
// Runs only with KAOIRO_LIVE_GROK=1. No prompt, output or token is recorded.

const live = process.env.KAOIRO_LIVE_GROK === "1";
const MARKER = "KAOIRO_HISTORY_MARKER_645";
const config: WrapperConfig = {
  agent_id: "native.history", display_name: "History fixture", server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  sandbox: "workspace-write", network_access: true,
};

describe.skipIf(!live)("native history replay", () => {
  it("replays a tool-call turn with times inside the turn's window", async () => {
    const cwd = makeGrokScratch("history");
    try {
      let sessionId: string | undefined;
      let from = 0;
      let to = 0;
      await nativeRun(config, cwd, async (host) => {
        await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 60_000 });
        from = Math.floor(Date.now() / 1000);
        await host.send(`Use run_terminal_command exactly once to run: echo ${MARKER}. ` +
          "No other tools, no retries, then answer with one word.");
        to = Math.ceil(Date.now() / 1000);
      }, undefined, (payload) => JSON.stringify(payload).includes(MARKER), undefined,
      { onSessionId: (id) => { sessionId = id; } });
      expect(sessionId).toBeDefined();

      const marks: { kind: "reset" | "complete"; at: number }[] = [];
      let replayed: Envelope[] = [];
      await nativeRun(config, cwd, async (host, _link, envelopes) => {
        await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 60_000 });
        await vi.waitFor(() => expect(marks.map((m) => m.kind)).toEqual(["reset", "complete"]), { timeout: 30_000 });
        replayed = envelopes.slice(marks[0]!.at, marks[1]!.at).filter((e) => e.type === "log");
      }, undefined, undefined, undefined, { resume: sessionId!, replay: { marks } });

      const payloads = replayed.map((e) => e.payload as Record<string, any>);
      const kinds = payloads.map((p) => p.kind);
      expect(kinds[0]).toBe("user");
      expect(payloads[0]!.text).toContain(MARKER);
      expect(kinds.at(-1)).toBe("assistant");
      const use = payloads.findIndex((p) => p.kind === "tool_use");
      expect(use).toBeGreaterThan(0);
      expect(typeof payloads[use]!.tool_use_id).toBe("string");
      expect(typeof payloads[use]!.input).toBe("object");
      const result = payloads.findIndex((p) => p.kind === "tool_result" && p.tool_use_id === payloads[use]!.tool_use_id);
      expect(result).toBeGreaterThan(use);
      expect(payloads[result]!.tool_name).toBe(payloads[use]!.tool_name);
      expect(typeof payloads[result]!.output).toBe("string");
      expect(replayed.every((e) => e.session_id === sessionId)).toBe(true);
      // Every entry's time falls inside the turn's window: the seconds are real.
      for (const envelope of replayed) {
        const seconds = Date.parse(envelope.ts) / 1000;
        expect(seconds).toBeGreaterThanOrEqual(from);
        expect(seconds).toBeLessThanOrEqual(to);
      }
    } finally {
      removeGrokState(cwd);
    }
  }, 600_000);
});
