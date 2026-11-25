import "../../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { MuseHost, type MuseHostOptions } from "../src/host.js";
import { ToolHost } from "@kaoiro/agent-common/dist/toolhost.js";

const executable = fileURLToPath(
  new URL("./fixtures/muse.mjs", import.meta.url),
);
export const config: WrapperConfig = {
  agent_id: "muse-test",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  display_name: "Muse test",
  server_url: "ws://127.0.0.1:1/agent",
};
const hosts: MuseHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.close();
    await host.closed;
  }
  vi.restoreAllMocks();
});

async function started(options: Partial<MuseHostOptions> = {}) {
  const envelopes: Envelope[] = [];
  const host = new MuseHost({
    config: { ...config },
    cwd: process.cwd(),
    personaPrompt: "PERSONA_AND_FOOTER",
    send: (e) => envelopes.push(e),
    decidePermission: async () => ({ allow: true }),
    executable,
    ...options,
  });
  hosts.push(host);
  const run = host.run();
  void run.catch(() => {});
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
    timeout: 5_000,
  });
  return { host, envelopes, run };
}

describe("muse host", () => {
  it("runs a text turn and publishes the reply, the result and context usage", async () => {
    const { host, envelopes } = await started();
    await host.send("hello");
    const result = envelopes.find((e) => e.type === "result");
    expect(result?.payload).toMatchObject({ text: "echo:hello", is_error: false });
    const assistant = envelopes.filter(
      (e) => e.type === "log" && e.payload.kind === "assistant",
    );
    expect(assistant.map((e) => e.payload.text)).toEqual(["echo:hello"]);
    expect(host.statusExtSnapshot()).toMatchObject({
      engine: "muse",
      model: "muse-spark-1.3",
      context: { used_tokens: 100, max_tokens: 1000, used_percentage: 10 },
    });
  });

  it("prepends the persona to the first turn only", async () => {
    const promptsFile = join(tmpdir(), `kaoiro-muse-prompts-${process.pid}.jsonl`);
    rmSync(promptsFile, { force: true });
    process.env.KAOIRO_TEST_MUSE_PROMPTS_FILE = promptsFile;
    try {
      const { host, envelopes } = await started();
      await host.send("one");
      await host.send("two");
      const results = envelopes.filter((e) => e.type === "result");
      expect(results.map((e) => e.payload.text)).toEqual(["echo:one", "echo:two"]);
      const prompts = readFileSync(promptsFile, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as string);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("PERSONA_AND_FOOTER");
      expect(prompts[0]).toContain("one");
      expect(prompts[1]).toBe("two");
    } finally {
      delete process.env.KAOIRO_TEST_MUSE_PROMPTS_FILE;
      rmSync(promptsFile, { force: true });
    }
  });

  it("prepends the persona on a resumed session without delivery evidence", async () => {
    const promptsFile = join(tmpdir(), `kaoiro-muse-prompts-resume-${process.pid}.jsonl`);
    rmSync(promptsFile, { force: true });
    process.env.KAOIRO_TEST_MUSE_PROMPTS_FILE = promptsFile;
    try {
      const { host } = await started({ resumeSessionId: "fixture-session" });
      await host.send("hello");
      const prompts = readFileSync(promptsFile, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as string);
      expect(prompts[0]).toContain("PERSONA_AND_FOOTER");
      expect(prompts[0]).toContain("hello");
    } finally {
      delete process.env.KAOIRO_TEST_MUSE_PROMPTS_FILE;
      rmSync(promptsFile, { force: true });
    }
  });

  it("keeps the persona pending when the first prompt fails", async () => {
    const promptsFile = join(tmpdir(), `kaoiro-muse-prompts-retry-${process.pid}.jsonl`);
    rmSync(promptsFile, { force: true });
    process.env.KAOIRO_TEST_MUSE_PROMPTS_FILE = promptsFile;
    process.env.KAOIRO_TEST_MUSE_FAIL_FIRST_PROMPT = "1";
    try {
      const { host } = await started();
      await expect(host.send("one")).rejects.toThrow();
      await host.send("two");
      const prompts = readFileSync(promptsFile, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as string);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("PERSONA_AND_FOOTER");
      expect(prompts[1]).toContain("PERSONA_AND_FOOTER");
      expect(prompts[1]).toContain("two");
    } finally {
      delete process.env.KAOIRO_TEST_MUSE_PROMPTS_FILE;
      delete process.env.KAOIRO_TEST_MUSE_FAIL_FIRST_PROMPT;
      rmSync(promptsFile, { force: true });
    }
  });

  it("keeps persona pending after a refusal", async () => {
    const path = join(tmpdir(), `kaoiro-muse-refusal-${process.pid}.jsonl`);
    rmSync(path, { force: true });
    try {
      const { host } = await started({ env: { ...process.env,
        KAOIRO_TEST_MUSE_PROMPTS_FILE: path } });
      await host.send("refuse");
      await host.send("next");
      const inputs = readFileSync(path, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line));
      expect(inputs[0]).toContain("PERSONA_AND_FOOTER");
      expect(inputs[1]).toContain("PERSONA_AND_FOOTER");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("selects the ask-before-actions approval mode and reports it", async () => {
    const { host } = await started();
    expect(host.statusExtSnapshot()).toMatchObject({
      approval_mode: { id: "promptUnmatched", name: "Ask before unmatched actions" },
    });
    const resumed = await started({ resumeSessionId: "fixture-session" });
    expect(resumed.host.statusExtSnapshot()).toMatchObject({
      approval_mode: { id: "promptUnmatched" },
    });
  });

  it.each([
    "KAOIRO_TEST_MODE_MISSING",
    "KAOIRO_TEST_MODE_CURRENT_UNADVERTISED",
    "KAOIRO_TEST_MODE_REJECT",
    "KAOIRO_TEST_MODE_NO_UPDATE",
    "KAOIRO_TEST_MODE_CONFLICT",
    "KAOIRO_TEST_MODE_CONFIG_CONFLICT",
  ])("rejects unconfirmed approval mode: %s", async (key) => {
    const prompts = join(tmpdir(), `kaoiro-muse-mode-${process.pid}.jsonl`);
    rmSync(prompts, { force: true });
    const host = new MuseHost({
      config: { ...config }, cwd: process.cwd(), personaPrompt: "persona",
      send: () => {}, decidePermission: async () => ({ allow: true }),
      executable, env: { ...process.env, [key]: "1", KAOIRO_TEST_MUSE_PROMPTS_FILE: prompts },
    });
    hosts.push(host);
    try {
      const failed = host.run("must not run").then(() => false, () => true);
      const outcome = await Promise.race([
        failed, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      expect(outcome).toBe(true);
      expect(existsSync(prompts)).toBe(false);
    } finally {
      rmSync(prompts, { force: true });
    }
  });

  it("stops when the native approval mode changes after startup", async () => {
    const { host, run } = await started();
    const turn = host.send("unsafe-mode");
    await expect(turn).rejects.toThrow();
    await expect(run).rejects.toThrow(/approval mode/);
    await expect(host.send("later")).rejects.toThrow();
  });

  it.each([undefined, "fixture-session"])(
    "preserves native environment on fresh and resumed launch: %s",
    async (resumeSessionId) => {
      const path = join(tmpdir(), `kaoiro-muse-launch-${process.pid}.json`);
      rmSync(path, { force: true });
      try {
        const env = { PATH: process.env.PATH!, KAOIRO_TEST_LAUNCH_FILE: path,
          KAOIRO_TEST_SENTINEL: "unchanged", MUSE_EXPERIMENTAL_ACP: "off",
          MUSE_TEST_SANDBOX: "upstream", MUSE_TEST_NETWORK: "upstream" };
        await started({ ...(resumeSessionId ? { resumeSessionId } : {}), env });
        const launch = JSON.parse(readFileSync(path, "utf8"));
        const isolationKeys = new Set([
          "DBUS_SESSION_BUS_ADDRESS", "DOCKER_CONFIG", "DOCKER_HOST", "GH_CONFIG_DIR",
          "KAOIRO_TEST_ISOLATION_CHILD", "KAOIRO_TEST_ISOLATION_FOREIGN",
          "KAOIRO_TEST_ISOLATION_INERT", "KAOIRO_TEST_ISOLATION_ROOTS",
          "NODE_OPTIONS", "XDG_RUNTIME_DIR",
        ]);
        const relevant = Object.fromEntries(Object.entries(launch.env).filter(([key]) =>
          !isolationKeys.has(key)));
        expect(launch.args).toEqual(["acp"]);
        expect(relevant).toEqual(env);
      } finally {
        rmSync(path, { force: true });
      }
    },
  );

  it.each([undefined, "fixture-session"])(
    "rejects sandbox and network restrictions before native launch: %s",
    async (resumeSessionId) => {
      const path = join(tmpdir(), `kaoiro-muse-rejected-${process.pid}.json`);
      rmSync(path, { force: true });
      for (const restriction of [{ sandbox: "read-only" as const },
        { network_access: false }]) {
        const host = new MuseHost({ config: { ...config, ...restriction },
          cwd: process.cwd(), personaPrompt: "persona", send: () => {},
          decidePermission: async () => ({ allow: true }), executable,
          ...(resumeSessionId ? { resumeSessionId } : {}), env: { ...process.env, KAOIRO_TEST_LAUNCH_FILE: path } });
        hosts.push(host);
        await expect(host.run()).rejects.toThrow(/does not accept/);
        expect(existsSync(path)).toBe(false);
      }
    },
  );

  it("cancels a pending approval if the native mode becomes unsafe", async () => {
    const path = join(tmpdir(), `kaoiro-muse-permission-${process.pid}.json`);
    rmSync(path, { force: true });
    let decisionSignal: AbortSignal | undefined;
    try {
      const { host, run } = await started({
        env: { ...process.env, KAOIRO_TEST_PERMISSION_FLIP: "1",
          KAOIRO_TEST_PERMISSION_RESULT: path },
        decidePermission: async (_name, _input, signal) => {
          decisionSignal = signal;
          await new Promise((resolve) => setTimeout(resolve, 120));
          return { allow: true };
        },
      });
      const turn = host.send("permission").then(() => false, () => true);
      await expect(run).rejects.toThrow(/approval mode/);
      expect(await turn).toBe(true);
      expect(decisionSignal?.aborted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("refuses launch restriction inputs before start", async () => {
    const host = new MuseHost({
      config: { ...config, sandbox: "read-only" },
      cwd: process.cwd(),
      personaPrompt: "PERSONA_AND_FOOTER",
      send: () => {},
      decidePermission: async () => ({ allow: true }),
      executable,
    });
    hosts.push(host);
    await expect(host.run()).rejects.toThrow(/does not accept sandbox/);
  });

  it("unblocks startup on close and closes a late listener", async () => {
    const actualListen = ToolHost.listen.bind(ToolHost);
    let release!: () => void;
    let late!: ToolHost;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(ToolHost, "listen").mockImplementation(async (...args) => {
      await gate;
      late = await actualListen(...args);
      vi.spyOn(late, "close");
      return late;
    });
    const host = new MuseHost({
      config: { ...config }, cwd: process.cwd(), personaPrompt: "persona",
      send: () => {}, decidePermission: async () => ({ allow: true }), executable,
    });
    hosts.push(host);
    const run = host.run();
    host.close();
    await run;
    expect(host.processId).toBeUndefined();
    release();
    await vi.waitFor(() => expect(late?.close).toHaveBeenCalledTimes(1));
  });

  it("closes a listener that arrives after the startup deadline", async () => {
    const actualListen = ToolHost.listen.bind(ToolHost);
    let release!: () => void;
    let late!: ToolHost;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(ToolHost, "listen").mockImplementation(async (...args) => {
      await gate;
      late = await actualListen(...args);
      vi.spyOn(late, "close");
      return late;
    });
    const host = new MuseHost({ config: { ...config }, cwd: process.cwd(),
      personaPrompt: "persona", send: () => {}, executable, startupTimeoutMs: 100,
      decidePermission: async () => ({ allow: true }) });
    hosts.push(host);
    try {
      await expect(host.run()).rejects.toThrow(/startup did not finish/);
      expect(host.processId).toBeUndefined();
    } finally {
      release();
      await vi.waitFor(() => expect(late?.close).toHaveBeenCalledTimes(1));
    }
  });

  it("times out a startup whose initialize never answers", async () => {
    process.env.KAOIRO_TEST_MUSE_HANG_INIT = "1";
    try {
      const host = new MuseHost({
        config: { ...config },
        cwd: process.cwd(),
        personaPrompt: "PERSONA_AND_FOOTER",
        send: () => {},
        decidePermission: async () => ({ allow: true }),
        executable,
        startupTimeoutMs: 300,
      });
      hosts.push(host);
      await expect(host.run()).rejects.toThrow(/startup did not finish/);
    } finally {
      delete process.env.KAOIRO_TEST_MUSE_HANG_INIT;
    }
  });

  it("ends run when closed during a pending initialize RPC", async () => {
    const host = new MuseHost({ config: { ...config }, cwd: process.cwd(),
      personaPrompt: "persona", send: () => {}, executable,
      env: { ...process.env, KAOIRO_TEST_MUSE_HANG_INIT: "1" },
      decidePermission: async () => ({ allow: true }) });
    hosts.push(host);
    const run = host.run();
    await vi.waitFor(() => expect(host.processId).toBeDefined());
    host.close();
    await run;
  });

  it.each(["KAOIRO_TEST_MUSE_HANG_NEW", "KAOIRO_TEST_MUSE_HANG_MODE"])(
    "aborts a pending session RPC on close: %s", async (key) => {
      let rpcSent = false;
      const method = key.endsWith("NEW") ? "session/new" : "session/set_mode";
      const host = new MuseHost({ config: { ...config }, cwd: process.cwd(),
        personaPrompt: "persona", send: () => {}, executable,
        env: { ...process.env, [key]: "1" },
        onMetadata: (event) => { if (event.direction === "out" && event.method === method) rpcSent = true; },
        decidePermission: async () => ({ allow: true }) });
      hosts.push(host);
      const run = host.run();
      await vi.waitFor(() => expect(rpcSent).toBe(true), { timeout: 4_000 });
      host.close();
      await run;
    },
  );

  it.each(["KAOIRO_TEST_MUSE_HANG_NEW", "KAOIRO_TEST_MUSE_HANG_MODE"])(
    "times out a pending session RPC: %s", async (key) => {
      const host = new MuseHost({ config: { ...config }, cwd: process.cwd(),
        personaPrompt: "persona", send: () => {}, executable, startupTimeoutMs: 500,
        env: { ...process.env, [key]: "1" },
        decidePermission: async () => ({ allow: true }) });
      hosts.push(host);
      await expect(host.run()).rejects.toThrow(/startup did not finish/);
    },
  );

  it("reports a session whose kaoiro tools never connect", async () => {
    process.env.KAOIRO_TEST_MUSE_NO_MCP = "1";
    try {
      const { host, envelopes } = await started();
      await host.send("hello");
      const notice = envelopes.find(
        (e) => e.type === "log" && e.payload.kind === "system" &&
          String(e.payload.text).includes("not connected"),
      );
      expect(notice).toBeDefined();
    } finally {
      delete process.env.KAOIRO_TEST_MUSE_NO_MCP;
    }
  });

  it("reports kaoiro tools as missing after rejected MCP authentication", async () => {
    const { host, envelopes } = await started({
      env: { ...process.env, KAOIRO_TEST_MUSE_BAD_AUTH: "1",
        KAOIRO_TEST_MCP_ON_PROMPT: "1" },
    });
    await host.send("hello");
    expect(envelopes.some((e) => e.type === "log" &&
      String(e.payload.text).includes("not connected"))).toBe(true);
  });

  it("recognizes an MCP connection during the first prompt", async () => {
    const { host, envelopes } = await started({
      env: { ...process.env, KAOIRO_TEST_MCP_ON_PROMPT: "1" },
    });
    await host.send("hello");
    expect(envelopes.some((e) => e.type === "log" &&
      String(e.payload.text).includes("not connected"))).toBe(false);
  });

  it("publishes waiting_permission and pauses while a request is pending", async () => {
    let hostRef: MuseHost | undefined;
    const decide = vi.fn(async () => {
      hostRef!.setPendingPermission({
        request_id: "perm-1",
        tool_name: "write fixture",
        ts: new Date().toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      hostRef!.setPendingPermission(null);
      return { allow: true };
    });
    const startedHost = await started({ decidePermission: decide });
    hostRef = startedHost.host;
    await startedHost.host.send("permission");
    const states = startedHost.envelopes
      .filter((e) => e.type === "state_change")
      .map((e) => e.state);
    expect(states).toContain("waiting_permission");
    expect(startedHost.envelopes.find((e) => e.type === "result")?.payload)
      .toMatchObject({ text: "allowed" });
  });

  it("clears overlapping permission and question wait states", async () => {
    const { host } = await started();
    const turn = host.send("sleep");
    await vi.waitFor(() => expect(host.state).toBe("tool_running"));
    host.setPendingPermission({ request_id: "p", tool_name: "tool", ts: "now" });
    expect(host.state).toBe("waiting_permission");
    host.setPendingQuestion({ request_id: "q", questions: [], ts: "now" });
    expect(host.state).toBe("waiting_permission");
    host.setPendingPermission(null);
    expect(host.state).toBe("waiting_question");
    host.setPendingQuestion(null);
    expect(host.state).toBe("tool_running");
    await host.interrupt();
    await turn;
  });

  it.each(["permission", "question"])(
    "pauses inactivity during %s and rearms after resolution", async (kind) => {
      const { host, envelopes } = await started({ watchdogTimeoutMs: 120 });
      const turn = host.send("sleep");
      await vi.waitFor(() => expect(host.state).toBe("tool_running"));
      if (kind === "permission") {
        host.setPendingPermission({ request_id: "p", tool_name: "tool", ts: "now" });
      } else {
        host.setPendingQuestion({ request_id: "q", questions: [], ts: "now" });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(envelopes.some((e) => e.type === "result")).toBe(false);
      if (kind === "permission") host.setPendingPermission(null);
      else host.setPendingQuestion(null);
      const finished = await Promise.race([
        turn.then(() => true, () => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(finished).toBe(true);
      expect(envelopes.find((e) => e.type === "result")?.ext)
        .toMatchObject({ interrupted: true });
    },
  );

  it("records the native session in the recovery checkpoint", async () => {
    const checkpoint = join(tmpdir(), `kaoiro-muse-recovery-${process.pid}.json`);
    rmSync(checkpoint, { force: true });
    const { RecoveryReporter } = await import("@kaoiro/wrapper-core");
    try {
      const recoveryConfig = { ...config, recovery_checkpoint_path: checkpoint };
      const first = await started({
        config: recoveryConfig,
        recovery: new RecoveryReporter(recoveryConfig, undefined, () => {}),
      });
      await first.host.send("hello");
      expect(JSON.parse(readFileSync(checkpoint, "utf8"))).toEqual({
        version: 1,
        state: "live",
        session_id: "fixture-session",
      });
      first.host.close();
      await first.host.closed;
      // A restarted wrapper with the same checkpoint resumes the same id.
      const second = await started({
        config: recoveryConfig,
        resumeSessionId: "fixture-session",
        recovery: new RecoveryReporter(recoveryConfig, "fixture-session", () => {}),
      });
      await second.host.send("again");
      expect(JSON.parse(readFileSync(checkpoint, "utf8"))).toEqual({
        version: 1,
        state: "live",
        session_id: "fixture-session",
      });
    } finally {
      rmSync(checkpoint, { force: true });
    }
  });

  it("blocks recovery when the watchdog cancellation grace expires", async () => {
    const checkpoint = join(tmpdir(), `kaoiro-muse-watchdog-${process.pid}.json`);
    rmSync(checkpoint, { force: true });
    const { RecoveryReporter } = await import("@kaoiro/wrapper-core");
    try {
      const recoveryConfig = { ...config, recovery_checkpoint_path: checkpoint };
      const recovery = new RecoveryReporter(recoveryConfig, undefined, () => {});
      const { host, run } = await started({ config: recoveryConfig, recovery,
        watchdogTimeoutMs: 100, env: { ...process.env, KAOIRO_TEST_IGNORE_CANCEL: "1" } });
      const turn = host.send("sleep").then(() => false, () => true);
      await expect(run).rejects.toThrow(/watchdog/);
      expect(await turn).toBe(true);
      expect(JSON.parse(readFileSync(checkpoint, "utf8"))).toMatchObject({
        state: "blocked", reason: "watchdog", session_id: "fixture-session",
      });
    } finally {
      rmSync(checkpoint, { force: true });
    }
  }, 10_000);

  it("retains a candidate on an unclassified resume failure", async () => {
    const checkpoint = join(tmpdir(), `kaoiro-muse-candidate-${process.pid}.json`);
    rmSync(checkpoint, { force: true });
    const { RecoveryReporter } = await import("@kaoiro/wrapper-core");
    try {
      const recoveryConfig = { ...config, recovery_checkpoint_path: checkpoint,
        recovery_resume_kind: "candidate" as const };
      const recovery = new RecoveryReporter(recoveryConfig, "unknown", () => {});
      const host = new MuseHost({ config: recoveryConfig, cwd: process.cwd(),
        personaPrompt: "persona", send: () => {}, executable, recovery,
        resumeSessionId: "unknown", decidePermission: async () => ({ allow: true }) });
      hosts.push(host);
      await expect(host.run()).rejects.toThrow(/could not resume/);
      expect(JSON.parse(readFileSync(checkpoint, "utf8"))).toEqual({
        version: 1, state: "unbound", candidate_id: "unknown",
      });
    } finally {
      rmSync(checkpoint, { force: true });
    }
  });

  it("does not report success when the checkpoint cannot be confirmed", async () => {
    const checkpoint = join(tmpdir(), `kaoiro-muse-fail-recovery-${process.pid}.json`);
    const tmp = `${checkpoint}.tmp`;
    rmSync(checkpoint, { force: true });
    rmSync(tmp, { force: true, recursive: true });
    const { RecoveryReporter } = await import("@kaoiro/wrapper-core");
    try {
      const recoveryConfig = { ...config, recovery_checkpoint_path: checkpoint };
      const recovery = new RecoveryReporter(recoveryConfig, undefined, () => {});
      const { host, envelopes } = await started({ config: recoveryConfig, recovery });
      mkdirSync(tmp);
      await expect(host.send("hello")).rejects.toThrow();
      expect(envelopes.filter((e) => e.type === "result")
        .some((e) => e.payload.is_error === false)).toBe(false);
      expect(recovery.failure?.exitCode).toBe(79);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
      rmSync(checkpoint, { force: true });
    }
  });

  it("records persona after a resumed first turn and omits it on the next resume", async () => {
    const checkpoint = join(tmpdir(), `kaoiro-muse-persona-${process.pid}.json`);
    const prompts = join(tmpdir(), `kaoiro-muse-persona-${process.pid}.jsonl`);
    rmSync(checkpoint, { force: true });
    rmSync(prompts, { force: true });
    const { RecoveryReporter } = await import("@kaoiro/wrapper-core");
    try {
      const cfg = { ...config, recovery_checkpoint_path: checkpoint };
      const env = { ...process.env, KAOIRO_TEST_MUSE_PROMPTS_FILE: prompts };
      const first = await started({ config: cfg, env,
        recovery: new RecoveryReporter(cfg, undefined, () => {}, true) });
      expect(JSON.parse(readFileSync(checkpoint, "utf8"))).toMatchObject({
        state: "unbound", candidate_id: "fixture-session", muse_persona_delivered: false,
      });
      first.host.close();
      await first.host.closed;
      const candidate = { ...cfg, recovery_resume_kind: "candidate" as const };
      const second = await started({ config: candidate, env, resumeSessionId: "fixture-session",
        recovery: new RecoveryReporter(candidate, "fixture-session", () => {}, true) });
      await second.host.send("first");
      expect(JSON.parse(readFileSync(checkpoint, "utf8"))).toMatchObject({
        state: "live", session_id: "fixture-session", muse_persona_delivered: true,
      });
      second.host.close();
      await second.host.closed;
      const confirmed = { ...cfg, muse_persona_delivered: true };
      const third = await started({ config: confirmed, env, resumeSessionId: "fixture-session",
        recovery: new RecoveryReporter(confirmed, "fixture-session", () => {}, true) });
      await third.host.send("second");
      const inputs = readFileSync(prompts, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(inputs[0]).toContain("PERSONA_AND_FOOTER");
      expect(inputs[1]).toBe("second");
    } finally {
      rmSync(checkpoint, { force: true });
      rmSync(prompts, { force: true });
    }
  });

  it("fails a turn the agent rejects and keeps the host usable", async () => {
    const { host, envelopes } = await started();
    await expect(host.send("fail")).rejects.toThrow();
    expect(envelopes.find((e) => e.type === "result")?.payload)
      .toMatchObject({ is_error: true, error_code: "muse_turn_failed" });
    await host.send("again");
    expect(host.state).toBe("waiting_input");
  });

  it("routes an ACP permission request through decidePermission", async () => {
    const decide = vi.fn(async () => ({ allow: true }));
    const { host, envelopes } = await started({ decidePermission: decide });
    await host.send("permission");
    expect(decide).toHaveBeenCalledWith(
      "write fixture",
      { path: "x", tool_call_id: "perm-tool" },
      expect.anything(),
    );
    expect(envelopes.find((e) => e.type === "result")?.payload)
      .toMatchObject({ text: "allowed" });
  });

  it("answers a denied permission with the reject option", async () => {
    const { host, envelopes } = await started({
      decidePermission: async () => ({ allow: false }),
    });
    await host.send("permission");
    expect(envelopes.find((e) => e.type === "result")?.payload)
      .toMatchObject({ text: "denied" });
  });

  it("interrupts a running turn with session/cancel", async () => {
    const path = join(tmpdir(), `kaoiro-muse-cancel-${process.pid}.jsonl`);
    rmSync(path, { force: true });
    const { host, envelopes } = await started({ env: { ...process.env,
      KAOIRO_TEST_MUSE_PROMPTS_FILE: path } });
    try {
      const turn = host.send("sleep");
      await vi.waitFor(() => expect(host.state).toBe("tool_running"), {
        timeout: 5_000,
      });
      await host.interrupt();
      await turn;
      expect(envelopes.find((e) => e.type === "result")?.ext)
        .toMatchObject({ interrupted: true, stop_reason: "cancelled" });
      await host.send("next");
      const inputs = readFileSync(path, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line));
      expect(inputs[0]).toContain("PERSONA_AND_FOOTER");
      expect(inputs[1]).toContain("PERSONA_AND_FOOTER");
    } finally { rmSync(path, { force: true }); }
  });

  it("switches the model and effort through the session config options", async () => {
    const { host } = await started();
    expect(host.statusExtSnapshot()).toMatchObject({
      models: [
        { value: "muse-spark-1.3", display_name: "Muse Spark 1.3" },
        { value: "muse-wonder", display_name: "Muse Wonder" },
      ],
      session_capabilities: {
        supports_model_switch: true,
        supports_effort_switch: true,
        supports_attachments: false,
        supports_permission_mode_switch: false,
      },
    });
    await host.setModel("muse-wonder");
    expect(host.statusExtSnapshot()).toMatchObject({
      model: "muse-wonder", model_source: "config",
    });
    await host.setEffort("low");
    expect(host.statusExtSnapshot()).toMatchObject({
      effort: "low", effort_source: "config",
    });
    await expect(host.setModel("no-such-model")).rejects.toThrow();
    await expect(host.setEffort("no-such-effort")).rejects.toThrow();
  });

  it.each(["KAOIRO_TEST_HANG_SWITCH", "KAOIRO_TEST_DELAY_SWITCH"])(
    "stops and rejects a queued prompt on switch timeout: %s", async (key) => {
      const { host, run } = await started({ switchTimeoutMs: 100,
        env: { ...process.env, [key]: "1" } });
      const switching = host.setModel("muse-wonder");
      const prompt = expect(host.send("must not run")).rejects.toThrow();
      await expect(switching).rejects.toThrow();
      await prompt;
      await expect(run).rejects.toThrow(/timed out/);
      expect(host.statusExtSnapshot().model).toBe("muse-spark-1.3");
    },
  );

  it("rejects permission-mode and permission switching explicitly", async () => {
    const { host } = await started();
    await expect(host.setPermissionMode("default")).rejects.toThrow(/unsupported/);
    await expect(host.setPermission({
      revision: 1,
      requested: { sandbox: "read-only", approval: "never", network_access: false },
    })).rejects.toThrow(/unsupported/);
  });

  it("rejects attachments explicitly", async () => {
    const { host } = await started();
    await expect(host.send("hi", ["upload-1"])).rejects.toThrow(/unsupported/);
  });

  it("resumes a stored session and refuses an unknown one", async () => {
    const { host } = await started({ resumeSessionId: "fixture-session" });
    await host.send("hello");
    expect(host.state).toBe("waiting_input");
    const failing = new MuseHost({
      config: { ...config },
      cwd: process.cwd(),
      personaPrompt: "PERSONA_AND_FOOTER",
      send: () => {},
      decidePermission: async () => ({ allow: true }),
      executable,
      resumeSessionId: "no-such-session",
    });
    hosts.push(failing);
    await expect(failing.run()).rejects.toThrow(/could not resume/);
  });

  it("serves the kaoiro tools to the agent over HTTP MCP", async () => {
    const toolsFile = join(tmpdir(), `kaoiro-muse-tools-${process.pid}.json`);
    rmSync(toolsFile, { force: true });
    process.env.KAOIRO_TEST_MUSE_TOOLS_FILE = toolsFile;
    try {
      const { host, envelopes } = await started({
        toolDescriptors: [{
          name: "whoami",
          description: "fixture whoami",
          inputSchema: { type: "object", properties: {} },
          handler: async () => ({ content: [{ type: "text", text: "I am the fixture" }] }),
        }],
      });
      await vi.waitFor(() => expect(existsSync(toolsFile)).toBe(true));
      expect(JSON.parse(readFileSync(toolsFile, "utf8"))).toEqual(["whoami"]);
      await host.send("whoami-tool");
      const result = envelopes.find((e) => e.type === "result");
      expect(result?.payload.text).toContain("I am the fixture");
    } finally {
      delete process.env.KAOIRO_TEST_MUSE_TOOLS_FILE;
      rmSync(toolsFile, { force: true });
    }
  });
});
