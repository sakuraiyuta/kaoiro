import "../../../scripts/test/fixtures/test-isolation.mjs";
import { EventEmitter } from "node:events";
import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHost } from "../src/host.js";
import { runClaudeProbe, type ProbeSpawnDeps } from "../src/probe-client.js";

const result = { ok: true, models: [{ value: "default", display_name: "D" }],
  elapsed_ms: 0 };
const roots: string[] = [];
const errno = (code: string) => Object.assign(new Error(code), { code });
const config = { display_name: "P", agent_id: "probe.test", persona: {
  id: "p", name: "P", sprite_set: "p",
}, server_url: "ws://localhost:4000/wrapper" };

function fake(pid: number | undefined = 9123) {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid, exitCode: null, signalCode: null,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: vi.fn(() => true) });
  let alive = true, cwd: string | undefined;
  const launch = vi.fn((_cmd: string, args: string[], _opts: SpawnOptions) => {
    const index = args.indexOf("--probe-cwd");
    if (index >= 0) { cwd = args[index + 1]; roots.push(cwd!); }
    return child;
  });
  const signal = vi.fn((_pid: number, _signal: unknown) => {
    if (!alive) throw errno("ESRCH");
    return true;
  });
  const diagnostic = vi.fn();
  const deps: ProbeSpawnDeps = { superviseProcessTree: true,
    spawn: launch, groupSignal: signal,
    diagnostic, killEscalateMs: 50 };
  const close = (code = 0) => {
    Object.assign(child, { exitCode: code });
    child.emit("close", code);
  };
  return { child, launch, signal, diagnostic, deps, close,
    cwd: () => cwd, gone: () => { alive = false; },
    success: () => {
      child.stdout!.emit("data", Buffer.from(JSON.stringify(result)));
      close();
    } };
}

afterEach(() => {
  vi.useRealTimers();
  for (const path of roots.splice(0)) rmSync(path, {
    recursive: true, force: true,
  });
});

