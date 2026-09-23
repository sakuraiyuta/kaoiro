// issue #391 M1/M2: without a handler, Node's default SIGTERM behavior kills
// this process immediately (no close(), no exec child cleanup). This test
// proves the registered handler's FULL effect end to end through the REAL
// `@openai/codex-sdk`/`codex exec` binary (not a fake client): SIGTERM ->
// host.close() -> #abort.abort() -> the real `codex exec` child (and its
// real sandboxed grandchild running a shell command) actually terminate,
// and `runCodexCli()`'s own async lifecycle winds down cleanly afterward
// (no explicit process.exit()).
//
// `process.emit("SIGTERM")` (synthetic, in-process) stands in for a real OS
// signal, mirroring the Claude Code and antigravity SIGTERM pins: it invokes
// the registered listener directly, so it does not re-prove "registering a
// listener suppresses Node's default kill" (settled Node behavior) but DOES
// prove everything this repo's code owns: the handler exists, calls
// close(), and close()'s existing abort() wiring actually kills the real
// exec subprocess tree -- measured at ~50ms in issue #391's offline
// measurement 2, well inside this test's bound.
//
// Loopback Responses provider (offline, no real account usage), same shape
// as `backend_rollback.integration.test.ts` / `cli_app_server_lifecycle.integration.test.ts`.
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { execSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { runCodexCli } from "../src/cli.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

const isLinux = process.platform === "linux";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKill(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone -- fine.
  }
}

function allProcesses(): { pid: number; ppid: number; args: string }[] {
  try {
    return execSync(`ps -eo pid,ppid,args`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim().split("\n").slice(1)
      .map((line) => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! } : null;
      })
      .filter((x): x is { pid: number; ppid: number; args: string } => x !== null);
  } catch {
    return [];
  }
}

function findCodexExecPidOnce(parentPid: number): number | null {
  const direct = allProcesses().filter((p) => p.ppid === parentPid && p.args.includes("codex exec"));
  return direct[0]?.pid ?? null;
}

/** BFS descendants of rootPid whose args contain `needle`. */
function findDescendantByArgs(rootPid: number, needle: string): number | null {
  const all = allProcesses();
  const byPpid = new Map<number, typeof all>();
  for (const p of all) {
    if (!byPpid.has(p.ppid)) byPpid.set(p.ppid, []);
    byPpid.get(p.ppid)!.push(p);
  }
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const child of byPpid.get(cur) ?? []) {
      if (child.args.includes(needle)) return child.pid;
      queue.push(child.pid);
    }
  }
  return null;
}

// issue #391 round2 S2: monotonic, not wall-clock -- a WSL2 clock step (or
// any NTP/VM-suspend adjustment) can move Date.now() by seconds without any
// time actually elapsing, producing a false timeout here.
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

it.skipIf(!isLinux)(
  "SIGTERM triggers close() -> the real codex exec child and its sandboxed grandchild both terminate (issue #391 M1/S2, Linux-only)",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ao391-cli-exec-sigterm-"));
    const wire = await phoenixLoopback();
    let turnCount = 0;
    const provider = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      void body;
      turnCount++;
      const n = turnCount;
      const item =
        n === 1
          ? {
              type: "custom_tool_call", id: `answer-${n}`, call_id: `call-${n}`, name: "exec",
              status: "completed",
              input: "await tools.exec_command({ cmd: 'sleep 77', tty: false });",
            }
          : {
              id: `answer-${n}`, type: "message", role: "assistant", status: "completed",
              phase: "final_answer",
              content: [{ type: "output_text", text: "DONE", annotations: [] }],
            };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: `r${n}`, object: "response", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: `r${n}`, object: "response", status: "completed", output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("No provider port");

    let execChildPid: number | null = null;
    let sleepPid: number | null = null;
    let running: Promise<void> | undefined;
    const signals = process.listeners("SIGTERM");
    try {
      await writeFile(join(home, "config.toml"), `model="gpt-5.6-sol"
model_provider="local"
approval_policy="never"
sandbox_mode="workspace-write"
[model_providers.local]
name="Loopback"
base_url="http://127.0.0.1:${address.port}/v1"
wire_api="responses"
[features]
shell_snapshot=false
plugins=false
[analytics]
enabled=false
`);
      vi.stubEnv("HOME", home);
      vi.stubEnv("CODEX_HOME", home);
      for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(key, undefined);

      const agentId = "cli-exec-sigterm";
      running = runCodexCli({
        parseCliArgs: () => ({ configPath: "fixture", prompt: "run sleep 77 via exec_command", resume: undefined }),
        loadConfig: () => ({
          agent_id: agentId, persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
          server_url: wire.url, model: "gpt-5.6-sol", codex_backend: "exec",
        }),
      });
      void running.catch(() => {});

      await vi.waitFor(() => expect(wire.joins).toBe(1), { timeout: 10_000 });
      wire.push("persona_prompt", { prompt: "test" });
      wire.push("permission_sync", { version: "0", control: null, next: null });

      await waitFor(() => (execChildPid = findCodexExecPidOnce(process.pid)) !== null, 15_000);
      await waitFor(() => (sleepPid = findDescendantByArgs(execChildPid!, "sleep 77")) !== null, 15_000);
      expect(isAlive(execChildPid!)).toBe(true);
      expect(isAlive(sleepPid!)).toBe(true);

      // The SIGTERM handler this test exists to cover is registered on the
      // real `process` object by `runCodexCli` itself -- fire it the same
      // way the OS would deliver the signal, in-process (see file header).
      process.emit("SIGTERM" as never);

      // Measured (issue #391 measurement 2): ~50ms for both the exec parent
      // and its sandboxed grandchild. Bound generously above that.
      await waitFor(() => !isAlive(execChildPid!) && !isAlive(sleepPid!), 10_000);
      // The CLI's own async lifecycle must complete on its own -- no
      // process.exit() needed.
      await running;
    } finally {
      forceKill(execChildPid ?? undefined);
      forceKill(sleepPid ?? undefined);
      for (const listener of process.listeners("SIGTERM")) {
        if (!signals.includes(listener)) process.removeListener("SIGTERM", listener);
      }
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await wire.close();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
