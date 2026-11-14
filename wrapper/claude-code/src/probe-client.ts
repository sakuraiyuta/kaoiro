// Reusable launcher for the short-lived Claude Agent SDK catalog probe
// (ADR-0039 F9 v2, 藤 review). Side-effect-free library: importing this
// module does NOT spawn the probe CLI — call `runClaudeProbe()` explicitly.
// Both the runner (LaunchDialog cache) and the wrapper host itself
// (fresh-idle AgentDetail refresh) share this launcher so the spawn /
// stdout parse / timeout / SIGTERM→SIGKILL cleanup lives in ONE place
// (single source of truth per藤 turn-7 D1b condition).
//
// The probe CLI (src/probe.ts) is the child process that opens the SDK
// Query; this file only owns the launcher.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineCatalogFailReason, EngineModelInfo } from "@kaoiro/protocol";
import { clipUtf16Head, writeRedactedStderr } from "@kaoiro/wrapper-core";

/** Wall-clock cap on the child process itself. Slightly above the probe's own
 *  internal --timeout-ms so a stuck child (e.g. SDK deadlock past its own
 *  timeout) is still reaped by the caller. */
const CHILD_HARD_TIMEOUT_MS = 35_000;

/** Value passed to the probe CLI via --timeout-ms. Matches ADR-0037's SDK
 *  init-timeout profile and phase-20 spike (init observed ~1.4s). */
const PROBE_INTERNAL_TIMEOUT_MS = 30_000;

export interface ProbeUsageWindow {
  utilization: number | null;
  resets_at: string | null;
}
export interface ProbeRateLimits {
  five_hour?: ProbeUsageWindow | null;
  seven_day?: ProbeUsageWindow | null;
}

export interface ProbeOutcome {
  ok: boolean;
  models?: EngineModelInfo[];
  reason?: EngineCatalogFailReason;
  detail?: string;
  elapsed_ms: number;
  /** "init" / "supported_models" mark real probe replies; "cache" marks a
   *  cache-hit or dedup fan-out reply from the runner catalog cache that
   *  must NOT drive updateRegister (see ClaudeCatalogCache). Absent on
   *  wrapper-host probes. */
  source?: "init" | "supported_models" | "cache";
  rate_limits?: ProbeRateLimits;
  commands?: string[];
}

/** Resolve the probe entrypoint against this package's exports. Same
 *  package = the sibling `probe.js` inside `dist/`. */
function resolveProbePath(): string {
  try {
    return fileURLToPath(new URL("./probe.js", import.meta.url));
  } catch (err) {
    throw new Error(
      `cannot resolve @kaoiro/claude-code/dist/probe.js (build the wrapper first?): ${String(err)}`,
    );
  }
}

/** Injection seam so unit tests can drive parse/timeout/kill paths without
 *  actually spawning the probe subprocess. Production uses the real spawn. */
export interface ProbeSpawnDeps {
  spawnProbe?: () => ChildProcess;
  spawn?: (command: string, args: string[],
    options: SpawnOptions) => ChildProcess;
  probePath?: string;
  superviseProcessTree?: boolean;
  platform?: NodeJS.Platform;
  groupSignal?: (pid: number, signal: NodeJS.Signals | 0) => unknown;
  removeCwd?: (cwd: string) => void;
  diagnostic?: (message: string) => void;
  /** Wall-clock cap. Overridable so tests fire timeouts quickly. */
  hardTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killEscalateMs?: number;
  includeUsage?: boolean;
  signal?: AbortSignal;
}

/** Run one short-lived probe. Never throws — a spawn failure or timeout is
 *  returned as an ok=false outcome so callers can package it uniformly. */