describe("production-built probe ownership", () => {
  it("keeps runner spawn and parsed outcome unchanged", async () => {
    const f = fake();
    const pending = runClaudeProbe({ ...f.deps,
      superviseProcessTree: false });
    const [, args, options] = f.launch.mock.calls[0]!;
    expect(args).not.toContain("--probe-cwd");
    expect(Object.keys(options).sort()).toEqual(["env", "stdio"]);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.env).not.toHaveProperty("CODEX_HOME");
    f.success();
    expect(await pending).toMatchObject({ ...result,
      elapsed_ms: expect.any(Number) });
    expect(f.signal).not.toHaveBeenCalled();
  });

  it("keeps non-opt-in abort immediate without child close", async () => {
    const f = fake(), controller = new AbortController();
    const pending = runClaudeProbe({ ...f.deps,
      superviseProcessTree: false, signal: controller.signal });
    controller.abort();
    expect((await pending).detail).toBe("aborted");
    expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(f.signal).not.toHaveBeenCalled();
    f.close();
  });

  it("production options isolate and clean opt-in cwd", async () => {
    const f = fake(), pending = runClaudeProbe(f.deps);
    expect(f.launch.mock.calls[0]![2].detached).toBe(true);
    expect(existsSync(f.cwd()!)).toBe(true);
    f.gone(); f.success();
    expect(await pending).toMatchObject({ ...result,
      elapsed_ms: expect.any(Number) });
    expect(existsSync(f.cwd()!)).toBe(false);
  });

  it("already aborted never spawns", async () => {
    const f = fake(), ctl = new AbortController(); ctl.abort();
    await runClaudeProbe({ ...f.deps, signal: ctl.signal });
    expect(f.launch).not.toHaveBeenCalled();
  });

  it.each(["abort", "timeout"])("%s waits past leader close and kills group",
    async (cause) => {
      vi.useFakeTimers();
      const f = fake(), ctl = new AbortController();
      const pending = runClaudeProbe({ ...f.deps,
        signal: ctl.signal, hardTimeoutMs: 10 });
      let done = false; void pending.then(() => { done = true; });
      if (cause === "abort") { ctl.abort(); ctl.abort(); }
      else await vi.advanceTimersByTimeAsync(10);
      f.close();
      await vi.advanceTimersByTimeAsync(50);
      expect(done).toBe(false);
      expect(f.signal).toHaveBeenCalledWith(-9123, "SIGTERM");
      expect(f.signal).toHaveBeenCalledWith(-9123, "SIGKILL");
      f.gone();
      await vi.advanceTimersByTimeAsync(25);
      expect((await pending).reason).toBe("timeout");
      expect(existsSync(f.cwd()!)).toBe(false);
    });

  it("ESRCH before exit falls back only to the held leader", async () => {
    vi.useFakeTimers();
    const f = fake(), ctl = new AbortController(); f.gone();
    const pending = runClaudeProbe({ ...f.deps, signal: ctl.signal });
    ctl.abort();
    expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(50);
    expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
    f.close(); await vi.advanceTimersByTimeAsync(25); await pending;
    expect(f.signal).toHaveBeenCalledTimes(1);
    expect(existsSync(f.cwd()!)).toBe(true);
    expect(f.diagnostic).toHaveBeenCalled();
  });

  it("ESRCH after exit waits for stdio close without signals", async () => {
    vi.useFakeTimers();
    const f = fake(), ctl = new AbortController(); f.gone();
    const pending = runClaudeProbe({ ...f.deps, signal: ctl.signal });
    Object.assign(f.child, { exitCode: 0 }); ctl.abort();
    let done = false; void pending.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(25); expect(done).toBe(false);
    f.close(); await vi.advanceTimersByTimeAsync(25); await pending;
    expect(f.signal).toHaveBeenCalledTimes(1);
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "invalid pid %s never reaches either signal backend", async (pid) => {
      const f = fake(); Object.assign(f.child, { pid });
      const pending = runClaudeProbe(f.deps); f.success(); await pending;
      expect(f.signal).not.toHaveBeenCalled();
      expect(f.child.kill).not.toHaveBeenCalled();
      expect(f.diagnostic).toHaveBeenCalled();
    });

  it.each(["EPERM", "EBUSY"])("%s is not group absence", async (code) => {
    const f = fake(); f.signal.mockImplementation(() => { throw errno(code); });
    const pending = runClaudeProbe(f.deps); f.success();
    expect(await pending).toMatchObject({ ...result,
      elapsed_ms: expect.any(Number) });
    expect(existsSync(f.cwd()!)).toBe(true);
    expect(f.signal).toHaveBeenCalledTimes(1);
    expect(f.diagnostic).toHaveBeenCalled();
  });

  it("post-KILL deadline retains cwd and the parsed catalog", async () => {
    vi.useFakeTimers();
    const f = fake(), pending = runClaudeProbe(f.deps); f.success();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject(result);
    expect(existsSync(f.cwd()!)).toBe(true);
    expect(f.diagnostic).toHaveBeenCalledWith(
      expect.stringContaining("deadline reached"));
  });

  it("spawn failure without a pid removes owned cwd", async () => {
    const f = fake(); Object.assign(f.child, { pid: undefined });
    const pending = runClaudeProbe(f.deps);
    f.child.emit("error", errno("ENOENT")); f.close();
    expect((await pending).reason).toBe("spawn_failed");
    expect(existsSync(f.cwd()!)).toBe(false);
  });

  it("Windows opt-in preserves immediate child-only abort and child cwd",
    async () => {
      const f = fake(), ctl = new AbortController();
      const pending = runClaudeProbe({ ...f.deps, platform: "win32",
        signal: ctl.signal }); ctl.abort();
      expect((await pending).detail).toBe("aborted");
      expect(f.launch.mock.calls[0]![2]).not.toHaveProperty("detached");
      expect(f.cwd()).toBeUndefined();
      expect(f.signal).not.toHaveBeenCalled(); f.close();
    });

  it("unexpected child-signal failure is contained", async () => {
    const f = fake(), ctl = new AbortController(); f.gone();
    vi.mocked(f.child.kill).mockImplementation(() => { throw errno("EIO"); });
    const pending = runClaudeProbe({ ...f.deps, signal: ctl.signal });
    ctl.abort(); f.close();
    await expect(pending).resolves.toMatchObject({ detail: "aborted" });
    expect(f.diagnostic).toHaveBeenCalledWith(
      expect.stringContaining("unexpected failure"));
  });

  it("host close resolves even if cwd removal and diagnostic output throw",
    async () => {
      const f = fake(); f.gone();
      const removeCwd = vi.fn(() => { throw errno("EACCES"); });
      const diagnostic = vi.fn(() => { throw errno("EPIPE"); });
      const host = new AgentHost(config, { onState: () => {},
        probeFn: (deps) =>
        runClaudeProbe({ ...deps, ...f.deps, removeCwd, diagnostic }) });
      const probe = host.probeRateLimits(); await Promise.resolve();
      f.success();
      await expect(host.close()).resolves.toBeUndefined(); await probe;
      expect(removeCwd).toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalled();
    });
});

