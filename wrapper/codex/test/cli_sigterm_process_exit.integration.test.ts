// issue #391 M2: cli_sigterm_exec_real_process.integration.test.ts fires
// `process.emit("SIGTERM")` inside the SAME vitest process and only asserts
// that `runCodexCli()`'s returned promise settles -- that proves close()
// tears down the real codex exec child, but NOT that the wrapper process
// itself ever exits. Node's event loop only empties when every timer/handle
// is gone; a promise resolving is not evidence of that.
//
// This test spawns the REAL wrapper CLI as its own OS process (the built
// `dist/cli.js`, via plain node -- no TypeScript loader needed), backed by
// a real Phoenix-loopback ServerLink (no fake createServerLink) and the
// real `codex exec` binary against an offline Responses loopback provider
// (same shape as the in-process pin), sends that process a real OS
// SIGTERM, and asserts on the child_process `exit` event: `signal === null`
// (Node's own SIGTERM default action never fired) and `code === 0` (the
// process ended by its event loop emptying, not by an explicit
// `process.exit()` call), within the runner's reset grace. It also
// confirms the real codex exec child and its sandboxed grandchild both
// terminate, mirroring the in-process pin's assertions.
//
// Requires `pnpm -C wrapper build` to have run first (dist/cli.js must
// exist) -- consistent with this package's existing bridge_startup tests.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

const isLinux = process.platform === "linux";
const testDir = dirname(fileURLToPath(import.meta.url));
const distCliPath = join(testDir, "..", "dist", "cli.js");

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

function findCodexExecPidOnce(parentPid: number): number | null {
  const direct = allProcesses().filter((p) => p.ppid === parentPid && p.args.includes("codex exec"));
  return direct[0]?.pid ?? null;
}

// issue #391 round2 S2: monotonic, not wall-clock -- a WSL2 clock step (or
// any NTP/VM-suspend adjustment) can move Date.now() by seconds without any
// time actually elapsing, producing both a false timeout here and a false
// pass/fail on the elapsedMs bound below.
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

async function writeRunnerScript(root: string, wireUrl: string): Promise<string> {
  const script = join(root, "runner.mjs");
  await writeFile(
    script,
    `import { runCodexCli } from ${JSON.stringify(distCliPath)};

await runCodexCli({
  parseCliArgs: () => ({ configPath: "fixture", prompt: "run sleep 77 via exec_command", resume: undefined }),
  loadConfig: () => ({
    agent_id: "cli-exec-sigterm-m2",
    persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P",
    server_url: ${JSON.stringify(wireUrl)},
    model: "gpt-5.6-sol",
    codex_backend: "exec",
  }),
});
`,
  );
  return script;
}

it.skipIf(!isLinux || !existsSync(distCliPath))(
  "the spawned wrapper process exits with code 0 and no signal after SIGTERM, and the real exec child + grandchild both terminate (issue #391 M2, Linux-only, requires build)",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ao391-m2-exec-"));
    const wire = await phoenixLoopback();
    let turnCount = 0;
    const provider = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
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
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: `r${n}`, object: "response", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: `r${n}`, object: "response", status: "completed", output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("No provider port");

    await mkdir(home, { recursive: true });
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

    const runnerScript = await writeRunnerScript(home, wire.url);

    const env = { ...process.env, HOME: home, CODEX_HOME: home } as Record<string, string>;
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) delete env[key];

    const child = spawn(process.execPath, [runnerScript], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

    let execChildPid: number | null = null;
    let sleepPid: number | null = null;
    try {
      await waitFor(() => wire.joins >= 1, 10_000);
      wire.push("persona_prompt", { prompt: "test" });
      wire.push("permission_sync", { version: "0", control: null, next: null });

      await waitFor(() => {
        if (child.pid === undefined) return false;
        execChildPid = findCodexExecPidOnce(child.pid);
        return execChildPid !== null;
      }, 15_000);
      await waitFor(() => {
        sleepPid = findDescendantByArgs(execChildPid!, "sleep 77");
        return sleepPid !== null;
      }, 15_000);
      expect(isAlive(execChildPid!), `stderr: ${stderr}`).toBe(true);
      expect(isAlive(sleepPid!), `stderr: ${stderr}`).toBe(true);

      const t0 = performance.now();
      // A real OS signal to a real separate process -- not process.emit().
      child.kill("SIGTERM");
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`wrapper process did not exit within 8000ms; stderr: ${stderr}`)), 8_000);
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, elapsedMs: performance.now() - t0 });
          });
        },
      );
      expect(outcome.signal, `stderr: ${stderr}`).toBeNull();
      expect(outcome.code, `stderr: ${stderr}`).toBe(0);
      expect(outcome.elapsedMs).toBeLessThan(5_000);
      await waitFor(() => !isAlive(execChildPid!) && !isAlive(sleepPid!), 2_000);
    } finally {
      forceKill(execChildPid ?? undefined);
      forceKill(sleepPid ?? undefined);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await wire.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