export async function runClaudeProbe(
  deps: ProbeSpawnDeps = {},
): Promise<ProbeOutcome> {
  const start = Date.now();
  const hardTimeoutMs = deps.hardTimeoutMs ?? CHILD_HARD_TIMEOUT_MS;
  const killEscalateMs = deps.killEscalateMs ?? 2_000;
  if (deps.signal?.aborted) return { ok: false, reason: "timeout", detail: "aborted", elapsed_ms: Date.now() - start };

  let cwd: string | undefined;
  let child: ChildProcess;
  try {
    const supervised = deps.superviseProcessTree === true &&
      (deps.platform ?? platform()) !== "win32";
    if (supervised) cwd = mkdtempSync(join(tmpdir(), "kaoiro-claude-probe-"));
    if (deps.spawnProbe !== undefined) {
      child = deps.spawnProbe();
    } else {
      const probePath = deps.probePath ?? resolveProbePath();
      const childEnv = { ...process.env };
      delete childEnv.CODEX_HOME;
      child = (deps.spawn ?? spawn)(
        process.execPath,
        [probePath, "--timeout-ms", String(PROBE_INTERNAL_TIMEOUT_MS),
          ...(cwd ? ["--probe-cwd", cwd] : []),
          ...(deps.includeUsage ? ["--usage"] : [])],
        {
          // Preserve the SDK's auth sources without exporting Codex state.
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnv,
          ...(supervised ? { detached: true } : {}),
        },
      );
    }
  } catch (err) {
    if (cwd !== undefined) removeProbeCwd(cwd, deps);
    return {
      ok: false,
      reason: "spawn_failed",
      detail: err instanceof Error ? err.message : String(err),
      elapsed_ms: Date.now() - start,
    };
  }

  const cleanup = cwd === undefined ? undefined : probeCleanup(child, cwd, deps);
  const outcome = await new Promise<ProbeOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let closed = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      deps.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const terminate = (detail: string): void => {
      if (settled) return;
      // Send SIGTERM and start the SIGKILL escalation clock. child.killed
      // is a "kill(sig) was called" flag — NOT proof the child has exited.
      // We track actual exit via the `close` event (closed=true), which is
      // what Node emits when stdio streams flush AND the process is reaped.
      if (cleanup !== undefined) {
        void cleanup();
      } else {
        try {
          child.kill("SIGTERM");
        } catch {}
        const escalate = setTimeout(() => {
          if (!closed) {
            try { child.kill("SIGKILL"); } catch {}
          }
        }, killEscalateMs);
        escalate.unref?.();
      }
      finish({
        ok: false,
        reason: "timeout",
        detail,
        elapsed_ms: Date.now() - start,
      });
    };
    const onAbort = (): void => terminate("aborted");
    const hardTimer = setTimeout(() => terminate("hard timeout"), hardTimeoutMs);
    hardTimer.unref?.();
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    if (deps.signal?.aborted) onAbort();

    child.once("error", (err) => {
      finish({
        ok: false,
        reason: "spawn_failed",
        detail: err.message,
        elapsed_ms: Date.now() - start,
      });
    });

    child.once("close", (code) => {
      closed = true;
      // If a timeout already resolved, we still record that close arrived
      // so any pending escalate skips SIGKILL. But we don't overwrite the
      // caller-visible outcome (settled === true short-circuits).
      const parsed = parseProbeStdout(stdout);
      if (parsed) {
        finish({ ...parsed, elapsed_ms: Date.now() - start });
        return;
      }
      finish({
        ok: false,
        reason: "invalid_output",
        detail:
          `exit=${code ?? "?"} stdout=${clipUtf16Head(stdout, 200)}` +
          (stderr ? ` stderr=${clipUtf16Head(stderr, 200)}` : ""),
        elapsed_ms: Date.now() - start,
      });
    });
  });
  await cleanup?.();
  return outcome;
}

function probeDiagnostic(deps: ProbeSpawnDeps, message: string): void {
  try {
    (deps.diagnostic ?? writeRedactedStderr)(
      `[kaoiro] probe cleanup: ${message}\n`,
    );
  } catch {}
}

function removeProbeCwd(cwd: string, deps: ProbeSpawnDeps): void {
  try {
    (deps.removeCwd ?? ((path) => rmSync(path, {
      recursive: true, force: true,
    })))(cwd);
  } catch {
    probeDiagnostic(deps, "could not remove owned cwd");
  }
}

