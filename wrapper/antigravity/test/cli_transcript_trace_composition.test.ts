// issue #352: the runner has no per-agent conversation trace because the
// runner journal (its own stdout/stderr, inherited from the wrapper child
// and captured by systemd) never receives the engine-side transcript
// location. This test drives the real runAntigravityCli() entrypoint so the
// assertion is against what actually reaches stdout, not a unit call
// against the callback alone.
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

describe("Antigravity CLI transcript-trace composition (issue #352)", () => {
  it("real cli.ts wiring reports the expected transcript path (no existence check) when the conversation id becomes known", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const link = { close: () => {}, send: () => {}, setSessionId: () => {} };
      let hostOptions!: Record<string, any>;

      await runAntigravityCli({
        parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
        loadConfig: () => ({ ...config }),
        createServerLink: (_url, _agentId, options) => {
          queueMicrotask(() => (options as any).onPersonaPrompt?.("system prompt"));
          return link as never;
        },
        createHost: (_cfg, options) => {
          hostOptions = options as unknown as Record<string, any>;
          return {
            state: "idle",
            statusExtSnapshot: () => ({}),
            run: async () => {
              hostOptions.onSessionId("conv-xyz-789");
            },
          } as never;
        },
      });

      const lines = stdout.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("[kaoiro] transcript: "));
      const expectedPath = join(
        homedir(),
        ".gemini",
        "antigravity-cli",
        "brain",
        "conv-xyz-789",
        ".system_generated",
        "logs",
        "transcript_full.jsonl",
      );
      expect(lines).toEqual([
        `[kaoiro] transcript: agent=self.agent engine=antigravity ` +
          `session=conv-xyz-789 path=${expectedPath}\n`,
      ]);
    } finally {
      stdout.mockRestore();
    }
  });
});
