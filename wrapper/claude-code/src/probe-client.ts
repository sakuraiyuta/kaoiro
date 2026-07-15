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

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { EngineCatalogFailReason, EngineModelInfo } from "@kaoiro/protocol";

/** Wall-clock cap on the child process itself. Slightly above the probe's own
 *  internal --timeout-ms so a stuck child (e.g. SDK deadlock past its own
 *  timeout) is still reaped by the caller. */
const CHILD_HARD_TIMEOUT_MS = 35_000;

/** Value passed to the probe CLI via --timeout-ms. Matches ADR-0037's SDK
 *  init-timeout profile and phase-20 spike (init observed ~1.4s). */
const PROBE_INTERNAL_TIMEOUT_MS = 30_000;

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
}

const require_ = createRequire(import.meta.url);

/** Resolve the probe entrypoint against this package's exports. Same
 *  package = the sibling `probe.js` inside `dist/`. */
function resolveProbePath(): string {
  try {
    return require_.resolve("./probe.js");
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
  /** Wall-clock cap. Overridable so tests fire timeouts quickly. */
  hardTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killEscalateMs?: number;
}

/** Run one short-lived probe. Never throws — a spawn failure or timeout is
 *  returned as an ok=false outcome so callers can package it uniformly. */
export async function runClaudeProbe(
  deps: ProbeSpawnDeps = {},
): Promise<ProbeOutcome> {
  const start = Date.now();
  const hardTimeoutMs = deps.hardTimeoutMs ?? CHILD_HARD_TIMEOUT_MS;
  const killEscalateMs = deps.killEscalateMs ?? 2_000;

  let child: ChildProcess;
  try {
    if (deps.spawnProbe !== undefined) {
      child = deps.spawnProbe();
    } else {
      const probePath = resolveProbePath();
      child = spawn(
        process.execPath,
        [probePath, "--timeout-ms", String(PROBE_INTERNAL_TIMEOUT_MS)],
        {
          // Inherit env so the SDK's auth resolution (keychain / OAuth /
          // ANTHROPIC_API_KEY) still works — same posture as spike.
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    }
  } catch (err) {
    return {
      ok: false,
      reason: "spawn_failed",
      detail: err instanceof Error ? err.message : String(err),
      elapsed_ms: Date.now() - start,
    };
  }

  return new Promise<ProbeOutcome>((resolve) => {
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
      resolve(outcome);
    };

    const hardTimer = setTimeout(() => {
      // Send SIGTERM and start the SIGKILL escalation clock. child.killed
      // is a "kill(sig) was called" flag — NOT proof the child has exited.
      // We track actual exit via the `close` event (closed=true), which is
      // what Node emits when stdio streams flush AND the process is reaped.
      try {
        child.kill("SIGTERM");
      } catch {}
      const escalate = setTimeout(() => {
        if (!closed) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }, killEscalateMs);
      escalate.unref?.();
      finish({
        ok: false,
        reason: "timeout",
        detail: "hard timeout",
        elapsed_ms: Date.now() - start,
      });
    }, hardTimeoutMs);
    hardTimer.unref?.();

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
          `exit=${code ?? "?"} stdout=${stdout.slice(0, 200)}` +
          (stderr ? ` stderr=${stderr.slice(0, 200)}` : ""),
        elapsed_ms: Date.now() - start,
      });
    });
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
      };
    }
    const source =
      r.source === "init" || r.source === "supported_models" ? r.source : undefined;
    return {
      ok: true,
      models,
      elapsed_ms: 0,
      ...(source === undefined ? {} : { source }),
    };
  }
  if (r.ok === false) {
    const reason = normalizeReason(r.reason);
    return {
      ok: false,
      reason,
      ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
      elapsed_ms: 0,
    };
  }
  return null;
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
