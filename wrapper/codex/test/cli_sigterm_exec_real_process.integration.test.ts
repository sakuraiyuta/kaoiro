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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync, execSync } from "node:child_process";
import { redactCredentials } from "@kaoiro/agent-common";
import { expect, it, vi } from "vitest";
import { runCodexCli } from "../src/cli.js";
import { clipTail } from "../src/turn_diagnostics.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

const isLinux = process.platform === "linux";
const MAX_DIAGNOSTIC_BYTES = 8192;
const MAX_DIAGNOSTIC_EVENTS = 24;

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

function testProcessSnapshot(rootPid: number): string {
  const all = allProcesses();
  const children = new Map<number, number[]>();
  for (const process of all) {
    if (!children.has(process.ppid)) children.set(process.ppid, []);
    children.get(process.ppid)!.push(process.pid);
  }
  const included = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (included.has(pid)) continue;
    included.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  const snapshot = all.filter((process) => included.has(process.pid));
  if (snapshot.length === 0) return "<test process tree unavailable>";
  return [
    "PID PPID COMMAND",
    ...snapshot.map(
      (process) => `${process.pid} ${process.ppid} ${process.args}`,
    ),
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function filesUnder(
  root: string,
  predicate: (name: string) => boolean,
): string[] {
  try {
    return readdirSync(root, { withFileTypes: true, encoding: "utf8" }).flatMap(
      (entry) => {
        const path = join(root, entry.name);
        if (entry.isDirectory()) return filesUnder(path, predicate);
        return entry.isFile() && predicate(entry.name) ? [path] : [];
      },
    );
  } catch {
    return [];
  }
}

function newestFile(paths: readonly string[]): string | null {
  const candidates = paths.flatMap((path) => {
    try {
      return [{ path, mtimeMs: statSync(path).mtimeMs }];
    } catch {
      return [];
    }
  });
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path ?? null;
}

function eventSummary(value: unknown): Record<string, string | number> {
  if (!isRecord(value)) return { type: "malformed" };
  const summary: Record<string, string | number> = {
    type: stringField(value.type) ?? "malformed",
  };
  for (const key of ["item_type", "status", "error_code"] as const) {
    const field = stringField(value[key]);
    if (field !== undefined) summary[key] = field;
  }
  if (typeof value.exit_code === "number") summary.exit_code = value.exit_code;
  return summary;
}

function traceSummary(home: string): string {
  const trace = newestFile(
    filesUnder(join(home, "turn-traces"), (name) => name.endsWith(".jsonl")),
  );
  if (trace === null)
    return "trace: <none; normal terminal turns are not persisted>";
  try {
    const lines = readFileSync(trace, "utf8").trim().split("\n");
    const parsed: unknown = JSON.parse(lines.at(-1) ?? "");
    if (!isRecord(parsed)) throw new Error("trace root is not an object");
    const child = isRecord(parsed.child)
      ? {
          ...(typeof parsed.child.exitCode === "number"
            ? { exit_code: parsed.child.exitCode }
            : {}),
          ...(stringField(parsed.child.signal) === undefined
            ? {}
            : { signal: stringField(parsed.child.signal) }),
          ...(stringField(parsed.child.stderrTail) === undefined
            ? {}
            : { stderr_tail: stringField(parsed.child.stderrTail) }),
        }
      : null;
    const events = Array.isArray(parsed.stdout_jsonl_tail)
      ? parsed.stdout_jsonl_tail.slice(-MAX_DIAGNOSTIC_EVENTS).map(eventSummary)
      : [];
    const bridgeStderr = stringField(parsed.bridge_stderr_tail) ?? "";
    return [
      `trace: path=${relative(home, trace)}`,
      `outcome=${stringField(parsed.outcome) ?? "unknown"}`,
      `child=${JSON.stringify(child)}`,
      `event_tail=${JSON.stringify(events)}`,
      `bridge_stderr_tail=${bridgeStderr || "<empty>"}`,
    ].join("\n");
  } catch (error) {
    return `trace: unreadable: ${String(error)}`;
  }
}

function rolloutSummary(home: string): string {
  const rollouts = [
    ...filesUnder(
      join(home, "sessions"),
      (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
    ),
    ...filesUnder(
      join(home, ".codex", "sessions"),
      (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
    ),
  ];
  const latest = newestFile(rollouts);
  if (latest === null) return "rollout: files=0";
  try {
    const events = readFileSync(latest, "utf8")
      .trimEnd()
      .split("\n")
      .flatMap((line) => {
        try {
          const entry: unknown = JSON.parse(line);
          const payload =
            isRecord(entry) && isRecord(entry.payload) ? entry.payload : null;
          return [
            eventSummary({
              type: isRecord(entry) ? entry.type : undefined,
              item_type: payload?.type,
              status:
                payload?.status ?? (isRecord(entry) ? entry.status : undefined),
            }),
          ];
        } catch {
          return [{ type: "malformed" }];
        }
      })
      .slice(-MAX_DIAGNOSTIC_EVENTS);
    return `rollout: files=${rollouts.length} latest=${relative(home, latest)} event_tail=${JSON.stringify(events)}`;
  } catch (error) {
    return `rollout: files=${rollouts.length} unreadable: ${String(error)}`;
  }
}

function codexHomeInventory(home: string): string {
  try {
    const sqlite = readdirSync(home)
      .filter((name) => name.endsWith(".sqlite"))
      .sort();
    return `CODEX_HOME sqlite=${JSON.stringify(sqlite)}`;
  } catch (error) {
    return `CODEX_HOME unreadable: ${String(error)}`;
  }
}

function commandSummary(command: string, args: readonly string[]): string {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return `exit=0 stdout=${stdout.trim() || "<empty>"}`;
  } catch (error) {
    const failure = error as {
      status?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    const status =
      typeof failure.status === "number" ? failure.status : "unavailable";
    return `exit=${status} stdout=${String(failure.stdout ?? "").trim() || "<empty>"} stderr=${String(failure.stderr ?? error).trim() || "<empty>"}`;
  }
}

function timeoutDiagnostics(home: string, stderr: string): string {
  let version: string;
  try {
    version = execSync("codex --version", { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch (error) {
    version = `unavailable: ${String(error)}`;
  }
  return redactCredentials(
    `\n${traceSummary(home)}\nhost stderr tail: ${stderr || "<empty>"}\n${rolloutSummary(home)}\n${codexHomeInventory(home)}\ncodex --version: ${version}\nuser namespace probe (not a Codex sandbox verdict): ${commandSummary("unshare", ["-Ur", "true"])}\nps snapshot (test process tree):\n${testProcessSnapshot(process.pid)}`,
  );
}

function captureStderrTail(): { tail: () => string; restore: () => void } {
  let captured = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    captured = clipTail(`${captured}${String(chunk)}`, MAX_DIAGNOSTIC_BYTES);
    return originalWrite.call(process.stderr, chunk, ...(args as never[]));
  }) as typeof process.stderr.write;
  return {
    tail: () => redactCredentials(captured),
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
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
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  diagnostics?: () => string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms${diagnostics?.() ?? ""}`);
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
    let timeoutDiagnosticsCalls = 0;
    let stderrCapture: ReturnType<typeof captureStderrTail> | undefined;
    const describeTimeout = () => {
      timeoutDiagnosticsCalls++;
      return timeoutDiagnostics(
        home,
        stderrCapture?.tail() ?? "<capture unavailable>",
      );
    };
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
      vi.stubEnv("KAOIRO_CODEX_TURN_TRACE_DIR", join(home, "turn-traces"));
      for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(key, undefined);
      stderrCapture = captureStderrTail();

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

      await waitFor(() => (execChildPid = findCodexExecPidOnce(process.pid)) !== null, 15_000, describeTimeout);
      await waitFor(() => (sleepPid = findDescendantByArgs(execChildPid!, "sleep 77")) !== null, 15_000, describeTimeout);
      expect(timeoutDiagnosticsCalls).toBe(0);
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
      stderrCapture?.restore();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await wire.close();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
