import "../../../scripts/test/fixtures/test-isolation.mjs";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { readRecoveryCheckpoint, requirePositiveSafePid } from "@kaoiro/wrapper-core";
import { relayAntigravityInstruction, runAntigravityCli } from "../src/cli.js";
import { writeFakeAgy } from "./fake_agy_executable.js";
import { AntigravityHost } from "../src/host.js";

function config(): WrapperConfig {
  return {
    agent_id: "a1",
    persona: { id: "momo", name: "Momo", sprite_set: "momo" },
    display_name: "Momo",
    server_url: "ws://localhost:4000",
  };
}

type Signal = 0 | NodeJS.Signals;
type SignalBackend = (pid: number, signal: Signal) => unknown;

function stopSshAgent(rawPid: unknown, signal: SignalBackend = (pid, value) => process.kill(pid, value)): void {
  const pid = requirePositiveSafePid(rawPid);
  signal(pid, "SIGTERM");
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

  it("declares permission_sync to the server link and threads the negotiated flag to the host (issue #359 M1)", async () => {
    let capturedServerOptions: Record<string, unknown> | undefined;
    let capturedHostOptions: Record<string, unknown> | undefined;
    const link = {
      close: () => {},
      send: () => {},
      setSessionId: () => {},
      reportPermissionLifecycle: () => {},
      waitForPermissionSyncNegotiation: async () => true,
      waitForPermissionSync: async () => {},
    };
    const host = {
      state: "idle" as const,
      statusExtSnapshot: () => ({ engine: "antigravity" }),
      run: async () => {},
    };

    await runAntigravityCli({
      parseCliArgs: () => ({ configPath: "test" }),
      loadConfig: () => config(),
      createServerLink: (_url, _agentId, options) => {
        capturedServerOptions = options as unknown as Record<string, unknown>;
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: (_config, options) => {
        capturedHostOptions = options as unknown as Record<string, unknown>;
        return host as never;
      },
    });

    expect(capturedServerOptions?.permissionSync).toEqual(
      expect.objectContaining({ engine: "antigravity" }),
    );
    expect(capturedHostOptions?.permissionSyncSupported).toBe(true);
    expect(typeof capturedHostOptions?.waitForPermissionSync).toBe("function");
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

  it("surfaces a rejected set_permission from the server link to stderr", async () => {
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
        throw new Error(
          "antigravity: permission switching is not advertised for this session",
        );
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
        parseCliArgs: () => ({ configPath: "test" }),
        loadConfig: () => config(),
        createServerLink: (_url, _agentId, options) => {
          onSetPermission = options.onSetPermission as typeof onSetPermission;
          queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
          return link as never;
        },
        createHost: () => host as never,
      });

      expect(stderr).toHaveBeenCalledWith(
        "antigravity: Error: antigravity: permission switching is not advertised for this session\n",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("reads a config-file executable into the default host without spawn injection", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-cli-default-"));
    const record = join(root, "commands.jsonl");
    const executable = writeFakeAgy(root, { name: "fixture agy with spaces.mjs", record });
    const configPath = join(root, "wrapper.config.json");
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
        parseCliArgs: () => ({ configPath }),
        onHostCreated: (host) => { liveHost = host; },
        createServerLink: (_url, _agentId, options) => {
          queueMicrotask(() => {
            options.onPersonaPrompt?.("persona");
            queueMicrotask(() => options.onInstruction?.("ECHO default cli turn"));
          });
          return {
            close: () => {},
            setSessionId: () => {},
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
        expect.arrayContaining(["models", "-p", "acp"]),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  describe("launch notices for SSH tool children (issue #350)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    async function launch(probe?: () => Promise<"no_identities" | "unknown">): Promise<string[]> {
      const stderr: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      }) as never);
      await runAntigravityCli({
        parseCliArgs: () => ({ configPath: "test" }),
        loadConfig: () => config(),
        createServerLink: (_url, _agentId, options) => {
          queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
          return { close: () => {}, send: () => {} } as never;
        },
        createHost: () => ({ state: "idle", statusExtSnapshot: () => ({}), run: async () => {} }) as never,
        ...(probe === undefined ? {} : { probeSshAgentIdentities: probe }),
      });
      // The probe resolves off the launch path; let its continuation run.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return stderr;
    }

    it("tells the operator when their GIT_SSH_COMMAND is respected and warns on an empty agent", async () => {
      vi.stubEnv("GIT_SSH_COMMAND", "/opt/wrap-ssh");
      const stderr = await launch(async () => "no_identities");
      expect(stderr).toContainEqual(expect.stringContaining("respects the operator's GIT_SSH_COMMAND; ssh BatchMode is not injected"));
      expect(stderr).toContainEqual(expect.stringContaining("SSH_AUTH_SOCK has no identities; SSH Git operations will fail in BatchMode"));
    });

    it("stays silent when BatchMode is injected and the agent state is unknown", async () => {
      vi.stubEnv("GIT_SSH_COMMAND", "");
      const stderr = await launch(async () => "unknown");
      expect(stderr.join("")).not.toContain("GIT_SSH_COMMAND");
      expect(stderr.join("")).not.toContain("SSH_AUTH_SOCK");
    });

    const sshAgentAvailable = (() => {
      try {
        execFileSync("ssh-agent", ["-h"], { stdio: "ignore" });
        return true;
      } catch (error) {
        return (error as { code?: unknown }).code !== "ENOENT";
      }
    })();

    it.skipIf(!sshAgentAvailable)("warns through the default probe against a real empty ssh-agent", async () => {
      const output = execFileSync("ssh-agent", ["-s"], { encoding: "utf8" });
      const socket = /SSH_AUTH_SOCK=([^;]+);/.exec(output)?.[1];
      const pid = /SSH_AGENT_PID=([0-9]+);/.exec(output)?.[1];
      if (socket === undefined || pid === undefined) throw new Error(`unexpected ssh-agent output: ${output}`);
      vi.stubEnv("SSH_AUTH_SOCK", socket);
      try {
        const stderr = await launch();
        const deadline = performance.now() + 3_000;
        while (performance.now() < deadline && !stderr.some((line) => line.includes("has no identities"))) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(stderr).toContainEqual(expect.stringContaining("SSH_AUTH_SOCK has no identities; SSH Git operations will fail in BatchMode"));
      } finally {
        stopSshAgent(pid);
      }
    });
  });
});

describe("SSH-agent PID signal helper", () => {
  it("rejects invalid parsed PIDs before calling the signal backend", () => {
    const calls: Array<[number, Signal]> = [];
    const fakeSignal: SignalBackend = (pid, signal) => { calls.push([pid, signal]); };
    for (const invalid of ["", "  ", "0", "-1", "1.5", "NaN", "Infinity", "1e3", "9007199254740992", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => stopSshAgent(invalid, fakeSignal)).toThrow(RangeError);
      expect(calls).toEqual([]);
    }
    stopSshAgent("42", fakeSignal);
    expect(calls).toEqual([[42, "SIGTERM"]]);
  });
});


it("writes a blocked checkpoint through the real Antigravity watchdog callback", async () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-watchdog-recovery-")); const checkpoint = join(root, "checkpoint");
  let host: AntigravityHost | undefined;
  const running = runAntigravityCli({
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => ({ ...config(), recovery_checkpoint_path: checkpoint }),
    createServerLink: (_url, _id, options) => {
      queueMicrotask(() => options.onPersonaPrompt?.("fixture"));
      return { send: () => {}, close: () => {}, reportDisconnectIntent: async () => true,
        flushInterAgentRetirements: async () => {}, retireInterAgentDeliveries: () => true } as never;
    },
    createHost: (cfg, options) => (host = new AntigravityHost(cfg, options)),
  });
  try {
    await vi.waitFor(() => expect(host).toBeDefined());
    expect(readRecoveryCheckpoint(checkpoint)).toMatchObject({ ok: true, record: { state: "unbound" } });
    expect(host!.failStopForWatchdogAttributionUnknown()).toBe(true);
    expect(readRecoveryCheckpoint(checkpoint)).toMatchObject({ ok: true, record: { state: "blocked", reason: "watchdog" } });
    await running;
  } finally { await host?.close(); await running; rmSync(root, { recursive: true, force: true }); }
});