describe("host probe barrier", () => {
  it("aborts two owners together, waits both and joins repeated settlement",
    async () => {
      const releases: Array<() => void> = [], signals: AbortSignal[] = [];
      const host = new AgentHost(config, { onState: () => {},
        probeFn: (deps) => {
        expect(deps?.superviseProcessTree).toBe(true);
        signals.push(deps!.signal!);
        return new Promise((resolve) => releases.push(() => resolve(result)));
      } });
      const startup = host.probeRateLimits(), manual = host.refreshCatalogFor();
      await Promise.resolve(); await Promise.resolve();
      const closing = host.close();
      expect(host.settleProbes()).toBe(host.settleProbes());
      expect(signals).toHaveLength(2);
      expect(signals.every(signal => signal.aborted)).toBe(true);
      let done = false; void closing.then(() => { done = true; });
      releases[0]!(); await Promise.resolve(); expect(done).toBe(false);
      releases[1]!(); await closing; await Promise.all([startup, manual]);
    });

  it.each([false, true])("terminal abort precedes wait (deferred=%s)",
    async (deferred) => {
      let observed: AbortSignal | undefined;
      const host = new AgentHost(config, { onState: () => {},
        deferQueryUntilFirstInput: deferred,
        queryFn: (() => { throw new Error("SDK failure"); }) as never,
        probeFn: (deps) => new Promise((resolve) => {
          observed = deps!.signal!;
          observed.addEventListener("abort", () => resolve(result));
        }) });
      const probe = host.probeRateLimits(); await Promise.resolve();
      const running = host.run();
      if (deferred) { await host.close(); await running; }
      else await expect(running).rejects.toThrow("SDK failure");
      expect(observed!.aborted).toBe(true); await probe;
    });

  it("probe-only settlement aborts without full close side effects", async () => {
    let signal: AbortSignal | undefined;
    const host = new AgentHost(config, { onState: () => {},
      probeFn: (deps) => new Promise((resolve) => {
        signal = deps!.signal!;
        signal.addEventListener("abort", () => resolve(result));
      }) });
    const probe = host.probeRateLimits(); await Promise.resolve();
    const pending = host.settleProbes();
    expect(signal!.aborted).toBe(true);
    expect(host.closed).toBe(false);
    await pending; await probe;
  });

  it("a rejected probe cannot reject the ignored close barrier", async () => {
    const host = new AgentHost(config, { onState: () => {},
        probeFn: async () => {
      throw new Error("probe failed");
    } });
    const probe = host.probeRateLimits();
    await expect(host.close()).resolves.toBeUndefined(); await probe;
  });
});
