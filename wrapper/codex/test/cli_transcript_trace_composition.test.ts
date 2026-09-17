// issue #352: the runner has no per-agent conversation trace because the
// runner journal (its own stdout/stderr, inherited from the wrapper child
// and captured by systemd) never receives the engine-side transcript
// location. This test drives the real runCodexCli() entrypoint so the
// assertion is against what actually reaches stdout, not a unit call
// against the callback alone.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

let home: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

async function runWithFakeHost(
  onSessionIdArg: string,
): Promise<string[]> {
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
    await runCodexCli({
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
            hostOptions.onSessionId(onSessionIdArg);
          },
        } as never;
      },
      prepareStartup: async () => {},
    });
    return stdout.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith("[kaoiro] transcript: "));
  } finally {
    stdout.mockRestore();
  }
}

describe("Codex CLI transcript-trace composition (issue #352)", () => {
  it("reports the rollout path once the file exists under the session's HOME", async () => {
    home = mkdtempSync(join(tmpdir(), "kaoiro-codex-transcript-"));
    const dayDir = join(home, ".codex", "sessions", "2026", "09", "18");
    mkdirSync(dayDir, { recursive: true });
    const sessionId = "abc123";
    const rolloutPath = join(dayDir, `rollout-2026-09-18T00-00-00-${sessionId}.jsonl`);
    writeFileSync(rolloutPath, "");
    vi.stubEnv("HOME", home);

    const lines = await runWithFakeHost(sessionId);

    expect(lines).toEqual([
      `[kaoiro] transcript: agent=self.agent engine=codex session=${sessionId} path=${rolloutPath}\n`,
    ]);
  });

  it("emits no line when the rollout is not found under the session's HOME (fail-closed, not a guess)", async () => {
    home = mkdtempSync(join(tmpdir(), "kaoiro-codex-transcript-missing-"));
    vi.stubEnv("HOME", home);

    const lines = await runWithFakeHost("no-such-session");

    expect(lines).toEqual([]);
  });
});