function probeCleanup(
  child: ChildProcess, cwd: string, deps: ProbeSpawnDeps,
): () => Promise<void> {
  const pid = child.pid;
  const kill = deps.groupSignal ?? process.kill;
  const grace = deps.killEscalateMs ?? 2_000;
  let closed = false, retired = false, unsafe = false, fallback = false;
  let noProcess = false;
  let running: Promise<void> | undefined;
  const onClose = () => { closed = true; };
  child.once("close", onClose);
  const onError = () => { noProcess = pid === undefined; };
  child.once("error", onError);
  const exited = () => closed || child.exitCode != null ||
    child.signalCode != null;
  const valid = () => Number.isSafeInteger(pid) && pid! > 1;
  const direct = (signal: NodeJS.Signals) => {
    if (valid() && !exited()) child.kill(signal);
  };
  const signal = (value: NodeJS.Signals | 0): boolean => {
    if (retired) return false;
    if (!valid()) {
      retired = true;
      if (!noProcess) {
        unsafe = true;
        probeDiagnostic(deps, "invalid process id; owned cwd retained");
      }
      return false;
    }
    try {
      // PGIDs can be reused between a liveness check and a later signal.
      // Never signal again after observing ESRCH; the reuse gap remains.
      kill(-pid!, value);
      return true;
    } catch (error) {
      retired = true;
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        if (!exited()) {
          unsafe = true; fallback = true;
          probeDiagnostic(deps, "group absent before leader exit");
          direct("SIGTERM");
        }
      } else {
        unsafe = true;
        probeDiagnostic(deps, "group signal refused");
      }
      return false;
    }
  };
  const settle = async () => {
    const start = Date.now();
    let escalated = false;
    signal("SIGTERM");
    while (signal(0) || !closed) {
      const elapsed = Date.now() - start;
      if (elapsed >= 2 * grace) {
        unsafe = true;
        probeDiagnostic(deps, "deadline reached; owned cwd retained");
        break;
      }
      if (!escalated && elapsed >= grace) {
        escalated = true;
        if (fallback) direct("SIGKILL");
        else signal("SIGKILL");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!unsafe) removeProbeCwd(cwd, deps);
  };
  // Signal callers may ignore the barrier: cleanup must never reject.
  return () => running ??= settle().catch(() => {
    probeDiagnostic(deps, "unexpected failure; owned cwd retained");
  }).finally(() => {
    child.off("close", onClose);
    child.off("error", onError);
  });
}

/** Parse the probe's single JSON line. Tolerates trailing newlines but not
 *  a truncated payload. Returns null on any parse failure so the caller can
 *  package it as `invalid_output`. Exported for test coverage. */
export function parseProbeStdout(stdout: string): ProbeOutcome | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  // Probe emits one JSON object; multi-line stdout keeps the last line.
  const lastLine = trimmed.split(/\r?\n/).at(-1) ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(lastLine);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.ok === true) {
    const rateLimits = probeRateLimits(r.rate_limits);
    const models = Array.isArray(r.models)
      ? r.models.filter(isEngineModelInfo)
      : [];
    // Defence-in-depth against an empty catalog reaching cache / #models
    // even if the wrapper CLI (which fails loud on 0 models) is bypassed
    // or regresses. `{ok:true, models:[]}` OR every row failing the shape
    // check both drop to invalid_output.
    if (models.length === 0) {
      return {
        ok: false,
        reason: "invalid_output",
        detail: Array.isArray(r.models)
          ? `probe reported ok=true but 0 valid model rows (raw=${r.models.length})`
          : "probe reported ok=true without a models array",
        elapsed_ms: 0,
        ...(rateLimits === undefined ? {} : { rate_limits: rateLimits }),
      };
    }
    const source =
      r.source === "init" || r.source === "supported_models" ? r.source : undefined;
    const commands = Array.isArray(r.commands)
      ? r.commands.filter((c): c is string => typeof c === "string")
      : undefined;
    return {
      ok: true,
      models,
      elapsed_ms: 0,
      ...(source === undefined ? {} : { source }),
      ...(rateLimits === undefined ? {} : { rate_limits: rateLimits }),
      ...(commands !== undefined && commands.length > 0 ? { commands } : {}),
    };
  }
  if (r.ok === false) {
    const rateLimits = probeRateLimits(r.rate_limits);
    const reason = normalizeReason(r.reason);
    return {
      ok: false,
      reason,
      ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
      elapsed_ms: 0,
      ...(rateLimits === undefined ? {} : { rate_limits: rateLimits }),
    };
  }
  return null;
}

function probeRateLimits(value: unknown): ProbeRateLimits | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: ProbeRateLimits = {};
  for (const key of ["five_hour", "seven_day"] as const) {
    const item = raw[key];
    if (item === null) { out[key] = null; continue; }
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const window = item as Record<string, unknown>;
    if ((typeof window.utilization === "number" || window.utilization === null) &&
        (typeof window.resets_at === "string" || window.resets_at === null)) {
      out[key] = { utilization: window.utilization as number | null, resets_at: window.resets_at as string | null };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const REASON_SET: ReadonlySet<EngineCatalogFailReason> = new Set([
  "auth_failed",
  "spawn_failed",
  "cli_error",
  "invalid_output",
  "timeout",
  "unsupported_engine",
]);

function normalizeReason(value: unknown): EngineCatalogFailReason {
  if (typeof value === "string" && (REASON_SET as Set<string>).has(value)) {
    return value as EngineCatalogFailReason;
  }
  return "cli_error";
}

function isEngineModelInfo(value: unknown): value is EngineModelInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.value === "string" && typeof v.display_name === "string";
}
