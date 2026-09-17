// issue #352: the runner has no per-agent conversation trace because the
// runner journal (its own stdout/stderr, inherited from the wrapper child
// and captured by systemd) never receives the engine-side transcript
// location. A unit test against AgentHost's onSessionId callback alone
// cannot catch a wiring regression in cli.ts itself (the same class of gap
// documented in cli_resume_composition.test.ts) -- this test drives the
// real runClaudeCli() entrypoint so the assertion is against what actually
// reaches stdout.
import { describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

describe("Claude CLI transcript-trace composition (issue #352)", () => {
  it("real cli.ts wiring reports the transcript location on the runner journal when the session id becomes known", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const link = {
        close: () => {},
        currentSessionId: () => null,
        send: () => {},
        setSessionId: () => {},
      };
      let hostOptions!: Record<string, any>;

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
        createHost: (_cfg, options) => {
          hostOptions = options as unknown as Record<string, any>;
          return {
            state: "idle",
            statusExtSnapshot: () => ({}),
            run: async () => {
              hostOptions.onSessionId("sess-abc-123");
            },
          } as never;
        },
      });

      const lines = stdout.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("[kaoiro] transcript: "));
      expect(lines).toHaveLength(1);
      const expectedPath = join(
        homedir(),
        ".claude",
        "projects",
        encodeCwdForTest(process.cwd()),
        "sess-abc-123.jsonl",
      );
      expect(lines[0]).toBe(
        `[kaoiro] transcript: agent=self.agent engine=claude-code ` +
          `session=sess-abc-123 path=${expectedPath}\n`,
      );
    } finally {
      stdout.mockRestore();
    }
  });
});

// Mirrors src/history.ts's local encodeCwd (kept local there to avoid a
// wrapper->runner dependency); duplicated here rather than imported so this
// test measures the PRODUCTION path's actual output against an
// independently computed expectation, not against the same function it is
// meant to verify wired correctly.
function encodeCwdForTest(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
