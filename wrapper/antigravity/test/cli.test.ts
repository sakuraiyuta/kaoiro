import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { relayAntigravityInstruction, runAntigravityCli } from "../src/cli.js";

function config(): WrapperConfig {
  return {
    agent_id: "a1",
    persona: { id: "momo", name: "Momo", sprite_set: "momo" },
    display_name: "Momo",
    server_url: "ws://localhost:4000",
  };
}

describe("Antigravity CLI", () => {
  it("relays an instruction as one user log before sending it to the host", () => {
    const logs: Envelope[] = [];
    const sent: string[] = [];

    relayAntigravityInstruction(
      config(),
      "waiting_input",
      (envelope) => logs.push(envelope),
      async (text) => { sent.push(text); },
      "Continue with the task.",
      () => "2026-09-05T00:00:00.000Z",
    );

    expect(logs).toEqual([
      expect.objectContaining({
        type: "log",
        state: "waiting_input",
        payload: { kind: "user", text: "Continue with the task." },
      }),
    ]);
    expect(sent).toEqual(["Continue with the task."]);
  });

  it("sends the configured default persona in an initial idle state_change", async () => {
    const defaultConfig: WrapperConfig = {
      ...config(),
      persona: { id: "default", name: "デフォルト", sprite_set: "default" },
      display_name: "デフォルト",
    };
    const envelopes: Envelope[] = [];
    const link = {
      close: () => {},
      send: (envelope: Envelope) => envelopes.push(envelope),
    };
    const host = {
      state: "idle" as const,
      statusExtSnapshot: () => ({
        engine: "antigravity",
        permission: { enforcement: "advisory" },
      }),
      run: async () => {},
    };

    await runAntigravityCli({
      parseCliArgs: () => ({
        configPath: "test",
        prompt: undefined,
        resume: undefined,
      }),
      loadConfig: () => ({ ...defaultConfig }),
      createServerLink: (_url, _agentId, options) => {
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: () => host as never,
    });

    expect(envelopes).toEqual([
      expect.objectContaining({
        type: "state_change",
        state: "idle",
        persona: defaultConfig.persona,
        display_name: defaultConfig.display_name,
        ext: { engine: "antigravity", permission: { enforcement: "advisory" } },
      }),
    ]);
  });

  it("absorbs an unavailable effort switch delivered through the server link", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    let onSetEffort: ((effort: string) => void) | undefined;
    const link = {
      close: () => {},
      send: () => {},
    };
    const host = {
      state: "idle" as const,
      statusExtSnapshot: () => ({ engine: "antigravity" }),
      setEffort: async () => {
        throw new Error("antigravity effort switching is unavailable: api_key=abcdef123456");
      },
      run: async () => {
        onSetEffort?.("high");
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    };

    try {
      await runAntigravityCli({
        parseCliArgs: () => ({
          configPath: "test",
          prompt: undefined,
          resume: undefined,
        }),
        loadConfig: () => config(),
        createServerLink: (_url, _agentId, options) => {
          onSetEffort = options.onSetEffort;
          queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
          return link as never;
        },
        createHost: () => host as never,
      });

      expect(stderr).toHaveBeenCalledWith(
        "antigravity: Error: antigravity effort switching is unavailable: api_key=********3456\n",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("rejects set_permission delivered through the server link in Stage A", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    let onSetPermission:
      | ((selection: { revision: number; requested: { sandbox: string; network_access: boolean } }) => void)
      | undefined;
    const link = { close: () => {}, send: () => {} };
    const host = {
      state: "idle" as const,
      statusExtSnapshot: () => ({ engine: "antigravity" }),
      setPermission: async () => {
        throw new Error("antigravity permission switching is unavailable in Stage A");
      },
      run: async () => {
        onSetPermission?.({
          revision: 1,
          requested: { sandbox: "workspace-write", network_access: true },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    };

    try {
      await runAntigravityCli({
        parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
        loadConfig: () => config(),
        createServerLink: (_url, _agentId, options) => {
          onSetPermission = options.onSetPermission as typeof onSetPermission;
          queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
          return link as never;
        },
        createHost: () => host as never,
      });

      expect(stderr).toHaveBeenCalledWith(
        "antigravity: Error: antigravity permission switching is unavailable in Stage A\n",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("reads a config-file executable into the default host without spawn injection", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-cli-default-"));
    const executable = join(root, "fixture agy with spaces.mjs");
    const record = join(root, "commands.jsonl");
    const hook = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;
    const configPath = join(root, "wrapper.config.json");
    writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + "\\n");
if (args[0] === "models") {
  process.stdout.write("fixture-model\\tFixture Model\\n");
} else if (args[0] === "-p" && args[1] === "/hooks") {
  const customization = args[args.lastIndexOf("--add-dir") + 1];
  process.stdout.write(JSON.stringify({ hooks: [{ source: customization + "/.agents/hooks.json", actions: [{ event: "PreToolUse", matcher: "*", command: ${JSON.stringify(hook)}, timeout_seconds: 3600 }] }] }));
} else if (args[0] === "--print") {
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "default cli turn" } }) + "\\n");
} else {
  process.exitCode = 2;
}
`);
    chmodSync(executable, 0o755);
    writeFileSync(configPath, JSON.stringify({
      ...config(),
      antigravity_cli_path: executable,
      antigravity_probe_timeout_ms: 45_000,
    }));
    const envelopes: Envelope[] = [];
    let liveHost: { close(): void } | undefined;
    let resultSeen!: () => void;
    const result = new Promise<void>((resolve) => { resultSeen = resolve; });
    try {
      const run = runAntigravityCli({
        parseCliArgs: () => ({ configPath, prompt: undefined, resume: undefined }),
        onHostCreated: (host) => { liveHost = host; },
        createServerLink: (_url, _agentId, options) => {
          queueMicrotask(() => {
            options.onPersonaPrompt?.("persona");
            queueMicrotask(() => options.onInstruction?.("hello"));
          });
          return {
            close: () => {},
            send: (envelope: Envelope) => {
              envelopes.push(envelope);
              if (envelope.type === "result") resultSeen();
            },
          } as never;
        },
      });
      await result;
      liveHost?.close();
      await run;
      expect(envelopes.find((envelope) => envelope.type === "result")?.payload)
        .toMatchObject({ text: "default cli turn" });
      const commands = readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands.map((args) => args[0])).toEqual(
        expect.arrayContaining(["models", "-p", "--print"]),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
